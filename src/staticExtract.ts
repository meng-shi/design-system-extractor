/**
 * Static extractor (Option B): fetch HTML + linked CSS and derive a
 * PageCollection *without a browser*. Lower fidelity than the rendered path
 * (no computed cascade, no runtime globals), but runs on any edge runtime and
 * scales to zero. It reuses the same normalize/export core as everything else.
 */
import postcss, { type Declaration, type Rule } from 'postcss';
import { parse as parseHtml } from 'node-html-parser';

import type { PageCollection } from './collector.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 4_000_000;
const MAX_STYLESHEETS = 12;

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; DesignSystemExtractor/0.2; +https://example.com/bot)',
        Accept: 'text/html,text/css,*/*',
      },
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return null;
    return new TextDecoder().decode(buffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function collectCss(cssText: string, collection: PageCollection): void {
  let root;
  try {
    root = postcss.parse(cssText);
  } catch {
    return;
  }

  root.walkRules((rule: Rule) => {
    const decls: Record<string, string> = {};
    rule.walkDecls((decl: Declaration) => {
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

/** Pick same-origin, content-looking links, mirroring the rendered crawler. */
function pickInternalLinks(links: string[], origin: string, limit: number): string[] {
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
): Promise<StaticExtractionResult> {
  const origin = new URL(sourceUrl).origin;
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
    const html = await fetchText(pageUrl);
    if (!html) return [];
    const parsed = parsePage(html, pageUrl);
    collection.title ||= parsed.title;
    collection.generator ||= parsed.generator;
    collection.scriptSources.push(...parsed.scriptSources);
    collection.domMarkers.push(...parsed.domMarkers);
    for (const css of parsed.inlineStyles) collectCss(css, collection);

    const sheets = parsed.stylesheetHrefs
      .filter((href) => !fetchedStylesheets.has(href))
      .slice(0, MAX_STYLESHEETS);
    for (const href of sheets) {
      fetchedStylesheets.add(href);
      const cssText = await fetchText(href);
      if (cssText) collectCss(cssText, collection);
    }
    pageUrls.push(pageUrl);
    return parsed.links;
  };

  const homeLinks = await ingestPage(sourceUrl);
  if (pageUrls.length === 0) {
    throw new Error('The requested page could not be fetched. It may be unavailable or block automated requests.');
  }

  for (const link of pickInternalLinks(homeLinks, origin, Math.max(0, maxPages - 1))) {
    await ingestPage(link);
  }

  return { collection, pageUrls, title: collection.title };
}
