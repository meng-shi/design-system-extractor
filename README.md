# Design System Extractor

Paste a website URL → get a downloadable, human- and AI-readable **design system**
(colors, typography, spacing, buttons). See [`PLAN.md`](./PLAN.md) for the full plan.

## Status: M2 local web UI

The extractor crawls a few pages, ranks and normalizes their design evidence, then
generates a portable design-system package.

## Run the spike

```bash
npm install            # also downloads the Chromium browser for Playwright
npm run spike -- https://stripe.com
npm run spike -- https://stripe.com --pages 5
npm run spike -- https://stripe.com --pages 5 --output ./output/stripe
```

You should see ranked brand colors, neutrals, text/background colors, the dominant
font stacks, and any declared CSS variables (real author-defined tokens). The generated
output directory contains:

- `design-system.json` — canonical DTCG-compatible design tokens, with confidence and evidence source.
- `design-system.md` — human- and AI-readable palette, typography, component guidance, and usage instructions.
- `tokens.css` — CSS custom properties ready to copy into a project.
- `meta.json` — source URL, pages sampled, timestamp, and raw collection counts.
- `motion.json` — observed durations, easings, keyframes, and animation evidence.
- `stack.json` — framework, UI, CMS, and animation-library detections with evidence.

## Use the web UI

```bash
npm start
```

Open <http://localhost:3000>, paste a public website URL, choose how many pages to sample,
then download the generated files. The UI runs locally; its API launches Playwright on the same
machine because ordinary browser JavaScript cannot inspect the rendered styles of another origin.

## Layout

- `src/collector.ts` — runs **inside the page**; samples computed styles per element,
  weighted by visible area, plus `:root` CSS variables.
- `src/normalize.ts` — Node-side: clusters near-duplicate colors (ΔE) and ranks fonts.
- `src/exporter.ts` — turns normalized evidence into DTCG JSON, Markdown, CSS, and metadata.
- `src/extract.ts` — shared multi-page Playwright extraction service.
- `src/server.ts` — local UI/API server.
- `src/spike.ts` — CLI wrapper for the shared extractor.
- `public/` — no-build browser interface.

The CLI remains available with `npm run spike -- <url>`, but the web UI is the primary local workflow.
