/**
 * Node-only writer: build the portable bundle in memory, then persist it to disk.
 * Kept separate from exporter.ts so the exporter stays browser/edge safe.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PageCollection } from './collector.js';
import { buildDesignSystem, type ExportSummary } from './exporter.js';

export async function exportDesignSystem(
  collection: PageCollection,
  sourceUrl: string,
  pageUrls: string[],
  outputDir: string,
  method: 'rendered' | 'static' | 'extension' = 'rendered',
): Promise<ExportSummary> {
  const bundle = buildDesignSystem(collection, sourceUrl, pageUrls, method);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    Object.entries(bundle.files).map(([name, content]) =>
      writeFile(path.join(outputDir, name), content),
    ),
  );
  return { outputDir, tokenCount: bundle.tokenCount };
}
