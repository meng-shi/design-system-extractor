/**
 * Node-side normalization: turn noisy raw samples into a small, ranked token set.
 * The quality of this step is the whole value of the tool, so the spike proves it
 * on real sites before we build any UI.
 */
import { converter, differenceCiede2000, formatHex, parse } from 'culori';

import type { FontSample, StyleSample } from './collector.js';

const toOklab = converter('oklab');
const dE = differenceCiede2000();

export interface RankedColor {
  hex: string;
  weight: number;
  samples: number;
}

/**
 * Cluster near-duplicate colors (anti-aliasing, subtle shade variants) into a
 * handful of representative swatches, ranked by accumulated visual weight.
 */
export function clusterColors(samples: StyleSample[], deltaE = 4): RankedColor[] {
  type Cluster = { rep: string; weight: number; count: number };
  const clusters: Cluster[] = [];

  for (const s of samples) {
    const parsed = parse(s.value);
    if (!parsed) continue;
    const hex = formatHex(parsed);
    if (!hex) continue;

    let placed = false;
    for (const c of clusters) {
      if (dE(hex, c.rep) < deltaE) {
        c.weight += s.weight;
        c.count += 1;
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: hex, weight: s.weight, count: 1 });
  }

  return clusters
    .sort((a, b) => b.weight - a.weight)
    .map((c) => ({ hex: c.rep, weight: Math.round(c.weight), samples: c.count }));
}

export interface RankedFont {
  family: string;
  weight: number;
  sizes: number[];
}

/** Rank font stacks by accumulated visual weight and list the sizes they appear at. */
export function rankFonts(samples: FontSample[]): RankedFont[] {
  const byFamily = new Map<string, { weight: number; sizes: Set<number> }>();
  for (const s of samples) {
    // Use the primary (first) family in the stack as the key.
    const family = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    if (!family) continue;
    const entry = byFamily.get(family) ?? { weight: 0, sizes: new Set<number>() };
    entry.weight += s.weight;
    entry.sizes.add(Math.round(s.fontSize));
    byFamily.set(family, entry);
  }

  return Array.from(byFamily.entries())
    .map(([family, v]) => ({
      family,
      weight: Math.round(v.weight),
      sizes: Array.from(v.sizes).sort((a, b) => a - b),
    }))
    .sort((a, b) => b.weight - a.weight);
}

/** Is a hex color a near-grey (low chroma)? Used to split neutrals from brand colors. */
export function isNeutral(hex: string, chromaThreshold = 0.03): boolean {
  const c = toOklab(hex);
  if (!c) return false;
  return colorChroma(hex) < chromaThreshold;
}

/** Perceptual chroma used to distinguish accent candidates from text-like colors. */
export function colorChroma(hex: string): number {
  const c = toOklab(hex);
  if (!c) return 0;
  return Math.sqrt((c.a ?? 0) ** 2 + (c.b ?? 0) ** 2);
}
