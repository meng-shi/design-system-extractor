# Publication Plan — Extractor without your own crawler

Goal: publish the tool for public use **without operating or babysitting a headless-browser
crawler**, ideally running "on the edge."

---

## 0. The hard constraint (read first)

A website visitor's browser **cannot** read the rendered styles of an *arbitrary third-party*
site:

- `fetch('https://othersite.com')` from the browser is blocked by CORS for most sites.
- A cross-origin `<iframe>` renders the site, but `getComputedStyle` on its contents throws
  a security error. You cannot inspect it.

**Therefore a pure "paste any URL, extract 100% in the visitor's browser, zero server" web
app is not possible for arbitrary sites.** Anyone claiming otherwise is either using a
server/proxy, a browser extension, or a third-party rendering API.

So "everything on the edge device" is achievable **only** if the code runs *on the page
itself* (a browser extension / bookmarklet on the user's own machine). If you want the
paste-a-URL website UX, something server-side (yours or a vendor's) must fetch the target.

Good news: we can avoid running our **own crawler** in every option below, and reuse our
existing pure-TS `normalize.ts` + `exporter.ts` unchanged.

---

## Option A — Browser extension / bookmarklet (true "edge device", zero backend) ⭐

The user installs an extension (or drags a bookmarklet). They visit any site and click it.
A **content script runs inside that page**, so same-origin rules don't apply — it gets full
`getComputedStyle` access, better than our current server crawler.

```
User's browser (the edge device)
  └─ content script: collector.ts logic → normalize.ts → exporter.ts → download files
```

- **No server, no crawler, no hosting cost.** Everything runs on the user's machine.
- Highest fidelity: real computed styles, hover states, fonts, CSS variables.
- Multi-page: extension can read the current tab, or open/scan a few internal links.
- **Distribution:** Chrome Web Store + Firefox Add-ons (one-time review). Bookmarklet needs
  no store but is more limited by CSP on some sites.
- **Tradeoff:** user must visit the site and click, instead of pasting a URL into a web app.
  This is the price of "no server."

**Reuse:** `collector.ts`, `normalize.ts`, `exporter.ts` all move client-side almost as-is.

---

## Option B — Edge function, static CSS fetch (no headless browser at all) ⭐

Skip the browser entirely. A tiny **edge function** (Cloudflare Workers / Vercel Edge)
does a plain `fetch` of the target's HTML, then fetches its linked `.css` files and inline
`<style>`, and **parses the CSS text** for colors, fonts, radii, spacing, and — crucially —
declared CSS variables (`--color-primary`). No Playwright, nothing to keep alive.

```
Public web UI (paste URL)
  └─ Edge Function: fetch HTML + CSS → parse with a CSS parser → normalize.ts → exporter.ts
```

- Keeps the **paste-a-URL web app UX**.
- **Fully serverless / edge**, scales to zero, near-zero cost, no crawler process to run.
- We already proved CSS variables are gold (Stripe exposed ~1,780 real tokens).
- **Tradeoff:** no JS-rendered styles, no computed cascade, weaker per-element weighting and
  button/hover detection. Quality is "good," not "great," and varies by site.
- Server does `fetch` on behalf of users, so it still needs **SSRF protection** (block
  private/loopback/metadata IPs, re-check redirects) and rate limiting — but this is far
  lighter than running Chromium.

**Reuse:** `normalize.ts` + `exporter.ts` unchanged; replace `collector.ts` (DOM sampling)
with a `cssParser.ts` (static parse, e.g. `postcss` + `culori`).

---

## Option C — Managed browser API (rendered fidelity, still no crawler you run)

Keep the current rendered-DOM approach, but call a **hosted browser** instead of your own:
Cloudflare Browser Rendering (runs on their edge), Browserless, Browserbase, ScrapingBee,
or Urlbox. Your edge function sends them the URL + our `collectInPage` script; they return
the samples.

- Full computed-style fidelity **without you operating Chromium.**
- Cloudflare Browser Rendering is the most "edge" of these.
- **Tradeoff:** per-render cost, a vendor dependency, and usage limits. Not free.

---

## Recommendation

Ship **two surfaces that share the same core**:

1. **Primary public web app = Option B** (edge function + static CSS parse). Serverless,
   cheap, keeps the paste-a-URL UX, no crawler. Good default quality via CSS variables.
2. **"Pro" high-fidelity path = Option A** (browser extension). For users who want the best
   result on a specific site, they run it on the device. Zero backend.
3. Optional upgrade later = **Option C** as a paid "high-accuracy" toggle in the web app when
   the static parse is thin.

This gives a free, edge-hosted product with no crawler to maintain, plus a device-side
option that is literally "everything on the edge device."

```
                 ┌───────────────── Public web app (paste URL) ─────────────────┐
   Visitor  ───▶ │  Edge Function (Cloudflare/Vercel): fetch HTML+CSS → parse    │
                 │  → normalize.ts → exporter.ts → return tokens + downloads      │
                 └───────────────────────────────────────────────────────────────┘
   Visitor  ───▶ Browser extension (on device): collector.ts → normalize.ts → exporter.ts
                 (no server involved at all)
```

---

## What we reuse (already built, framework-agnostic)

- `src/normalize.ts` — color clustering, neutrals split, font ranking. **No change.**
- `src/exporter.ts` — DTCG JSON + Markdown + CSS + meta. **No change** (make file writes vs.
  in-memory buffers pluggable so it works in the browser and on the edge).
- `src/collector.ts` — reused directly by the **extension**; replaced by a CSS parser for the
  **edge function**.

---

## Milestones

**P1 — Refactor core for portability (2–3 days).**
Make `exporter.ts` return in-memory strings (not only disk writes) so it runs in a Worker and
in the browser. Split "produce files" from "write files."

**P2 — Edge function extractor (1 week).**
`cssParser.ts` using `postcss` + `culori`: fetch HTML, resolve + fetch stylesheets, collect
declared values and CSS variables, feed `normalize.ts`. Add SSRF guard + rate limiting.
Deploy the existing `public/` UI as static assets on the same platform.

**P3 — Browser extension (1 week).**
Manifest V3 extension wrapping `collector.ts` + core. Popup with "Extract this page" and a
"scan N internal pages" option; download the four files locally. Submit to Chrome/Firefox
stores.

**P4 — Quality toggle + polish (ongoing).**
Optional Option C (managed browser) as a "high-accuracy" mode; ZIP download; artifact expiry;
usage quotas; a clear "site blocked / thin result" message.

---

## Honest quality expectation

- Extension (Option A): **best** — real rendered styles.
- Managed browser (Option C): **best**, paid.
- Static edge parse (Option B): **good when the site ships CSS variables or static CSS,
  weaker for heavily JS-generated styles.** Acceptable as the free default, and the two other
  paths cover the gap.
