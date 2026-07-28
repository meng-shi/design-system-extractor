/**
 * Pure, environment-agnostic design-system builder. Produces every artifact as
 * an in-memory string, so the same code runs on Node, an edge function, and in
 * the browser extension. No filesystem access — see writeBundle.ts for that.
 */
import { converter, formatHex, parse } from 'culori';

import type { ButtonSample, PageCollection } from './collector.js';
import { buildMotionProfile, detectStack, type Detection, type MotionProfile } from './insights.js';
import { clusterColors, colorChroma, isNeutral, rankFonts, type RankedColor } from './normalize.js';

const toOklch = converter('oklch');

type TokenType = 'color' | 'fontFamily' | 'fontWeight' | 'dimension' | 'borderRadius' | 'shadow';

interface Token {
  $type: TokenType;
  $value: string | number;
  $description?: string;
  $extensions?: {
    'design-system-extractor': {
      confidence: number;
      source: 'css-variable' | 'computed-sample';
      samples?: number;
    };
  };
}

interface ExportedTokens {
  $description: string;
  color: Record<string, Token | Record<string, Token>>;
  typography: Record<string, Token | Record<string, Token>>;
  radius: Record<string, Token>;
  shadow: Record<string, Token>;
  layout: Record<string, Token>;
  gradient: Record<string, Token>;
  component: {
    button: Record<string, Record<string, Token>>;
  };
}

export interface ExportSummary {
  outputDir: string;
  tokenCount: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/^--/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'token';
}

function confidence(samples: number, hasVariable: boolean): number {
  if (hasVariable) return 0.95;
  return Math.min(0.9, Math.round((0.45 + Math.log10(samples + 1) * 0.15) * 100) / 100);
}

function makeToken(
  type: TokenType,
  value: string | number,
  description: string,
  samples = 0,
  hasVariable = false,
): Token {
  return {
    $type: type,
    $value: value,
    $description: description,
    $extensions: {
      'design-system-extractor': {
        confidence: confidence(samples, hasVariable),
        source: hasVariable ? 'css-variable' : 'computed-sample',
        ...(samples > 0 ? { samples } : {}),
      },
    },
  };
}

function colorLightness(hex: string): number {
  return toOklch(hex)?.l ?? 0;
}

function findColorVariable(hex: string, variables: Record<string, string>): boolean {
  return Object.entries(variables).some(([name, value]) => {
    if (!/color|bg|brand|primary|text|surface|accent/i.test(name)) return false;
    const parsed = parse(value);
    return parsed ? formatHex(parsed)?.toLowerCase() === hex.toLowerCase() : false;
  });
}

function addColorTokens(
  target: Record<string, Token>,
  colors: RankedColor[],
  prefix: string,
  variables: Record<string, string>,
  description: string,
): void {
  colors.slice(0, 8).forEach((color, index) => {
    const name = `${prefix}-${index + 1}`;
    target[name] = makeToken(
      'color',
      color.hex,
      `${description}; ranked ${index + 1} by visible-area usage.`,
      color.samples,
      findColorVariable(color.hex, variables),
    );
  });
}

function inferSemanticRole(hex: string): string | undefined {
  const c = toOklch(hex);
  if (!c) return undefined;
  const hue = c.h ?? 0;
  const lightness = c.l ?? 0;
  const chroma = c.c ?? 0;

  // Low chroma = neutral, not semantic
  if (chroma < 0.05) return undefined;

  // Green hues (80-160) = success
  if (hue >= 80 && hue <= 160 && lightness > 0.4 && lightness < 0.8) return 'success';
  // Yellow hues (60-80) = warning
  if (hue >= 60 && hue < 80 && lightness > 0.5 && lightness < 0.9) return 'warning';
  // Red hues (0-30 or 330-360) = error
  if ((hue <= 30 || hue >= 330) && lightness > 0.3 && lightness < 0.7) return 'error';
  // Blue hues (200-260) = info
  if (hue >= 200 && hue <= 260 && lightness > 0.4 && lightness < 0.8) return 'info';

  return undefined;
}

