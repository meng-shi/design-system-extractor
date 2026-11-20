/**
 * Static extractor (Option B): fetch HTML + linked CSS and derive a
 * PageCollection *without a browser*. Lower fidelity than the rendered path
 * (no computed cascade, no runtime globals), but runs on any edge runtime and
 * scales to zero. It reuses the same normalize/export core as everything else.
 */
import postcss, { type Declaration, type Rule } from 'postcss';
import { parse as parseHtml } from 'node-html-parser';

import type { PageCollection } from './collector.js';
import { assertSafeUrlResolved } from './urlSafety.js';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_STYLESHEETS = 12;
const MAX_REDIRECTS = 5;
const STYLESHEET_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 45_000;
const MAX_DECLARATIONS = 80_000;

interface JobBudget {
  bytes: number;
  deadline: number;
  declarations: number;
}

function remaining(budget: JobBudget): number {
  return budget.deadline - Date.now();
}

async function fetchText(url: string, budget: JobBudget): Promise<string | null> {
  if (remaining(budget) <= 0 || budget.bytes >= MAX_TOTAL_BYTES) return null;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const timeLeft = remaining(budget);
    if (timeLeft <= 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, timeLeft));
    try {
      await assertSafeUrlResolved(current);
      const response = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; DesignSystemExtractor/0.2; +https://github.com/meng-shi/design-system-extractor)',
          Accept: 'text/html,text/css,*/*',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) return null;

      const declared = Number(response.headers.get('content-length') || 0);
      if (declared && (declared > MAX_BYTES || budget.bytes + declared > MAX_TOTAL_BYTES)) {
        return null;
      }

      let buffer: Uint8Array;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > MAX_BYTES || budget.bytes + received > MAX_TOTAL_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
        buffer = Buffer.concat(chunks);
      } else {
        buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > MAX_BYTES || budget.bytes + buffer.byteLength > MAX_TOTAL_BYTES) {
          return null;
        }
      }

      budget.bytes += buffer.byteLength;
      return new TextDecoder().decode(buffer);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

interface ParsedHtml {
  title: string;
  generator?: string;
  scriptSources: string[];
  domMarkers: string[];
  inlineStyles: string[];
  stylesheetHrefs: string[];
  links: string[];
}

function parsePage(html: string, baseUrl: string): ParsedHtml {
  const root = parseHtml(html);
  const resolve = (href: string): string | null => {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  };

  const scriptSources = root
    .querySelectorAll('script[src]')
    .map((node) => resolve(node.getAttribute('src') || ''))
    .filter((value): value is string => Boolean(value));

  const stylesheetHrefs = root
    .querySelectorAll('link[rel~="stylesheet"][href]')
    .map((node) => resolve(node.getAttribute('href') || ''))
    .filter((value): value is string => Boolean(value));

  const inlineStyles = root.querySelectorAll('style').map((node) => node.textContent || '');

  const domMarkers: string[] = [];
  for (const node of root.querySelectorAll('[class]')) {
    for (const cls of (node.getAttribute('class') || '').split(/\s+/)) {
      if (/framer|aos|animate__|wow|svelte|Mui|chakra|ant-|gsap|lottie/i.test(cls)) {
        domMarkers.push(cls);
      }
    }
    if (domMarkers.length > 200) break;
  }
  for (const node of root.querySelectorAll('[data-framer-name], [data-aos], [data-animation], astro-island')) {
    domMarkers.push(node.rawTagName || 'astro-island');
  }

  const links = root
    .querySelectorAll('a[href]')
    .map((node) => resolve(node.getAttribute('href') || ''))
    .filter((value): value is string => Boolean(value));

  const generator = root
    .querySelector('meta[name="generator"]')
    ?.getAttribute('content') || undefined;

  return {
    title: root.querySelector('title')?.textContent?.trim() || '',
    generator,
    scriptSources,
    domMarkers,
    inlineStyles,
    stylesheetHrefs,
    links,
  };
}

