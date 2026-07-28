# Extraction Catalog — What else is worth extracting

Beyond colors/type/spacing, a website exposes a lot about *how it was designed and built*.
This catalogs candidate extractions, ranked by value, with **feasibility per surface**:

- **S** = static edge parse (fetch HTML+CSS, no browser) — Option B
- **R** = rendered/extension (real DOM, computed styles, runtime JS) — Option A/C

Legend: ✅ good · ⚠️ partial/heuristic · ❌ not feasible on that surface

---

## Tier 1 — High value, clearly feasible

### 1. Motion & animation system  ⭐ (your idea)
What: transitions and keyframes as reusable tokens + detected libraries.
- **Design tokens:** `transition-duration`, `timing-function` (easing curves), `transition-delay`,
  `@keyframes` names + steps, common `transform` patterns, `animation` shorthands. Cluster into
  a **motion scale** (e.g. fast 150ms / base 250ms / slow 400ms) and an **easing set**
  (the actual cubic-beziers they use). — S ✅ / R ✅
- **Library detection:** identify the animation stack by fingerprinting:
  - Framer Motion → `data-projection-id`, `style` transforms from `framer` classes, `__framer`
  - GSAP → `window.gsap`, `gsap` in scripts, `_gsap` on elements — R ✅ / S ⚠️ (script src)
  - Lottie → `lottie-web`, `<lottie-player>`, `.json` animation files, `bodymovin`
  - AOS / ScrollReveal / Animate.css → signature class names (`aos-init`, `wow`, `animate__`)
  - Rive, Three.js, anime.js, Motion One → globals + script srcs
- Detected via script URLs + inline class/attribute fingerprints (S ⚠️) and runtime globals
  (R ✅). This is genuinely valuable and not something typical tools give.

### 2. Tech stack / framework fingerprint  ⭐
What: the frameworks and tooling behind the site (a "Wappalyzer-lite" we own).
- Framework: React (`__reactContainer`, `data-reactroot`), Vue (`__vue__`, `data-v-`),
  Svelte (`svelte-` classes), Angular (`ng-`), Next.js (`__NEXT_DATA__`, `/_next/`),
  Nuxt (`__NUXT__`), Astro (`astro-island`), SvelteKit, Remix.
- UI/CSS framework: Tailwind (utility-class density + `--tw-` vars), Bootstrap, MUI
  (`css-*` emotion classes / `Mui` prefixes), Chakra, Ant Design, shadcn/ui, Bulma.
- Fonts/CDN: Google Fonts, Adobe Fonts (Typekit), self-hosted; icon sets (Font Awesome,
  Lucide, Heroicons, Material Icons).
- Analytics/tag managers, CMS (WordPress, Webflow, Framer, Contentful), e-commerce (Shopify).
- Feasibility: S ⚠️ (HTML markers, script srcs, meta generator tag) / R ✅ (runtime globals).
- Output: a `stack.json` with confidence per detection.

### 3. Typography system (deepen what we have)
- Full **type scale** with role inference (h1–h6, body, caption) from size+weight+frequency.
- **Font pairing**: heading font vs body font, and the actual `@font-face` sources
  (self-hosted URLs, formats, weights, `font-display`).
- Fluid typography: detect `clamp()` usage → responsive type ranges. — S ✅ / R ✅

### 4. Layout & grid system
- Container max-widths, common `grid-template-columns`, gap scale, fl-x patterns.
- **Breakpoints**: parse `@media` queries → the site's responsive breakpoint set. — S ✅ / R ✅
- Section rhythm: recurring vertical spacing between blocks. — R ✅ (needs layout)

### 5. Elevation / depth system
- `box-shadow` tokens clustered into an elevation scale (sm/md/lg/xl).
- Blur/backdrop (`backdrop-filter`) usage → "glassmorphism" detection. — S ✅ / R ✅

### 6. Border & shape system
- Border-radius scale, border widths/styles, outline/focus-ring styles. — S ✅ / R ✅

---

## Tier 2 — High value, more heuristic

### 7. Component inventory & specs
Buttons (all variants + states), inputs, cards, badges, links, nav, tabs, modals, tooltips.
- Cluster by structure+style into variants; capture default + `:hover`/`:focus` states.
- **Best on R** (needs computed styles + pseudo-states); S can only see declared rules. — R ✅ / S ⚠️

### 8. Color system semantics (upgrade)
- Infer **semantic roles** (success/warning/error/info) by hue + context (alert/badge classes).
- Derive **tints/shades ramps** (50–900) from the extracted brand hues, even if the site only
  uses a few — useful for the consumer to build a full palette.