function cssColor(value: string): string | undefined {
  if (value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return undefined;
  const parsed = parse(value);
  return parsed ? formatHex(parsed) : undefined;
}

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((start) => {
      const component = parseInt(hex.slice(start, start + 2), 16) / 255;
      return component <= 0.04045
        ? component / 12.92
        : ((component + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function buttonKey(button: ButtonSample): string {
  const bg = cssColor(button.backgroundColor) ?? 'none';
  const fg = cssColor(button.color) ?? 'none';
  const border = cssColor(button.borderColor) ?? 'none';
  return `${bg}|${fg}|${border}`;
}

function classifyButton(
  bg: string | undefined,
  fg: string | undefined,
  border: string | undefined,
): string {
  if (!bg || bg === 'transparent') return 'ghost';
  if (border && bg !== border && contrastRatio(bg, border) < 1.5) return 'outline';
  return 'primary';
}

function buildButtonVariants(buttons: ButtonSample[]): Record<string, Record<string, Token>> {
  const byKey = new Map<string, ButtonSample[]>();
  for (const button of buttons) {
    const key = buttonKey(button);
    const group = byKey.get(key) ?? [];
    group.push(button);
    byKey.set(key, group);
  }

  const groups = [...byKey.entries()]
    .map(([key, group]) => ({
      key,
      group,
      totalWeight: group.reduce((sum, b) => sum + b.weight, 0),
    }))
    .sort((a, b) => b.totalWeight - a.totalWeight)
    .slice(0, 3);

  const variants: Record<string, Record<string, Token>> = {};
  for (let i = 0; i < groups.length; i++) {
    const { group } = groups[i];
    const dominant = group.sort((a, b) => b.weight - a.weight)[0];
    const bg = cssColor(dominant.backgroundColor);
    const fg = cssColor(dominant.color);
    const border = cssColor(dominant.borderColor);
    const radius = dimension(dominant.borderRadius);
    const label = classifyButton(bg, fg, border);

    const properties: Record<string, Token> = {
      'font-weight': makeToken('fontWeight', dominant.fontWeight, `Button variant font weight (${label}).`),
    };
    if (bg) properties.background = makeToken('color', bg, `Button ${label} background.`, group.length);
    if (fg) properties.foreground = makeToken('color', fg, `Button ${label} text color.`, group.length);
    if (border) properties.border = makeToken('color', border, `Button ${label} border color.`, group.length);
    if (radius) properties.radius = makeToken('borderRadius', radius, `Button ${label} radius.`, group.length);
    properties.padding = makeToken('dimension', dominant.padding, `Button ${label} padding.`, group.length);

    variants[label] = properties;
  }

  return variants;
}

function dimension(value: string): string | undefined {
  const match = value.match(/^([\d.]+)px$/);
  return match ? `${Math.round(Number(match[1]))}px` : undefined;
}

function buildTokens(collection: PageCollection): ExportedTokens {
  const allColors = clusterColors([...collection.colors, ...collection.backgrounds]);
  // Low-chroma dark colors are typically body text, not a brand color.
  const brand = allColors.filter((color) => colorChroma(color.hex) >= 0.09);
  const neutrals = allColors
    .filter((color) => isNeutral(color.hex))
    .sort((a, b) => colorLightness(a.hex) - colorLightness(b.hex));
  const text = clusterColors(collection.colors);
  const backgrounds = clusterColors(collection.backgrounds);
  const fonts = rankFonts(collection.fonts);

  const color: ExportedTokens['color'] = {
    brand: {},
    neutral: {},
    text: {},
    surface: {},
    semantic: {},
  };
  addColorTokens(color.brand as Record<string, Token>, brand, 'brand', collection.cssVariables, 'Prominent non-neutral color');
  addColorTokens(color.neutral as Record<string, Token>, neutrals, 'neutral', collection.cssVariables, 'Neutral color');
  addColorTokens(color.text as Record<string, Token>, text, 'text', collection.cssVariables, 'Frequently used text color');
  addColorTokens(color.surface as Record<string, Token>, backgrounds, 'surface', collection.cssVariables, 'Frequently used background color');

  // Detect semantic colors
  const semanticColors = new Map<string, RankedColor>();
  for (const rankedColor of allColors) {
    const role = inferSemanticRole(rankedColor.hex);
    if (role && !semanticColors.has(role)) {
      semanticColors.set(role, rankedColor);
    }
  }
  semanticColors.forEach((rankedColor, role) => {
    (color.semantic as Record<string, Token>)[role] = makeToken(
      'color',
      rankedColor.hex,
      `Inferred ${role} color based on hue and context.`,
      rankedColor.samples,
      findColorVariable(rankedColor.hex, collection.cssVariables),
    );
  });

  const typography: ExportedTokens['typography'] = {};
  fonts.slice(0, 3).forEach((font, index) => {
    typography[`family-${index + 1}`] = makeToken(
      'fontFamily',
      font.family,
      `Font family ranked ${index + 1} by visible text area.`,
    );
    font.sizes.slice(0, 12).forEach((size) => {
      typography[`size-${size}`] = makeToken(
        'dimension',
        `${size}px`,
        `Observed text size in ${font.family}.`,
      );
    });
  });

  // Build radius tokens from borders
  const radii: Record<string, Token> = {};
  const radiusCounts = new Map<string, number>();
  for (const border of collection.borders) {
    const radius = dimension(border.borderRadius);
    if (radius) {
      radiusCounts.set(radius, (radiusCounts.get(radius) ?? 0) + border.weight);
    }
  }
  const sortedRadii = [...radiusCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  sortedRadii.forEach(([radius, count], index) => {
    radii[`radius-${index + 1}`] = makeToken('borderRadius', radius, `Observed border radius ranked ${index + 1}.`, count);
  });

  // Build shadow tokens
  const shadows: Record<string, Token> = {};
  const shadowCounts = new Map<string, number>();
  for (const shadow of collection.shadows) {
    shadowCounts.set(shadow.value, (shadowCounts.get(shadow.value) ?? 0) + shadow.weight);
  }
  const sortedShadows = [...shadowCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  sortedShadows.forEach(([value, count], index) => {
    shadows[`shadow-${index + 1}`] = makeToken('shadow', value, `Observed box-shadow ranked ${index + 1}.`, count);
  });

  // Build layout tokens
  const layout: ExportedTokens['layout'] = {};
  const max_widths = new Map<string, number>();
  const gaps = new Map<string, number>();
  for (const item of collection.layout) {
    if (item.maxWidth && item.maxWidth !== 'none') {
      max_widths.set(item.maxWidth, (max_widths.get(item.maxWidth) ?? 0) + item.weight);
    }
    if (item.gap && item.gap !== '0px') {
      gaps.set(item.gap, (gaps.get(item.gap) ?? 0) + item.weight);
    }
  }
  [...max_widths.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([value, count], index) => {
      layout[`max-width-${index + 1}`] = makeToken('dimension', value, `Observed container max-width ranked ${index + 1}.`, count);
    });
  [...gaps.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([value, count], index) => {
      layout[`gap-${index + 1}`] = makeToken('dimension', value, `Observed gap value ranked ${index + 1}.`, count);
    });

  // Build gradient tokens
  const gradients: Record<string, Token> = {};
  const gradientCounts = new Map<string, number>();
  for (const gradient of collection.gradients) {
    gradientCounts.set(gradient.value, (gradientCounts.get(gradient.value) ?? 0) + gradient.weight);
  }
  [...gradientCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([value, count], index) => {
      gradients[`gradient-${index + 1}`] = makeToken('shadow', value, `Observed gradient ranked ${index + 1}.`, count);
    });

  // Button tokens — cluster into variants
  const buttonTokens = buildButtonVariants(collection.buttons);

  return {
    $description: 'Design tokens extracted from rendered website styles. Values are evidence-based, not a source-of-truth replacement for the original site.',
    color,
    typography,
    radius: radii,
    shadow: shadows,
    layout,
    gradient: gradients,
    component: { button: buttonTokens },
  };
}

function flattenTokens(value: unknown, prefix: string[] = []): Array<{ name: string; token: Token }> {
  if (!value || typeof value !== 'object') return [];
  if ('$value' in value && '$type' in value) {
    return [{ name: prefix.join('-'), token: value as Token }];
  }
  return Object.entries(value).flatMap(([key, child]) => flattenTokens(child, [...prefix, key]));
}

function renderTailwindPreset(tokens: ExportedTokens): string {
  const colors: Record<string, string> = {};
  const fontSize: Record<string, [string, Record<string, string>]> = {};
  const borderRadius: Record<string, string> = {};
  const boxShadow: Record<string, string> = {};
  const spacing: Record<string, string> = {};

  // Extract colors
  for (const group of Object.values(tokens.color)) {
    for (const [name, token] of Object.entries(group)) {
      if (token.$type === 'color' && typeof token.$value === 'string') {
        colors[name] = token.$value;
      }
    }
  }

  // Extract font sizes
  for (const [name, token] of Object.entries(tokens.typography)) {
    if (token.$type === 'dimension' && typeof token.$value === 'string') {
      const size = token.$value;
      fontSize[name] = [size, { lineHeight: '1.5' }];
    }
  }

  // Extract border radius
  for (const [name, token] of Object.entries(tokens.radius)) {
    if (typeof token.$value === 'string') {
      borderRadius[name] = token.$value;
    }
  }

  // Extract box shadows
  for (const [name, token] of Object.entries(tokens.shadow)) {
    if (typeof token.$value === 'string') {
      boxShadow[name] = token.$value;
    }
  }

  // Extract spacing from layout gaps
  for (const [name, token] of Object.entries(tokens.layout)) {
    if (token.$type === 'dimension' && typeof token.$value === 'string' && name.startsWith('gap-')) {
      spacing[name.replace('gap-', '')] = token.$value;
    }
  }

  const config = {
    theme: {
      extend: {
        colors,
        fontSize,
        borderRadius,
        boxShadow,
        spacing,
      },
    },
  };

  return `/** @type {import('tailwindcss').Config} */
// Generated by Design System Extractor
export default ${JSON.stringify(config, null, 2)};
`;
}

function renderCss(tokens: ExportedTokens): string {
  const lines = flattenTokens(tokens)
    .filter(({ token }) => typeof token.$value === 'string' || typeof token.$value === 'number')
    .map(({ name, token }) => {
      const parts = name.split('-').filter((part, index, all) => index === 0 || part !== all[index - 1]);
      return `  --${slugify(parts.join('-'))}: ${token.$value};`;
    });
  return [
    '/* Generated by Design System Extractor. Edit the source token JSON first. */',
    ':root {',
    ...lines,
    '}',
    '',
  ].join('\n');
}

function renderMarkdown(
  sourceUrl: string,
  title: string,
  pageUrls: string[],
  tokens: ExportedTokens,
  motion: MotionProfile,
  detections: Detection[],
): string {
  const colorGroups = Object.entries(tokens.color)
    .map(([group, entries]) => {
      const rows = Object.entries(entries)
        .map(([name, token]) => `| \`${name}\` | \`${token.$value}\` | ${token.$description} |`)
        .join('\n');
      return `### ${group[0].toUpperCase()}${group.slice(1)}\n\n| Token | Value | Guidance |\n|---|---|---|\n${rows || '| None | — | No strong evidence found. |'}`;
    })
    .join('\n\n');
  const fonts = Object.entries(tokens.typography)
    .filter(([, token]) => token.$type === 'fontFamily')
    .map(([name, token]) => `- \`${name}\`: \`${token.$value}\``)
    .join('\n') || '- No dominant font family identified.';
  const buttonSections = Object.entries(tokens.component.button)
    .map(([variant, props]) => {
      const rows = Object.entries(props)
        .map(([name, token]) => `| \`${name}\` | \`${token.$value}\` |`)
        .join('\n') || '| None | — |';
      return `### ${variant[0].toUpperCase()}${variant.slice(1)}\n\n| Property | Value |\n|---|---|\n${rows}`;
    })
    .join('\n\n') || '### Primary\n\n| Property | Value |\n|---|---|\n| None | — |';
  const shadowRows = Object.entries(tokens.shadow)
    .map(([name, token]) => `| \`${name}\` | \`${token.$value}\` | ${token.$description} |`)
    .join('\n') || '| None | — | No shadows detected. |';
  const layoutRows = Object.entries(tokens.layout)
    .map(([name, token]) => `| \`${name}\` | \`${token.$value}\` | ${token.$description} |`)
    .join('\n') || '| None | — | No layout tokens detected. |';
  const gradientRows = Object.entries(tokens.gradient)
    .map(([name, token]) => `| \`${name}\` | \`${token.$value}\` | ${token.$description} |`)
    .join('\n') || '| None | — | No gradients detected. |';
  const motionRows = [
    ['Animated elements', String(motion.animatedElements)],
    ['Observed durations', motion.durations.map((item) => item.value).join(', ') || 'None observed'],
    ['Observed easings', motion.easings.map((item) => item.value).join(', ') || 'None observed'],
    ['Keyframes', motion.keyframes.map((item) => item.value).join(', ') || 'None observed'],
  ].map(([name, value]) => `| ${name} | ${value} |`).join('\n');
  const stackRows = detections
    .map((detection) => `| ${detection.name} | ${detection.category} | ${Math.round(detection.confidence * 100)}% | ${detection.evidence.map((item) => `\`${item.value}\``).join(', ')} |`)
    .join('\n') || '| None | — | — | No signature matched. |';

  return `# ${title || 'Extracted Design System'}

**Source:** ${sourceUrl}  
**Pages sampled:** ${pageUrls.length}  
**Extraction method:** rendered computed styles, weighted by visible area; declared CSS variables are preferred when they match observed values.

## Colors

${colorGroups}

## Typography

${fonts}

## Button Variants

${buttonSections}

## Shadows & Elevation

| Token | Value | Guidance |
|---|---|---|
${shadowRows}

## Layout

| Token | Value | Guidance |
|---|---|---|
${layoutRows}

## Gradients

| Token | Value | Guidance |
|---|---|---|
${gradientRows}

## Motion System

| Signal | Value |
|---|---|
${motionRows}

## Built With

| Detection | Category | Confidence | Evidence |
|---|---|---:|---|
${stackRows}

## How to apply this system

1. Start with \`tokens.css\` for CSS custom properties, or use \`design-system.json\` as the canonical token source.
2. Use \`color-brand-1\` for prominent calls to action only after visually reviewing it; extraction ranks usage, not semantic intent.
3. Use neutral and surface tokens for page backgrounds, borders, and muted content. Preserve contrast requirements when mapping text tokens.
4. Treat tokens with a \`computed-sample\` source as inferred evidence; prefer tokens backed by a \`css-variable\` source when both exist.
5. Use shadow tokens for elevation hierarchy; higher-indexed shadows typically represent deeper elevation.

## AI integration note

Give an AI coding assistant \`design-system.json\` together with this file. Ask it to use existing token names rather than inventing new raw hex values, and to maintain accessible text/background contrast.
`;
}

export interface DesignSystemBundle {
  /** File name → text content. The four downloadable artifacts plus insights. */
  files: Record<string, string>;
  tokens: ExportedTokens;
  motion: MotionProfile;
  stack: { detections: Detection[] };
  metadata: Record<string, unknown>;
  tokenCount: number;
}

/**
 * Pure, environment-agnostic builder. Produces every artifact as an in-memory
 * string so the same code runs on Node, an edge function, and in the browser
 * extension. No filesystem access here.
 */
export function buildDesignSystem(
  collection: PageCollection,
  sourceUrl: string,
  pageUrls: string[],
  method: 'rendered' | 'static' | 'extension' = 'rendered',
): DesignSystemBundle {
  const tokens = buildTokens(collection);
  const motion = buildMotionProfile(collection.motion);
  const stack = { detections: detectStack(collection) };
  const metadata = {
    sourceUrl,
    pageUrls,
    method,
    extractedAt: new Date().toISOString(),
    extractorVersion: '0.3.0',
    samples: {
      colors: collection.colors.length,
      backgrounds: collection.backgrounds.length,
      fonts: collection.fonts.length,
      buttons: collection.buttons.length,
      shadows: collection.shadows.length,
      borders: collection.borders.length,
      layout: collection.layout.length,
      animatedElements: collection.motion.length,
      cssVariables: Object.keys(collection.cssVariables).length,
    },
  };

  const files: Record<string, string> = {
    'design-system.json': `${JSON.stringify(tokens, null, 2)}\n`,
    'design-system.md': renderMarkdown(sourceUrl, collection.title, pageUrls, tokens, motion, stack.detections),
    'tokens.css': renderCss(tokens),
    'tailwind.preset.js': renderTailwindPreset(tokens),
    'meta.json': `${JSON.stringify(metadata, null, 2)}\n`,
    'motion.json': `${JSON.stringify(motion, null, 2)}\n`,
    'stack.json': `${JSON.stringify(stack, null, 2)}\n`,
  };

  return { files, tokens, motion, stack, metadata, tokenCount: flattenTokens(tokens).length };
}
