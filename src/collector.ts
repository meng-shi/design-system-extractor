/**
 * In-page style collector.
 *
 * This module is stringified and injected into the page via `page.evaluate`,
 * so it must be fully self-contained (no imports, no outer-scope references).
 * It walks every visible element, reads its computed style, and returns a flat
 * list of "samples" weighted by how much visual area the element occupies.
 */

export interface StyleSample {
  /** CSS color string (rgb/rgba) as reported by the browser. */
  value: string;
  /** Visual weight = visible area, so hero/nav styles outrank fine print. */
  weight: number;
}

export interface FontSample {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  weight: number;
}

export interface ButtonSample {
  backgroundColor: string;
  color: string;
  borderColor: string;
  borderRadius: string;
  padding: string;
  fontWeight: number;
  weight: number;
}

export interface MotionSample {
  animationName: string;
  duration: string;
  timingFunction: string;
  delay: string;
  transitionDuration: string;
  transitionTimingFunction: string;
  weight: number;
}

export interface ShadowSample {
  value: string;
  weight: number;
}

export interface BorderSample {
  borderRadius: string;
  borderWidth: string;
  borderStyle: string;
  weight: number;
}

export interface LayoutSample {
  maxWidth: string;
  gap: string;
  padding: string;
  weight: number;
}

export interface GradientSample {
  value: string;
  weight: number;
}

export interface PageCollection {
  colors: StyleSample[];
  backgrounds: StyleSample[];
  fonts: FontSample[];
  buttons: ButtonSample[];
  motion: MotionSample[];
  shadows: ShadowSample[];
  borders: BorderSample[];
  layout: LayoutSample[];
  gradients: GradientSample[];
  cssVariables: Record<string, string>;
  scriptSources: string[];
  domMarkers: string[];
  generator?: string;
  title: string;
}

/**
 * The function actually executed inside the browser. Kept as a plain function
 * (not an arrow bound to module scope) so Playwright can serialize it cleanly.
 */
export function collectInPage(): PageCollection {
  const colors: StyleSample[] = [];
  const backgrounds: StyleSample[] = [];
  const fonts: FontSample[] = [];
  const buttons: ButtonSample[] = [];
  const motion: MotionSample[] = [];
  const shadows: ShadowSample[] = [];
  const borders: BorderSample[] = [];
  const layout: LayoutSample[] = [];
  const gradients: GradientSample[] = [];

  const isTransparent = (c: string) =>
    !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';

  const els = Array.from(document.body.querySelectorAll<HTMLElement>('*'));
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area <= 0) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity) === 0) continue;

    const weight = Math.min(area, 2_000_000); // cap so full-page bgs don't dominate

    if (!isTransparent(style.color)) {
      colors.push({ value: style.color, weight });
    }
    if (!isTransparent(style.backgroundColor)) {
      backgrounds.push({ value: style.backgroundColor, weight });
    }

    const fs = parseFloat(style.fontSize) || 0;
    if (fs > 0 && el.textContent && el.textContent.trim().length > 0) {
      fonts.push({
        fontFamily: style.fontFamily,
        fontSize: fs,
        fontWeight: parseInt(style.fontWeight, 10) || 400,
        weight,
      });
    }

    // Detect buttons / button-like elements.
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const looksLikeButton =
      tag === 'button' ||
      role === 'button' ||
      (tag === 'input' &&
        ['button', 'submit'].includes((el as HTMLInputElement).type)) ||
      (tag === 'a' && /\bbtn\b|\bbutton\b/.test(cls));
    if (looksLikeButton) {
      buttons.push({
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        fontWeight: parseInt(style.fontWeight, 10) || 400,
        weight,
      });
    }

    const hasMotion =
      style.animationName !== 'none' ||
      style.transitionDuration.split(',').some((duration) => parseFloat(duration) > 0);
    if (hasMotion) {
      motion.push({
        animationName: style.animationName,
        duration: style.animationDuration,
        timingFunction: style.animationTimingFunction,
        delay: style.animationDelay,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction,
        weight,
      });
    }

    // Collect shadows
    if (style.boxShadow && style.boxShadow !== 'none') {
      shadows.push({ value: style.boxShadow, weight });
    }

    // Collect border properties
    const borderRadius = style.borderRadius;
    const borderWidth = style.borderWidth;
    const borderStyle = style.borderStyle;
    if (borderRadius && borderRadius !== '0px') {
      borders.push({ borderRadius, borderWidth, borderStyle, weight });
    }

    // Collect gradients
    const bgImage = style.backgroundImage;
    if (bgImage && (bgImage.includes('linear-gradient') || bgImage.includes('radial-gradient'))) {
      gradients.push({ value: bgImage, weight });
    }

    // Collect layout properties for containers
    const display = style.display;
    if (display === 'flex' || display === 'grid') {
      const maxWidth = style.maxWidth;
      const gap = style.gap;
      const padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
      layout.push({ maxWidth, gap, padding, weight });
    }
  }

  // Harvest declared CSS custom properties from :root — these are real,
  // author-defined design tokens and the highest-signal source we have.
  const cssVariables: Record<string, string> = {};
  const rootStyle = window.getComputedStyle(document.documentElement);
  for (let i = 0; i < rootStyle.length; i++) {
    const prop = rootStyle[i];
    if (prop.startsWith('--')) {
      const val = rootStyle.getPropertyValue(prop).trim();
      if (val) cssVariables[prop] = val;
    }
  }

  const scriptSources = Array.from(document.scripts)
    .map((script) => script.src)
    .filter(Boolean);
  const domMarkers = Array.from(document.querySelectorAll<HTMLElement>('[class], [data-framer-name], [data-aos], [data-animation]'))
    .flatMap((element) => [
      ...Array.from(element.classList).filter((name) => /framer|aos|animate__|wow|svelte|Mui|chakra|ant-|gsap|lottie/i.test(name)),
      ...Array.from(element.attributes)
        .filter((attribute) => /^(data-framer|data-aos|data-animation|ng-|_ng)/i.test(attribute.name))
        .map((attribute) => attribute.name),
    ])
    .slice(0, 200);
  const generator = document.querySelector('meta[name="generator"]')?.getAttribute('content') || undefined;

  return {
    colors,
    backgrounds,
    fonts,
    buttons,
    motion,
    shadows,
    borders,
    layout,
    gradients,
    cssVariables,
    scriptSources,
    domMarkers,
    generator,
    title: document.title,
  };
}
