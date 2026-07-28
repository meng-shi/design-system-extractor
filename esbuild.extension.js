import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const resolvePlugin = {
  name: 'node-modules-resolve',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      try {
        const resolved = require.resolve(args.path);
        return { path: resolved };
      } catch {
        return null;
      }
    });
  },
};

await build({
  entryPoints: ['src/extension/popup.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: 'extension/popup.js',
  plugins: [resolvePlugin],
});