- **Gradients**: extract `linear/radial-gradient` stops as reusable gradient tokens.
- **Dark mode**: detect `prefers-color-scheme` / `.dark` variants → export both themes. — S ✅ / R ✅
- Accessibility: compute WCAG **contrast** for text/bg pairs, flag failures. — R ✅ (needs pairs)

### 9. Iconography & imagery style
- Icon set detection + whether icons are stroke vs filled, common stroke-width.
- Image treatment: border-radius on media, aspect ratios, object-fit, common filters.
- Logo + favicon extraction (assets). — S ⚠️ / R ✅

### 10. Interaction & state design
- Focus-visible styles, hover elevation deltas, `cursor` conventions.
- Scroll behavior: `scroll-behavior: smooth`, scroll-snap, sticky headers, parallax markers.
- Loading patterns: skeletons, spinners. — mostly R ✅

### 11. Content & voice (lightweight)
- Reading level, heading style (sentence vs Title Case), CTA phrasing patterns, emoji usage.
- Microcopy inventory (button labels, form hints). — S ✅ / R ✅
- (Optional, AI-assisted summary: "brand voice = confident, concise, technical".)

---

## Tier 3 — Interesting, niche or harder

### 12. Design-tool provenance
- Figma/Sketch/Framer/Webflow signatures in markup, comments, or asset URLs.
- Webflow/Framer sites are often near-1:1 to their design tool. — S ⚠️

### 13. Performance & asset budget (context, not "design")
- Number/size of CSS/JS/fonts, image formats (AVIF/WebP), lazy-loading usage. — S ⚠️ / R ✅

### 14. SEO/social/brand metadata
- OpenGraph/Twitter cards, theme-color, manifest (PWA) colors + icons, brand name/tagline. — S ✅

### 15. Localization & direction
- `lang`, RTL support, locale switchers. — S ✅

### 16. 3D / canvas / WebGL usage
- Detect `<canvas>`, Three.js/react-three-fiber, Spline, shaders → "immersive" flag. — R ✅

---

## Cross-cutting: how we detect libraries (the "what do they use" engine)

Build a small **signature registry** (`signatures.ts`): each entry has a name, category, and
matchers over four evidence sources:

1. **Script/link URLs** (S) — e.g. `gsap`, `framer-motion`, `lottie`, `_next`, `googletagmanager`.
2. **DOM markers** (S) — attributes/classes: `data-framer-*`, `aos-init`, `svelte-`, `Mui*`.
3. **Meta/generator tags** (S) — `<meta name="generator" content="Webflow">`.
4. **Runtime globals** (R) — `window.gsap`, `window.__NEXT_DATA__`, `window.React`.

Each detection carries a **confidence** and the **evidence** that triggered it — same
transparency model as our tokens. Ships as `stack.json` + a "Built with" section in the
Markdown report.

---

## Proposed output additions

Extend the downloadable package with:
- `motion.json` — durations, easings, keyframes, detected animation libraries.
- `stack.json` — frameworks, CSS/UI libraries, fonts, CMS, analytics (with confidence + evidence).
- `layout.json` — breakpoints, container widths, grid/gap scales.
- Expanded `design-system.json` — gradients, shadows/elevation, dark-mode theme, semantic colors.
- Expanded `design-system.md` — new "Motion", "Built with", "Layout & breakpoints",
  "Accessibility notes" sections, all human- + AI-readable.

---

## Recommended build order

1. **Motion system + library detection** (Tier 1.1) — **implemented for the rendered path**:
   observed durations/easings/keyframes plus signatures for Framer Motion, GSAP, Lottie,
   AOS, and Animate.css.
2. **Tech-stack fingerprint** (Tier 1.2) — **initial registry implemented** for Next.js,
   Nuxt, Astro, Svelte, Tailwind, Material UI, Chakra UI, Ant Design, Webflow, WordPress,
   and Framer. Expand signatures as real-site validation identifies gaps.
3. **Breakpoints + elevation + radius scales** (Tier 1.4–1.6) — cheap wins on both surfaces.
4. **Component specs + states** (Tier 2.7) — shines on the extension/rendered path.
5. **Dark mode + gradients + contrast** (Tier 2.8) — rounds out the color story.

Note the surface split guides sequencing: motion/stack/breakpoints work even on the **free
edge (S)** path; component states and contrast are the payoff for the **extension (R)** path —
a natural free-vs-pro feature division.
