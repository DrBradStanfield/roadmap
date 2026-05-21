import { describe, it, expect } from 'vitest';
import { ensureIsoDatetime } from './recordedAt';
import { BLOOD_TEST_METRICS } from '@roadmap/health-core';

// Regression: BloodTestTimeline's matrix passed the draft batch date to the
// /api/measurements POST as `yyyy-mm-dd`, but the server's Zod schema
// validates `recordedAt` as a full ISO datetime → 400 "Invalid datetime",
// matrix silently cleared the draft. Brad's Lp(a)=10 disappear bug.
// These tests pin down the widening behaviour that fixes it.

describe('ensureIsoDatetime', () => {
  it('widens a date-only `yyyy-mm-dd` to UTC midnight ISO datetime', () => {
    expect(ensureIsoDatetime('2026-05-21')).toBe('2026-05-21T00:00:00.000Z');
  });

  it('passes through a full ISO datetime unchanged', () => {
    const iso = '2026-05-21T13:45:09.123Z';
    expect(ensureIsoDatetime(iso)).toBe(iso);
  });

  it('passes through undefined (legacy path uses server default)', () => {
    expect(ensureIsoDatetime(undefined)).toBeUndefined();
  });

  it('passes through empty string unchanged', () => {
    expect(ensureIsoDatetime('')).toBe('');
  });

  it('does not widen partial or malformed date strings', () => {
    // Already has time component or unusual shape — leave to server to reject.
    expect(ensureIsoDatetime('2026-5-1')).toBe('2026-5-1');
    expect(ensureIsoDatetime('2026/05/21')).toBe('2026/05/21');
  });

  it('produces a datetime the Zod `.datetime()` validator accepts', () => {
    // Mirrors `z.string().datetime()`'s acceptance: needs `T`, time, and `Z`.
    const out = ensureIsoDatetime('2026-05-21')!;
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // Brad's directive: works for *every* blood-test metric. The widening is
  // metric-agnostic (same date string flows in for every metric in a batch),
  // but this guards against anyone refactoring it to be conditional.
  it.each(BLOOD_TEST_METRICS.map(m => [m]))(
    'still widens correctly when the batch is for metric %s',
    (_metric) => {
      expect(ensureIsoDatetime('2026-05-21')).toBe('2026-05-21T00:00:00.000Z');
    },
  );
});
