import { describe, expect, it } from 'vitest';

import { buildMotionProfile, detectStack } from './insights.js';
import type { MotionSample, PageCollection } from './collector.js';

function createMockCollection(overrides: Partial<PageCollection> = {}): PageCollection {
  return {
    colors: [],
    backgrounds: [],
    fonts: [],
    buttons: [],
    motion: [],
    shadows: [],
    borders: [],
    layout: [],
    gradients: [],
    cssVariables: {},
    scriptSources: [],
    domMarkers: [],
    title: 'Test Site',
    ...overrides,
  };
}

describe('buildMotionProfile', () => {
  it('returns motion profile with correct structure', () => {
    const samples: MotionSample[] = [
      {
        animationName: 'fadeIn',
        duration: '0.3s',
        timingFunction: 'ease-in-out',
        delay: '0s',
        transitionDuration: '0.2s',
        transitionTimingFunction: 'ease',
        weight: 100,
      },
    ];
    const result = buildMotionProfile(samples);

    expect(result).toHaveProperty('durations');
    expect(result).toHaveProperty('easings');
    expect(result).toHaveProperty('keyframes');
    expect(result).toHaveProperty('animatedElements');
    expect(result.animatedElements).toBe(1);
  });

  it('ranks durations by frequency', () => {
    const samples: MotionSample[] = [
      { animationName: 'none', duration: '0.3s', timingFunction: 'ease', delay: '0s', transitionDuration: '0.2s', transitionTimingFunction: 'ease', weight: 100 },
      { animationName: 'none', duration: '0.3s', timingFunction: 'ease', delay: '0s', transitionDuration: '0.2s', transitionTimingFunction: 'ease', weight: 100 },
      { animationName: 'none', duration: '0.5s', timingFunction: 'ease', delay: '0s', transitionDuration: '0.1s', transitionTimingFunction: 'ease', weight: 50 },
    ];
    const result = buildMotionProfile(samples);

    expect(result.durations[0].value).toBe('0.3s');
    expect(result.durations[0].samples).toBe(2);
  });

  it('handles empty samples', () => {
    const result = buildMotionProfile([]);
    expect(result.animatedElements).toBe(0);
    expect(result.durations).toEqual([]);
  });
});

describe('detectStack', () => {
  it('detects Next.js from script URLs', () => {
    const collection = createMockCollection({
      scriptSources: ['https://example.com/_next/static/chunk.js'],
    });
    const detections = detectStack(collection);

    expect(detections.some((d) => d.name === 'Next.js')).toBe(true);
  });

  it('detects Tailwind CSS from CSS variables', () => {
    const collection = createMockCollection({
      cssVariables: { '--tw-bg-opacity': '1' },
    });
    const detections = detectStack(collection);

    expect(detections.some((d) => d.name === 'Tailwind CSS')).toBe(true);
  });

  it('detects Framer Motion from DOM markers', () => {
    const collection = createMockCollection({
      domMarkers: ['framer-abc123'],
    });
    const detections = detectStack(collection);

    expect(detections.some((d) => d.name === 'Framer Motion')).toBe(true);
  });

  it('returns empty for no detections', () => {
    const collection = createMockCollection();
    const detections = detectStack(collection);

    expect(detections).toEqual([]);
  });
});
