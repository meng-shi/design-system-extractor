# Design System Extractor — Project Plan

A web tool where a user submits a website URL and gets back a downloadable **design system**
(colors, typography, spacing, buttons, shadows, etc.) that is easy for both **humans and AI**
to read and reapply to their own projects.

---

## 1. Goal & Scope

**In one sentence:** Paste a URL → we crawl the rendered page, extract its visual design
tokens and component styles → we output a clean, portable design-system package the user can
download and hand to a designer, developer, or AI agent.

### What we extract (the "design system")
- **Color palette** — brand/primary, secondary, accent, neutrals, background/surface, text,
  semantic (success/warning/error). Grouped and de-duplicated, with usage frequency.
- **Typography** — font families, weights, sizes, line-heights, letter-spacing, and a derived
  type scale (h1–h6, body, caption).
- **Spacing & layout** — recurring padding/margin/gap values → a spacing scale; container
  widths; common breakpoints.
- **Radii, borders, shadows** — border-radius scale, border widths/colors, box-shadow tokens.
- **Buttons & interactive elements** — primary/secondary/ghost variants: bg, text color,
  padding, radius, border, font-weight, hover state (where detectable).
- **Other components (phase 2)** — inputs, cards, links, badges, nav.
- **Assets (optional)** — logo, favicon, key icons.

### Non-goals (initially)
- Pixel-perfect cloning of the site.
- Full component library / working code for every framework (we start with tokens + a few
  components).
- Sites behind login/paywall or heavy anti-bot protection.

---

## 2. Core Challenge & Approach

CSS on a live site is messy: hundreds of colors from ads, gradients, anti-aliasing, etc.
The value of the tool is **normalization** — turning raw computed styles into a small, sane,
opinionated token set.

**Pipeline:**
```
URL → Render page → Collect computed styles from DOM → Aggregate & rank →
Normalize/cluster → Build tokens → Emit outputs (JSON + Markdown + CSS) → Download
```

Two extraction strategies, used together:
1. **Computed-style sampling (primary):** walk visible DOM elements, read
   `getComputedStyle` for each, tally values weighted by element size/visibility so
   prominent elements matter more than a tiny footer link.
2. **Stylesheet parsing (secondary):** parse CSS files and inline `<style>` for declared
   custom properties (`--color-primary`) and rules — many modern sites already expose real
   design tokens via CSS variables, which are gold.

---

## 3. Architecture

```
┌───────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Frontend │ ──▶ │   API / Backend  │ ──▶ │  Extraction Worker │
│  (form +  │ ◀── │  (queue + store) │ ◀── │  (headless browser)│
│  preview) │     └──────────────────┘     └────────────────────┘
└───────────┘             │                          │
      ▲                   ▼                          ▼
      │            ┌────────────┐          ┌───────────────────┐
      └── download │  Artifacts │ ◀─────── │  Normalizer /      │
        (zip/json) │  storage   │          │  token builder    │
                   └────────────┘          └───────────────────┘
```

### Components
- **Frontend (React/Next.js + Tailwind):** URL input, progress state, results preview
  (swatches, type specimens, button gallery), download buttons.
- **Backend API (Node/TypeScript, e.g. Next.js route handlers or Fastify):**
  `POST /extract` accepts a URL, validates it, enqueues a job, returns a job id;
  `GET /extract/:id` returns status + result; `GET /download/:id` streams the package.
- **Extraction worker (Playwright, headless Chromium):** loads the page, runs an in-page
  script to collect styles, returns raw data. Run as a job (BullMQ + Redis) so slow renders
  don't block requests.
- **Normalizer (pure TS library):** the brain — clustering, scaling, token naming. Kept
  framework-agnostic and unit-tested.
- **Storage:** object storage (S3/local) for generated packages; short-lived cache keyed by
  URL hash to avoid re-crawling.

### Why headless browser (not just fetch HTML)
Most sites are JS-rendered and use computed/cascaded styles. We need a real browser to get
actual rendered colors and fonts, not raw source.

---

## 4. Extraction Details

