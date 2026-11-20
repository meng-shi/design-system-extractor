import { spawnSync } from 'node:child_process';

const skip =
  process.env.SKIP_PLAYWRIGHT === '1' ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1';

if (skip) {
  console.log('Skipping Playwright browser download (SKIP_PLAYWRIGHT=1).');
  process.exit(0);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not install Chromium: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