const BUTTON_SELECTOR = /(^|[\s,>])(button|\.btn\b|\[type=["']?(button|submit)["']?\])/i;

function extractColorFromBackground(value: string): string | undefined {
  const match = value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/i);
  return match ? match[0] : undefined;
}

function collectCss(cssText: string, collection: PageCollection, budget: JobBudget): void {
  if (budget.declarations >= MAX_DECLARATIONS) return;
  let root;
  try {
    root = postcss.parse(cssText);
  } catch {
    return;
  }

  root.walkRules((rule: Rule) => {
    if (budget.declarations >= MAX_DECLARATIONS) return;
    const decls: Record<string, string> = {};
    rule.walkDecls((decl: Declaration) => {
      if (budget.declarations >= MAX_DECLARATIONS) return;
      budget.declarations += 1;
      const prop = decl.prop.toLowerCase();
      const value = decl.value.trim();
      decls[prop] = value;

      if (prop.startsWith('--')) {
        collection.cssVariables[decl.prop] = value;
        return;
      }
      if (prop === 'color') {
        collection.colors.push({ value, weight: 1 });
      }
      if (prop === 'background-color' || prop === 'background') {
        const color = prop === 'background' ? extractColorFromBackground(value) : value;
        if (color) collection.backgrounds.push({ value: color, weight: 1 });
      }
      if (prop === 'font-family') {
        collection.fonts.push({
          fontFamily: value,
          fontSize: parseFloat(decls['font-size'] || '') || 16,
          fontWeight: parseInt(decls['font-weight'] || '', 10) || 400,
          weight: 1,
        });
      }
      const hasTransition = prop === 'transition' || prop === 'transition-duration';
      const hasAnimation = prop.startsWith('animation');
      if (hasTransition || hasAnimation) {
        collection.motion.push({
          animationName: decls['animation-name'] || (prop === 'animation' ? value.split(/\s+/)[0] : 'none'),
          duration: decls['animation-duration'] || '',
          timingFunction: decls['animation-timing-function'] || '',
          delay: decls['animation-delay'] || '',
          transitionDuration: decls['transition-duration'] || (prop === 'transition' ? value : ''),
          transitionTimingFunction: decls['transition-timing-function'] || '',
          weight: 1,
        });
      }

      // Collect shadows
      if (prop === 'box-shadow' && value !== 'none') {
        collection.shadows.push({ value, weight: 1 });
      }

      // Collect border properties
      if (prop === 'border-radius' && value !== '0px') {
        collection.borders.push({
          borderRadius: value,
          borderWidth: decls['border-width'] || '1px',
          borderStyle: decls['border-style'] || 'solid',
          weight: 1,
        });
      }

      // Collect gradients
      if (prop === 'background-image' && (value.includes('linear-gradient') || value.includes('radial-gradient'))) {
        collection.gradients.push({ value, weight: 1 });
      }

      // Collect layout properties
      if ((prop === 'max-width' || prop === 'gap') && (decls['display'] === 'flex' || decls['display'] === 'grid')) {
        collection.layout.push({
          maxWidth: decls['max-width'] || '',
          gap: decls['gap'] || '',
          padding: decls['padding'] || '0px',
          weight: 1,
        });
      }
    });

    if (BUTTON_SELECTOR.test(rule.selector)) {
      collection.buttons.push({
        backgroundColor: decls['background-color'] || extractColorFromBackground(decls['background'] || '') || 'transparent',
        color: decls['color'] || 'rgb(0, 0, 0)',
        borderColor: decls['border-color'] || 'rgba(0, 0, 0, 0)',
        borderRadius: decls['border-radius'] || '0px',
        padding: decls['padding'] || '0px',
        fontWeight: parseInt(decls['font-weight'] || '', 10) || 400,
        weight: 1,
      });
    }
  });
}

export interface StaticExtractionResult {
  collection: PageCollection;
  pageUrls: string[];
  title: string;
}

export interface StaticExtractionOptions {
  /** Total time budget for fetching and parsing, in milliseconds. */
  budgetMs?: number;
}

/** Pick same-origin, content-looking links, mirroring the rendered crawler. */
function pickInternalLinks(links: string[], origin: string, limit: number): string[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const href of links) {
    try {
      const target = new URL(href);
      if (target.origin !== origin) continue;
      if (/\.(pdf|zip|png|jpe?g|svg|mp4|dmg|exe)$/i.test(target.pathname)) continue;
      const key = target.origin + target.pathname;
      if (target.pathname === '/' || seen.has(key)) continue;
      seen.add(key);
      picks.push(key);
      if (picks.length >= limit) break;
    } catch {
      // ignore malformed links
    }
  }
  return picks;
}

export async function extractStatic(
  sourceUrl: string,
  maxPages: number,
  onProgress?: (message: string) => void,
  options: StaticExtractionOptions = {},
): Promise<StaticExtractionResult> {
  const origin = new URL(sourceUrl).origin;
  const budget: JobBudget = {
    bytes: 0,
    deadline: Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
    declarations: 0,
  };
  const collection: PageCollection = {
    colors: [],
    backgrounds: [],
    fonts: [],
    buttons: [],
    motion: [],
    shadows: [],
    borders: [],
    layout: [],
    gradients: [],
    cssVariables: {},
    scriptSources: [],
    domMarkers: [],
    title: '',
  };
  const pageUrls: string[] = [];
  const fetchedStylesheets = new Set<string>();

  const ingestPage = async (pageUrl: string): Promise<string[]> => {
    onProgress?.(`Fetching ${pageUrl}`);
    const html = await fetchText(pageUrl, budget);
    if (!html) return [];
    const parsed = parsePage(html, pageUrl);
    collection.title ||= parsed.title;
    collection.generator ||= parsed.generator;
    collection.scriptSources.push(...parsed.scriptSources);
    collection.domMarkers.push(...parsed.domMarkers);
    for (const css of parsed.inlineStyles) collectCss(css, collection, budget);

    const sheets = parsed.stylesheetHrefs
      .filter((href) => !fetchedStylesheets.has(href))
      .slice(0, MAX_STYLESHEETS);
    for (const href of sheets) fetchedStylesheets.add(href);

    await mapLimit(sheets, STYLESHEET_CONCURRENCY, async (href) => {
      const cssText = await fetchText(href, budget);
      if (cssText) collectCss(cssText, collection, budget);
    });

    pageUrls.push(pageUrl);
    return parsed.links;
  };

  const homeLinks = await ingestPage(sourceUrl);
  if (pageUrls.length === 0) {
    throw new Error('The requested page could not be fetched. It may be unavailable or block automated requests.');
  }

  const extraPages = pickInternalLinks(homeLinks, origin, Math.max(0, maxPages - 1));
  for (const link of extraPages) {
    if (remaining(budget) <= 0) break;
    await ingestPage(link);
  }

  return { collection, pageUrls, title: collection.title };
}
