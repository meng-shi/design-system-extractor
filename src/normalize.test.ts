import { describe, expect, it } from 'vitest';

import { clusterColors, colorChroma, isNeutral, rankFonts } from './normalize.js';
import type { FontSample, StyleSample } from './collector.js';

describe('clusterColors', () => {
  it('clusters near-duplicate colors', () => {
    const samples: StyleSample[] = [
      { value: 'rgb(37, 99, 235)', weight: 100 },
      { value: 'rgb(38, 100, 236)', weight: 50 },
      { value: 'rgb(100, 100, 100)', weight: 80 },
    ];
    const result = clusterColors(samples, 4);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0].weight).toBeGreaterThanOrEqual(result[1]?.weight ?? 0);
  });

  it('returns empty for no samples', () => {
    expect(clusterColors([])).toEqual([]);
  });

  it('handles hex colors', () => {
    const samples: StyleSample[] = [
      { value: '#ff0000', weight: 10 },
      { value: '#ff0001', weight: 10 },
    ];
    const result = clusterColors(samples, 2);
    expect(result.length).toBe(1);
  });
});

describe('rankFonts', () => {
  it('ranks fonts by weight', () => {
    const samples: FontSample[] = [
      { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, weight: 100 },
      { fontFamily: 'Inter', fontSize: 18, fontWeight: 700, weight: 200 },
      { fontFamily: 'Georgia', fontSize: 24, fontWeight: 700, weight: 50 },
    ];
    const result = rankFonts(samples);
    expect(result[0].family).toBe('Inter');
    expect(result[0].weight).toBe(300);
    expect(result[0].sizes).toContain(16);
    expect(result[0].sizes).toContain(18);
  });

  it('returns empty for no samples', () => {
    expect(rankFonts([])).toEqual([]);
  });
});

describe('isNeutral', () => {
  it('identifies grey colors as neutral', () => {
    expect(isNeutral('#808080')).toBe(true);
    expect(isNeutral('#000000')).toBe(true);
    expect(isNeutral('#ffffff')).toBe(true);
  });

  it('identifies saturated colors as non-neutral', () => {
    expect(isNeutral('#ff0000')).toBe(false);
    expect(isNeutral('#00ff00')).toBe(false);
  });
});

describe('colorChroma', () => {
  it('returns high chroma for saturated colors', () => {
    expect(colorChroma('#ff0000')).toBeGreaterThan(0.1);
    expect(colorChroma('#00ff00')).toBeGreaterThan(0.1);
  });

  it('returns low chroma for grey colors', () => {
    expect(colorChroma('#808080')).toBeLessThan(0.05);
  });
});
