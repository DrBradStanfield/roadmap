// US-07 AC1: the screening reasons and references moved to evidence-screening.ts
// (a no-behaviour split). The exported map must keep every screening entry, at
// the same place in key order, and evidence.ts must not grow its own copy back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUGGESTION_EVIDENCE } from './evidence';
import { SCREENING_EVIDENCE } from './evidence-screening';

/** The screening keys, in order, as they sat in SUGGESTION_EVIDENCE before the split. */
const SCREENING_KEYS = [
  'screening-colorectal',
  'screening-breast',
  'screening-cervical',
  'screening-lung',
  'screening-prostate',
  'screening-prostate-elevated',
  'screening-endometrial-bleeding',
  'screening-endometrial',
  'screening-dexa',
];

describe('screening evidence split (US-07 AC1)', () => {
  const keys = Object.keys(SUGGESTION_EVIDENCE);

  it('every screening- key in the exported map is the evidence-screening.ts entry', () => {
    const screening = keys.filter(k => k.startsWith('screening-'));
    expect(screening).toEqual(SCREENING_KEYS);
    expect(Object.keys(SCREENING_EVIDENCE)).toEqual(SCREENING_KEYS);
    for (const k of SCREENING_KEYS) {
      expect(SUGGESTION_EVIDENCE[k]).toEqual(SCREENING_EVIDENCE[k]);
    }
  });

  it('keeps the screening block in its place: after med-pcsk9i, before supplement-micronutrient-base', () => {
    const start = keys.indexOf('screening-colorectal');
    expect(keys.slice(start - 1, start + SCREENING_KEYS.length + 1)).toEqual([
      'med-pcsk9i',
      ...SCREENING_KEYS,
      'supplement-micronutrient-base',
    ]);
  });

  it('evidence.ts itself declares no screening- key', () => {
    const source = readFileSync(new URL('./evidence.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/['"]screening-/);
  });
});
