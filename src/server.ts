import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import type { ZipArchive } from 'archiver';

async function createZipArchive(): Promise<ZipArchive> {
  const { ZipArchive: ZipArchiveClass } = await import('archiver');
  return new ZipArchiveClass({ zlib: { level: 9 } });
}

import { extractStatic } from './staticExtract.js';
import { assertSafeUrlResolved, normalizeUrl } from './urlSafety.js';
import { exportDesignSystem } from './writeBundle.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const outputRoot = path.resolve('output', 'web');
const publicRoot = path.resolve('public');
const completedJobs = new Map<string, string>();
const allowedFiles = new Set(['design-system.json', 'design-system.md', 'tokens.css', 'tailwind.preset.js', 'meta.json', 'motion.json', 'stack.json']);

const STATIC_ONLY = process.env.STATIC_ONLY === '1';
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 1);
const JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.JOB_TIMEOUT_MS) || 60_000);
const STATIC_BUDGET_MS = Math.max(5_000, Number(process.env.STATIC_BUDGET_MS) || 45_000);
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = Math.max(1, Number(process.env.RATE_LIMIT_MAX) || 6);
const JOB_TTL_MS = 60 * 60_000;
const MAX_TRACKED_JOBS = 50;

const rateBuckets = new Map<string, number[]>();
let activeExtractions = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(publicRoot, { maxAge: '1h' }));

function rateLimit(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const key = request.ip || 'unknown';
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    response.setHeader('Retry-After', String(Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000)));
    response.status(429).json({ error: 'Too many extractions. Please wait a few minutes and try again.' });
    return;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  next();
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Extraction timed out. Try fewer pages.')), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rememberJob(jobId: string, outputDir: string): void {
  completedJobs.set(jobId, outputDir);
  while (completedJobs.size > MAX_TRACKED_JOBS) {
    const oldest = completedJobs.keys().next().value;
    if (!oldest) break;
    completedJobs.delete(oldest);
  }
}

async function cleanupOutput(): Promise<void> {
  let entries;
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  const tracked = new Set(completedJobs.values());
  for (const entry of entries) {
    const target = path.join(outputRoot, entry.name);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs > JOB_TTL_MS) {
        await rm(target, { recursive: true, force: true });
        if (tracked.has(target)) {
          for (const [jobId, dir] of completedJobs) {
            if (dir === target) completedJobs.delete(jobId);
          }
        }
      }
    } catch {
      // Ignore files that disappear mid-cleanup.
    }
  }
  const cutoff = now - RATE_WINDOW_MS;
  for (const [key, timestamps] of rateBuckets) {
    const recent = timestamps.filter((timestamp) => timestamp >= cutoff);
    if (recent.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, recent);
  }
}

app.get('/healthz', (_request, response) => {
  response.json({ ok: true, staticOnly: STATIC_ONLY, activeExtractions, uptime: process.uptime() });
});

app.get('/api/config', (_request, response) => {
  response.json({ staticOnly: STATIC_ONLY, maxPages: 6 });
});

app.post('/api/extract', rateLimit, async (request, response) => {
  const { url, pages, method } = request.body as { url?: unknown; pages?: unknown; method?: unknown };
  const pageCount = pages === undefined ? 3 : pages;
  const requestedMode = method === 'static' ? 'static' : method === 'rendered' ? 'rendered' : undefined;

  if (typeof url !== 'string' || url.trim().length === 0) {
    response.status(400).json({ error: 'Enter a website URL.' });
    return;
  }
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 6) {
    response.status(400).json({ error: 'Pages must be an integer from 1 to 6.' });
    return;
  }
  if (STATIC_ONLY && requestedMode === 'rendered') {
    response.status(400).json({ error: 'Rendered mode is disabled on this deployment. Use static mode.' });
    return;
  }
  if (activeExtractions >= MAX_CONCURRENT) {
    response.setHeader('Retry-After', '15');
    response.status(503).json({ error: 'The extractor is busy. Please try again in a few seconds.' });
    return;
  }

  const mode = STATIC_ONLY ? 'static' : (requestedMode ?? 'rendered');
  const jobId = randomUUID();
  const outputDir = path.join(outputRoot, jobId);

  activeExtractions += 1;
  try {
    const sourceUrl = normalizeUrl(url);
    await assertSafeUrlResolved(sourceUrl);

    let title: string;
    let pageUrls: string[];
    let tokenCount: number;

    if (mode === 'static') {
      const result = await withTimeout(
        extractStatic(sourceUrl, pageCount, undefined, { budgetMs: STATIC_BUDGET_MS }),
        JOB_TIMEOUT_MS,
      );
      const summary = await exportDesignSystem(result.collection, sourceUrl, result.pageUrls, outputDir, 'static');
      title = result.title;
      pageUrls = result.pageUrls;
      tokenCount = summary.tokenCount;
    } else {
      const { extractDesignSystem } = await import('./extract.js');
      const result = await withTimeout(
        extractDesignSystem(sourceUrl, { maxPages: pageCount, outputDir }),
        JOB_TIMEOUT_MS,
      );
      title = result.title;
      pageUrls = result.pageUrls;
      tokenCount = result.summary.tokenCount;
    }

    rememberJob(jobId, outputDir);
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
    const message = error instanceof Error ? error.message : 'Extraction failed.';
    const status = message === 'Extraction timed out. Try fewer pages.' ? 504 : 422;
    response.status(status).json({ error: message });
  } finally {
    activeExtractions -= 1;
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

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'Not found.' });
});

async function start(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const cleanupTimer = setInterval(() => {
    void cleanupOutput();
  }, 15 * 60_000);
  cleanupTimer.unref();

  const server = app.listen(port, () => {
    console.log(`Design System Extractor is running at http://localhost:${port} (staticOnly=${STATIC_ONLY})`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void start();
