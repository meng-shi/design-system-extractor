import { describe, expect, it } from 'vitest';

import { buildDesignSystem } from './exporter.js';
import type { PageCollection } from './collector.js';

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

describe('buildDesignSystem', () => {
  it('returns all required files', () => {
    const collection = createMockCollection();
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    expect(result.files).toHaveProperty('design-system.json');
    expect(result.files).toHaveProperty('design-system.md');
    expect(result.files).toHaveProperty('tokens.css');
    expect(result.files).toHaveProperty('meta.json');
    expect(result.files).toHaveProperty('motion.json');
    expect(result.files).toHaveProperty('stack.json');
  });

  it('generates valid JSON for design-system.json', () => {
    const collection = createMockCollection();
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    const tokens = JSON.parse(result.files['design-system.json']);
    expect(tokens).toHaveProperty('$description');
    expect(tokens).toHaveProperty('color');
    expect(tokens).toHaveProperty('typography');
  });

  it('includes metadata in meta.json', () => {
    const collection = createMockCollection();
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    const meta = JSON.parse(result.files['meta.json']);
    expect(meta.sourceUrl).toBe('https://example.com');
    expect(meta.pageUrls).toEqual(['https://example.com']);
    expect(meta.extractorVersion).toBeDefined();
  });

  it('generates markdown with source info', () => {
    const collection = createMockCollection();
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    expect(result.files['design-system.md']).toContain('https://example.com');
    expect(result.files['design-system.md']).toContain('Colors');
    expect(result.files['design-system.md']).toContain('Typography');
  });

  it('generates CSS custom properties', () => {
    const collection = createMockCollection({
      colors: [{ value: 'rgb(37, 99, 235)', weight: 100 }],
    });
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    expect(result.files['tokens.css']).toContain(':root');
  });

  it('tracks token count', () => {
    const collection = createMockCollection();
    const result = buildDesignSystem(collection, 'https://example.com', ['https://example.com']);

    expect(result.tokenCount).toBeGreaterThanOrEqual(0);
  });
});
