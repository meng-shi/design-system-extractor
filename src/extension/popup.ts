/**
 * Popup logic for the browser extension (Option A — the true "edge device").
 * It injects the shared `collectInPage` into the active tab, then runs the exact
 * same pure core (`buildDesignSystem`) that the server and edge function use.
 * Nothing is sent anywhere — files are generated and downloaded locally.
 */
import { collectInPage } from '../collector.js';
import { buildDesignSystem } from '../exporter.js';

// Minimal ambient typing so we don't need @types/chrome for a few APIs.
declare const chrome: {
  tabs: { query(q: { active: true; currentWindow: true }): Promise<Array<{ id?: number; url?: string; title?: string }>> };
  scripting: { executeScript<T>(o: { target: { tabId: number }; func: () => T }): Promise<Array<{ result: T }>> };
  downloads: { download(o: { url: string; filename: string; saveAs?: boolean }): Promise<number> };
};

const button = document.querySelector<HTMLButtonElement>('#extract')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const summary = document.querySelector<HTMLDivElement>('#summary')!;
const swatches = document.querySelector<HTMLDivElement>('#swatches')!;
const downloads = document.querySelector<HTMLDivElement>('#downloads')!;

function triggerDownload(name: string, content: string): void {
  const blob = new Blob([content], { type: name.endsWith('.json') ? 'application/json' : 'text/plain' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `design-system/${name}` }).finally(() => {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Reading this page…';
  summary.style.display = 'none';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');

    const [{ result: collection }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectInPage,
    });

    const bundle = buildDesignSystem(collection, tab.url || '', [tab.url || ''], 'extension');

    const brand = Object.values(bundle.tokens.color.brand).slice(0, 5);
    swatches.innerHTML = brand
      .map((token) => `<i style="background:${token.$value}" title="${token.$value}"></i>`)
      .join('') || '<span style="font-size:.72rem;color:#66715d">No brand colors found</span>';
    document.querySelector('#stat-tokens')!.textContent = String(bundle.tokenCount);
    document.querySelector('#stat-motion')!.textContent = String(bundle.motion.animatedElements);
    document.querySelector('#stat-stack')!.textContent =
      bundle.stack.detections.map((d) => d.name).join(', ') || 'No signatures';

    downloads.innerHTML = '';
    for (const name of Object.keys(bundle.files)) {
      const item = document.createElement('button');
      item.textContent = name;
      item.addEventListener('click', () => triggerDownload(name, bundle.files[name]));
      downloads.appendChild(item);
    }
    const all = document.createElement('button');
    all.className = 'all';
    all.textContent = 'Download all files';
    all.addEventListener('click', () => {
      for (const [name, content] of Object.entries(bundle.files)) triggerDownload(name, content);
    });
    downloads.appendChild(all);

    summary.style.display = 'block';
    status.textContent = `Extracted ${bundle.tokenCount} tokens from this page.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Extraction failed.';
  } finally {
    button.disabled = false;
  }
});
