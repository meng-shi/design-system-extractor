# Design System Extractor

Paste a website URL → get a downloadable, human- and AI-readable **design system**
(colors, typography, spacing, buttons). See [`PLAN.md`](./PLAN.md) for the full plan.

## Status: M2 local web UI

The extractor crawls a few pages, ranks and normalizes their design evidence, then
generates a portable design-system package.

It can run in two modes:

- **Rendered** (local default): Playwright renders each page. Highest fidelity, needs
  Chromium and ~1–2 GB RAM.
- **Static**: plain HTTP fetch of HTML + CSS, no browser. Lower fidelity, but runs in
  512 MB and is the mode used by the free Render deployment.

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

## Deploy free on Render (static mode)

The repo includes [`render.yaml`](./render.yaml) for a free Render web service. This
deployment runs the **static** extractor (no Chromium), which fits Render's free
512 MB instance. Rendered mode is disabled there.

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint**, select the repo, and apply `render.yaml`.
3. Open the generated `https://<service>.onrender.com` URL.

The blueprint sets:

| Variable | Value | Why |
| --- | --- | --- |
| `STATIC_ONLY` | `1` | Rejects rendered requests and forces static mode |
| `SKIP_PLAYWRIGHT` | `1` | Skips the Chromium download during build |
| `NODE_VERSION` | `22` | Matches local development |
| `MAX_CONCURRENT` | `1` | One extraction at a time on 0.1 CPU |
| `RATE_LIMIT_MAX` | `6` | Max extractions per IP per 10 minutes |

Free-tier notes:

- The service sleeps after 15 minutes idle; the next request takes about a minute to wake.
- 750 instance-hours per month; Render marks free instances as not for production.
- Static extraction cannot see styles generated at runtime by JavaScript.
- Output files are ephemeral; download them promptly after extraction.
- Optional: ping `/healthz` every 10–14 minutes with a free uptime monitor to avoid cold starts.

## Layout

- `src/collector.ts` — runs **inside the page**; samples computed styles per element,
  weighted by visible area, plus `:root` CSS variables.
- `src/normalize.ts` — Node-side: clusters near-duplicate colors (ΔE) and ranks fonts.
- `src/exporter.ts` — turns normalized evidence into DTCG JSON, Markdown, CSS, and metadata.
- `src/extract.ts` — shared multi-page Playwright extraction service.
- `src/staticExtract.ts` — no-browser static HTML/CSS extractor used on Render.
- `src/urlSafety.ts` — SSRF, DNS, and redirect guards for visitor-supplied URLs.
- `src/server.ts` — local UI/API server.
- `src/spike.ts` — CLI wrapper for the shared extractor.
- `public/` — no-build browser interface.

The CLI remains available with `npm run spike -- <url>`, but the web UI is the primary local workflow.
