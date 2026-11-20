/**
 * Command-line entry point for the shared extraction service.
 *
 *   npm run spike -- https://stripe.com --pages 5
 */
import { extractDesignSystem } from './extract.js';
import { normalizeUrl } from './urlSafety.js';

const MAX_PAGES_DEFAULT = 4;

function parseArgs(argv: string[]): { url: string; maxPages: number; outputDir?: string } {
  const args = argv.slice(2);
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) {
    throw new Error('Usage: npm run spike -- <url> [--pages N] [--output DIRECTORY]');
  }
  const pagesIndex = args.indexOf('--pages');
  const maxPages = pagesIndex >= 0 ? Number(args[pagesIndex + 1]) || MAX_PAGES_DEFAULT : MAX_PAGES_DEFAULT;
  const outputIndex = args.indexOf('--output');
  return { url: normalizeUrl(url), maxPages, outputDir: outputIndex >= 0 ? args[outputIndex + 1] : undefined };
}

async function run(): Promise<void> {
  const { url, maxPages, outputDir } = parseArgs(process.argv);
  const defaultOutputDir = `output/${new URL(url).hostname}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`\nExtracting design system from ${url}\n`);
  const result = await extractDesignSystem(url, {
    maxPages,
    outputDir: outputDir ?? defaultOutputDir,
    onProgress: (message) => console.log(`→ ${message}`),
  });
  console.log(`\nExtracted ${result.summary.tokenCount} tokens from ${result.pageUrls.length} page(s).`);
  console.log(`Output: ${result.summary.outputDir}\n`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
