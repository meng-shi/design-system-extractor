/**
 * Evidence-based motion and technology detection. A signature is only reported
 * with the concrete source that matched it, so consumers can audit every claim.
 */
import type { MotionSample, PageCollection } from './collector.js';

type EvidenceKind = 'script-url' | 'dom-marker' | 'meta-generator' | 'css-variable';

export interface Detection {
  name: string;
  category: 'framework' | 'animation' | 'ui' | 'cms' | 'font';
  confidence: number;
  evidence: Array<{ kind: EvidenceKind; value: string }>;
}

interface Signature {
  name: Detection['name'];
  category: Detection['category'];
  patterns: Array<{ kind: EvidenceKind; expression: RegExp }>;
}

const signatures: Signature[] = [
  { name: 'Next.js', category: 'framework', patterns: [{ kind: 'script-url', expression: /\/_next\//i }] },
  { name: 'Nuxt', category: 'framework', patterns: [{ kind: 'script-url', expression: /\/_nuxt\//i }] },
  { name: 'Astro', category: 'framework', patterns: [{ kind: 'dom-marker', expression: /astro-island/i }] },
  { name: 'Svelte', category: 'framework', patterns: [{ kind: 'dom-marker', expression: /svelte/i }] },
  { name: 'Framer Motion', category: 'animation', patterns: [{ kind: 'dom-marker', expression: /framer/i }, { kind: 'script-url', expression: /framer-motion/i }] },
  { name: 'GSAP', category: 'animation', patterns: [{ kind: 'script-url', expression: /gsap/i }, { kind: 'dom-marker', expression: /gsap/i }] },
  { name: 'Lottie', category: 'animation', patterns: [{ kind: 'script-url', expression: /lottie|bodymovin/i }, { kind: 'dom-marker', expression: /lottie/i }] },
  { name: 'AOS', category: 'animation', patterns: [{ kind: 'dom-marker', expression: /aos/i }, { kind: 'script-url', expression: /\baos\b/i }] },
  { name: 'Animate.css', category: 'animation', patterns: [{ kind: 'dom-marker', expression: /animate__/i }, { kind: 'script-url', expression: /animate\.min\.css|animate\.css/i }] },
  { name: 'Tailwind CSS', category: 'ui', patterns: [{ kind: 'css-variable', expression: /^--tw-/i }] },
  { name: 'Material UI', category: 'ui', patterns: [{ kind: 'dom-marker', expression: /^Mui/i }] },
  { name: 'Chakra UI', category: 'ui', patterns: [{ kind: 'dom-marker', expression: /chakra/i }] },
  { name: 'Ant Design', category: 'ui', patterns: [{ kind: 'dom-marker', expression: /^ant-/i }] },
  { name: 'Webflow', category: 'cms', patterns: [{ kind: 'meta-generator', expression: /webflow/i }] },
  { name: 'WordPress', category: 'cms', patterns: [{ kind: 'meta-generator', expression: /wordpress/i }] },
  { name: 'Framer', category: 'cms', patterns: [{ kind: 'meta-generator', expression: /framer/i }, { kind: 'dom-marker', expression: /framer/i }] },
];

function evidenceSources(collection: PageCollection): Array<{ kind: EvidenceKind; value: string }> {
  return [
    ...collection.scriptSources.map((value) => ({ kind: 'script-url' as const, value })),
    ...collection.domMarkers.map((value) => ({ kind: 'dom-marker' as const, value })),
    ...Object.keys(collection.cssVariables).map((value) => ({ kind: 'css-variable' as const, value })),
    ...(collection.generator ? [{ kind: 'meta-generator' as const, value: collection.generator }] : []),
  ];
}

export function detectStack(collection: PageCollection): Detection[] {
  const sources = evidenceSources(collection);
  return signatures.flatMap((signature) => {
    const evidence = signature.patterns.flatMap((pattern) =>
      sources
        .filter((source) => source.kind === pattern.kind && pattern.expression.test(source.value))
        .slice(0, 3),
    );
    if (evidence.length === 0) return [];
    return [{
      name: signature.name,
      category: signature.category,
      confidence: Math.min(0.95, 0.65 + (evidence.length - 1) * 0.15),
      evidence,
    }];
  });
}

export interface MotionProfile {
  durations: Array<{ value: string; samples: number }>;
  easings: Array<{ value: string; samples: number }>;
  keyframes: Array<{ value: string; samples: number }>;
  animatedElements: number;
}

/** Split CSS comma lists without splitting commas inside cubic-bezier() and similar functions. */
function splitCssList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth = Math.max(0, depth - 1);
    if (value[index] === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function rank(values: string[]): Array<{ value: string; samples: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value || value === 'none' || value === '0s') continue;
    for (const item of splitCssList(value)) {
      if (item && item !== 'none' && item !== '0s') counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, samples]) => ({ value, samples }))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 12);
}

export function buildMotionProfile(samples: MotionSample[]): MotionProfile {
  return {
    durations: rank(samples.flatMap((sample) => [sample.duration, sample.transitionDuration])),
    easings: rank(samples.flatMap((sample) => [sample.timingFunction, sample.transitionTimingFunction])),
    keyframes: rank(samples.map((sample) => sample.animationName)),
    animatedElements: samples.length,
  };
}
