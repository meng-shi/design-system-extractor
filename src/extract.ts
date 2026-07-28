/**
 * Shared multi-page extraction service used by both the CLI and local web UI.
 */
import { chromium, type Browser, type Page } from 'playwright';

import { collectInPage, type PageCollection } from './collector.js';
import { type ExportSummary } from './exporter.js';
import { exportDesignSystem } from './writeBundle.js';

const MAX_PAGES_DEFAULT = 4;

export interface ExtractionOptions {
  maxPages?: number;
  outputDir: string;
  onProgress?: (message: string) => void;
}

export interface ExtractionResult {
  title: string;
  sourceUrl: string;
  pageUrls: string[];
  summary: ExportSummary;
}

export function normalizeUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

export function assertSafeUrl(url: string): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs can be extracted.');
  }
  const hostname = parsed.hostname.toLowerCase();
  const privateIpv4 =
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  if (hostname === 'localhost' || hostname === '::1' || privateIpv4) {
    throw new Error('Local and private network URLs cannot be extracted.');
  }
}

/** Ensure lazy-loaded, below-the-fold styles are realized before sampling. */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
}

async function loadAndCollect(page: Page, url: string): Promise<PageCollection | null> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await autoScroll(page);
    return await page.evaluate(collectInPage);
  } catch {
    return null;
  }
}

/** Pick same-origin, content-looking links from the landing page. */
async function discoverLinks(page: Page, origin: string, limit: number): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href),
  );
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const href of hrefs) {
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
      // Ignore malformed links from the source page.
    }
  }
  return picks;
}

function merge(target: PageCollection, source: PageCollection): void {
  target.colors.push(...source.colors);
  target.backgrounds.push(...source.backgrounds);
  target.fonts.push(...source.fonts);
  target.buttons.push(...source.buttons);
  target.motion.push(...source.motion);
  target.shadows.push(...source.shadows);
  target.borders.push(...source.borders);
  target.layout.push(...source.layout);
  target.gradients.push(...source.gradients);
  Object.assign(target.cssVariables, source.cssVariables);
  target.scriptSources.push(...source.scriptSources);
  target.domMarkers.push(...source.domMarkers);
  target.generator ||= source.generator;
}

export async function extractDesignSystem(
  inputUrl: string,
  { maxPages = MAX_PAGES_DEFAULT, outputDir, onProgress }: ExtractionOptions,
): Promise<ExtractionResult> {
  const sourceUrl = normalizeUrl(inputUrl);
  assertSafeUrl(sourceUrl);
  const origin = new URL(sourceUrl).origin;
  const aggregate: PageCollection = {
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
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 DesignSystemExtractor/0.1',
    });
    await context.addInitScript(() => {
      (globalThis as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
    });
    const page = await context.newPage();

    onProgress?.(`Analyzing ${sourceUrl}`);
    const home = await loadAndCollect(page, sourceUrl);
    if (!home) {
      throw new Error('The requested page could not be rendered. It may be unavailable or block automated browsers.');
    }
    aggregate.title = home.title;
    merge(aggregate, home);
    pageUrls.push(sourceUrl);

    const links = await discoverLinks(page, origin, Math.max(0, maxPages - 1));
    for (const link of links) {
      onProgress?.(`Analyzing ${link}`);
      const collection = await loadAndCollect(page, link);
      if (collection) {
        merge(aggregate, collection);
        pageUrls.push(link);
      }
    }
  } finally {
    await browser?.close();
  }

  onProgress?.('Generating design system files');
  const summary = await exportDesignSystem(aggregate, sourceUrl, pageUrls, outputDir);
  return { title: aggregate.title, sourceUrl, pageUrls, summary };
}
