import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import type { ZipArchive } from 'archiver';

async function createZipArchive(): Promise<ZipArchive> {
  const { ZipArchive: ZipArchiveClass } = await import('archiver');
  return new ZipArchiveClass({ zlib: { level: 9 } });
}

import { assertSafeUrl, extractDesignSystem, normalizeUrl } from './extract.js';
import { extractStatic } from './staticExtract.js';
import { exportDesignSystem } from './writeBundle.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const outputRoot = path.resolve('output', 'web');
const publicRoot = path.resolve('public');
const completedJobs = new Map<string, string>();
const allowedFiles = new Set(['design-system.json', 'design-system.md', 'tokens.css', 'tailwind.preset.js', 'meta.json', 'motion.json', 'stack.json']);

app.use(express.json({ limit: '16kb' }));
app.use(express.static(publicRoot));

app.post('/api/extract', async (request, response) => {
  const { url, pages, method } = request.body as { url?: unknown; pages?: unknown; method?: unknown };
  const pageCount = pages === undefined ? 3 : pages;
  const mode = method === 'static' ? 'static' : 'rendered';
  if (typeof url !== 'string' || url.trim().length === 0) {
    response.status(400).json({ error: 'Enter a website URL.' });
    return;
  }
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 6) {
    response.status(400).json({ error: 'Pages must be an integer from 1 to 6.' });
    return;
  }

  const jobId = randomUUID();
  const outputDir = path.join(outputRoot, jobId);
  try {
    let title: string;
    let sourceUrl: string;
    let pageUrls: string[];
    let tokenCount: number;

    if (mode === 'static') {
      sourceUrl = normalizeUrl(url.trim());
      assertSafeUrl(sourceUrl);
      const result = await extractStatic(sourceUrl, pageCount);
      const summary = await exportDesignSystem(result.collection, sourceUrl, result.pageUrls, outputDir, 'static');
      title = result.title;
      pageUrls = result.pageUrls;
      tokenCount = summary.tokenCount;
    } else {
      const result = await extractDesignSystem(url.trim(), { maxPages: pageCount, outputDir });
      title = result.title;
      sourceUrl = result.sourceUrl;
      pageUrls = result.pageUrls;
      tokenCount = result.summary.tokenCount;
    }

    completedJobs.set(jobId, outputDir);
    const [tokens, metadata, motion, stack] = await Promise.all([
      readFile(path.join(outputDir, 'design-system.json'), 'utf8').then(JSON.parse),
      readFile(path.join(outputDir, 'meta.json'), 'utf8').then(JSON.parse),
      readFile(path.join(outputDir, 'motion.json'), 'utf8').then(JSON.parse),
      readFile(path.join(outputDir, 'stack.json'), 'utf8').then(JSON.parse),
    ]);
    response.json({
      jobId,
      method: mode,
      title,
      sourceUrl,
      pageUrls,
      tokenCount,
      tokens,
      metadata,
      motion,
      stack,
      downloads: Object.fromEntries(
        [...allowedFiles].map((file) => [file, `/api/download/${jobId}/${file}`]),
      ),
      zip: `/api/zip/${jobId}`,
    });
  } catch (error) {
    response.status(422).json({
      error: error instanceof Error ? error.message : 'Extraction failed.',
    });
  }
});

app.get('/api/download/:jobId/:file', (request, response) => {
  const { jobId, file } = request.params;
  const outputDir = completedJobs.get(jobId);
  if (!outputDir || !allowedFiles.has(file)) {
    response.status(404).json({ error: 'Generated file not found.' });
    return;
  }
  response.download(path.join(outputDir, file), file);
});

app.get('/api/zip/:jobId', async (request, response) => {
  const { jobId } = request.params;
  const outputDir = completedJobs.get(jobId);
  if (!outputDir) {
    response.status(404).json({ error: 'Job not found.' });
    return;
  }

  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Disposition', `attachment; filename="design-system-${jobId.slice(0, 8)}.zip"`);

  const archive = await createZipArchive();
  archive.pipe(response);

  for (const file of allowedFiles) {
    try {
      const content = await readFile(path.join(outputDir, file));
      archive.append(content, { name: file });
    } catch {
      // Skip missing files
    }
  }

  archive.finalize();

  await new Promise<void>((resolve, reject) => {
    archive.on('close', () => resolve());
    archive.on('error', (error: Error) => reject(error));
  }).catch((error) => {
    if (!response.headersSent) {
      response.status(500).json({ error: error.message });
    } else {
      response.destroy();
    }
  });
});

app.listen(port, () => {
  console.log(`Design System Extractor is running at http://localhost:${port}`);
});