### 4.1 In-page collection (runs inside Playwright via `page.evaluate`)
For each visible element (skip `display:none`, zero-size, off-screen):
- Record: `color`, `backgroundColor`, `borderColor`, `borderRadius`, `borderWidth`,
  `boxShadow`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`,
  `padding*`, `margin*`, `gap`.
- Weight each value by `boundingRect area × visibility` so hero/nav styles outrank fine print.
- Detect buttons: `<button>`, `[role=button]`, `<a class*=btn>`, submit inputs → capture full
  style set + `:hover` if reachable.
- Also read: `:root` custom properties, `<link rel=stylesheet>` + inline CSS text,
  `document.fonts`, favicon/logo, page title/meta.

### 4.2 Aggregation & normalization
- **Colors:** convert all to a common space (OKLCH/LAB). Cluster near-duplicates
  (ΔE threshold) into representative swatches. Rank by weighted frequency. Classify roles by
  heuristics (most common text color = `text`, dominant large-area bg = `background`, most
  saturated frequent color on buttons/links = `primary`, etc.). Build neutral ramp by
  sorting greys by lightness.
- **Typography:** collect distinct font stacks; pick body vs heading by size/frequency;
  snap sizes to a scale (e.g. nearest of a modular scale) and expose both raw + normalized.
- **Spacing:** histogram of padding/margin/gap; snap to a base grid (detect base unit, often
  4px/8px) → scale tokens `space-0..space-12`.
- **Radii/shadows:** de-dupe and order into scales.
- **Buttons:** merge similar button styles into variants (primary/secondary/ghost) by
  clustering on bg+text+border.

### 4.3 Confidence & transparency
Each token/section carries a `confidence` and `source` (`css-variable` > `computed-sample`)
and a `samples` count, so humans and AI know what's solid vs guessed.

---

## 5. Output Format (human- + AI-friendly)

Deliver a **zip** containing multiple representations of the same data:

1. **`design-system.json`** — canonical machine source, W3C **Design Tokens Community Group**
   format (widely understood by tools + AI):
   ```json
   {
     "color": {
       "primary": { "$value": "#2563EB", "$type": "color",
                    "$extensions": { "confidence": 0.92, "source": "css-variable", "samples": 48 } },
       "neutral": { "100": { "$value": "#F5F5F5", "$type": "color" } }
     },
     "typography": {
       "heading": { "$value": { "fontFamily": "Inter", "fontWeight": 700 }, "$type": "typography" }
     },
     "space": { "4": { "$value": "16px", "$type": "dimension" } }
   }
   ```
2. **`design-system.md`** — the human/AI-readable narrative: palette with swatches (hex + role
   + "use for…"), type scale, spacing, button specs, and a **"How to apply this"** section an
   AI agent can follow. This is the star deliverable for the "easy to understand" requirement.
3. **`tokens.css`** — ready-to-paste CSS custom properties (`:root { --color-primary: … }`).
4. **`tailwind.preset.js`** (optional) — drop-in Tailwind theme extension.
5. **`preview.html`** — self-contained visual proof (swatches, specimens, buttons).
6. **`meta.json`** — source URL, timestamp, tool version, extraction confidence summary.

Using the **standard DTCG token format** means Figma, Style Dictionary, and LLMs already
know how to consume it — that is the key to "easy for human and AI."

---

## 6. Tech Stack (recommended)

| Layer        | Choice                                    | Why |
|--------------|-------------------------------------------|-----|
| Frontend     | Next.js + React + Tailwind                | fast UI, easy previews |
| Backend/API  | Next.js route handlers or Fastify (TS)    | one language end-to-end |
| Rendering    | Playwright (Chromium)                     | reliable rendered styles, `:hover`, fonts |
| Jobs/queue   | BullMQ + Redis                            | handle slow/parallel crawls |
| Color math   | `culori` (OKLCH/ΔE clustering)            | robust color normalization |
| Token output | DTCG format + Style Dictionary (optional) | standard, multi-target export |
| Storage      | S3-compatible (or local disk in MVP)      | store downloadable packages |
| Deploy       | Browser worker on a container host (Fly/Render/Railway); Vercel is fine for UI/API but not for Playwright |

> Note: Playwright needs a real container, not a typical serverless function. Split UI/API
> (serverless-ok) from the browser worker (container).

---

## 7. Milestones

**M0 — Spike (1–2 days).** Playwright script that opens one URL and dumps top colors + fonts
to console. Prove the core idea.

**M1 — MVP extractor (complete).** In-page collector + normalizer for colors and typography.
CLI emits `design-system.json` (DTCG), `design-system.md`, `tokens.css`, and `meta.json`.

**M2 — Local web app (complete).** URL form, page-count choice, results preview, and
individual artifact downloads. The UI and Playwright API run together on the user's machine.

**M3 — Buttons & components (3–5 days).** Button variant clustering + `:hover`, add
`tokens.css` and `preview.html` outputs.

**M4 — Polish & robustness (ongoing).** CSS-variable harvesting, confidence scoring,
Tailwind preset, caching, error handling for bot-blocked/slow sites, rate limiting.

**M5 (stretch).** Figma export, more components (inputs/cards/nav), side-by-side compare of
two sites, accessibility/contrast report.

---

## 8. Risks & Mitigations
- **Noisy CSS → ugly palettes.** Mitigate with area-weighting, ΔE clustering, and preferring
  declared CSS variables.
- **Anti-bot / Cloudflare blocks.** Realistic user-agent, retries, clear error to user; never
  bypass hard blocks.
- **JS-heavy / lazy content.** Wait for network idle, scroll to trigger lazy styles.
- **Legal/ethical.** Extract *styles/tokens*, not proprietary assets or content; respect
  robots where appropriate; add a disclaimer that output is for inspiration/reference.
- **Playwright hosting cost.** Cache by URL hash; queue + concurrency limits.

---

## 9. Open Questions (decide before building)
1. ~~One-page extraction, or crawl a few key pages?~~ **DECIDED: crawl a few key pages**
   (home + a handful of same-origin links) and aggregate across them for better coverage.
2. Anonymous instant use, or accounts + saved history?
3. How opinionated should normalization be (raw values vs strongly snapped scales)?
4. Which export targets matter most first — CSS vars, Tailwind, or Figma?
5. Any target frameworks for generated component code beyond tokens?

---

## 10. Suggested First Step
Build **M0**: a ~100-line Playwright + `culori` script that prints the top 8 colors and the
font stacks for a given URL. It validates the hardest part (normalization quality) before we
invest in UI and infrastructure.
