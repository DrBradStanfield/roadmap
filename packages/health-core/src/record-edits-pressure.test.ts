/**
 * US-02 AC8: a day's active systolic is always above its active diastolic.
 * Diastolic at or above systolic cannot be measured; it is almost always a
 * swapped entry, and the plan would compute from it. Every writer comes here:
 * the iPhone's pair, the web's cells, the CLI and the connector, the bulk
 * import, and a device import.
 */
import { describe, it, expect } from 'vitest';
import { appendMeasurement, bulkAppendValues, correctValue, placeMeasurement, PRESSURE_ORDER_HALF } from './record-edits';
import { PRESSURE_ORDER } from './validation';
import { importDeviceSamples } from './device-import';
import { calculateHealthResults } from './calculations';
import { mergeFiles } from './merge';
import { computePlan } from './plan';
import { validateHealthInputs } from './validation';
import type { HealthInputs } from './types';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-30T09:00:00Z';
const DAY = '2026-10-20';

function withRows(...rows: Array<[string, string, number, string?]>): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'us02_ac8', now: NOW });
  for (const [id, metricType, value, day = DAY] of rows) {
    file.measurements.push(createMeasurement({ id, metricType, value, recordedAt: day, createdAt: '2026-10-20T08:00:00Z' }));
  }
  return file;
}

const refused = { ok: false, reason: 'out-of-range', message: PRESSURE_ORDER_HALF };

describe('US-02 AC8: one half against the other half held that day', () => {
  it('refuses a diastolic at or above the systolic already there, and the reverse', () => {
    const sys = withRows(['s', 'systolic_bp', 80]);
    expect(appendMeasurement(sys, { metricType: 'diastolic_bp', value: 120, recordedAt: DAY, now: NOW })).toEqual(refused);
    expect(appendMeasurement(sys, { metricType: 'diastolic_bp', value: 80, recordedAt: DAY, now: NOW })).toEqual(refused);
    const dia = withRows(['d', 'diastolic_bp', 120]);
    expect(appendMeasurement(dia, { metricType: 'systolic_bp', value: 80, recordedAt: DAY, now: NOW })).toEqual(refused);
  });

  it('the web store\'s door (placeMeasurement) refuses the same', () => {
    const sys = withRows(['s', 'systolic_bp', 80]);
    expect(placeMeasurement(sys, { metricType: 'diastolic_bp', value: 120, recordedAt: `${DAY}T00:00:00.000Z`, now: NOW })).toEqual(refused);
  });

  it('accepts the right way up, and another day is another pair', () => {
    const sys = withRows(['s', 'systolic_bp', 120]);
    expect(appendMeasurement(sys, { metricType: 'diastolic_bp', value: 80, recordedAt: DAY, now: NOW }).ok).toBe(true);
    expect(appendMeasurement(sys, { metricType: 'diastolic_bp', value: 130, recordedAt: '2026-10-21', now: NOW }).ok).toBe(true);
  });

  it('an entered-in-error half does not count', () => {
    const file = withRows(['s', 'systolic_bp', 80]);
    file.measurements[0] = { ...file.measurements[0], status: 'entered-in-error' };
    expect(appendMeasurement(file, { metricType: 'diastolic_bp', value: 120, recordedAt: DAY, now: NOW }).ok).toBe(true);
  });

  it('refuses a correction of one half that would invert the pair (D11: only the changed half is corrected)', () => {
    const file = withRows(['s', 'systolic_bp', 120], ['d', 'diastolic_bp', 80]);
    expect(correctValue(file, { id: 's', newValue: 80, now: NOW })).toEqual(refused);
    expect(correctValue(file, { id: 'd', newValue: 125, now: NOW })).toEqual(refused);
    expect(correctValue(file, { id: 's', newValue: 110, now: NOW }).ok).toBe(true);
  });

  it('a day already inverted can be fixed one half at a time', () => {
    const swapped = withRows(['s', 'systolic_bp', 80], ['d', 'diastolic_bp', 120]);
    const first = correctValue(swapped, { id: 's', newValue: 120, now: NOW });
    if (!first.ok) throw new Error(first.message);
    const second = correctValue(first.file, { id: 'd', newValue: 80, now: NOW });
    expect(second.ok).toBe(true);
  });
});

describe('US-02 AC8: a batch (lab import, connector import commit)', () => {
  const row = (metricType: string, value: number, extra: Record<string, unknown> = {}) =>
    ({ kind: 'measurement' as const, metricType, value, recordedAt: DAY, source: 'lab_import' as const, ...extra });

  it('refuses both halves of an inverted pair and writes neither', () => {
    const result = bulkAppendValues(withRows(), [row('systolic_bp', 80), row('diastolic_bp', 120), row('weight', 80)], NOW);
    expect(result.saved.map((r) => 'metricType' in r && r.metricType)).toEqual(['weight']);
    expect(result.measurementRefusals).toEqual([
      { index: 0, metricType: 'systolic_bp', reason: 'out-of-range', message: PRESSURE_ORDER },
      { index: 1, metricType: 'diastolic_bp', reason: 'out-of-range', message: PRESSURE_ORDER },
    ]);
  });

  it('refuses one half against the other half the record holds', () => {
    const result = bulkAppendValues(withRows(['s', 'systolic_bp', 80]), [row('diastolic_bp', 120)], NOW);
    expect(result.saved).toEqual([]);
    expect(result.measurementRefusals).toEqual([{ index: 0, metricType: 'diastolic_bp', reason: 'out-of-range', message: PRESSURE_ORDER }]);
  });

  it('a correcting pair is judged by what it leaves, not by the pair it replaces', () => {
    const file = withRows(['s', 'systolic_bp', 120], ['d', 'diastolic_bp', 80]);
    const result = bulkAppendValues(file, [row('systolic_bp', 70, { correctsId: 's' }), row('diastolic_bp', 60, { correctsId: 'd' })], NOW);
    expect(result.measurementRefusals).toEqual([]);
    expect(result.saved).toHaveLength(2);
  });

  it('judges the pair the batch really leaves: a half refused for its number keeps the held one (review R6)', () => {
    const file = withRows(['s', 'systolic_bp', 120], ['d', 'diastolic_bp', 80]);
    const result = bulkAppendValues(file, [row('systolic_bp', 1000, { correctsId: 's' }), row('diastolic_bp', 130, { correctsId: 'd' })], NOW);
    expect(result.saved).toEqual([]);
    expect(result.measurementRefusals.map((r) => [r.metricType, r.message === PRESSURE_ORDER])).toEqual([['systolic_bp', false], ['diastolic_bp', true]]);
    const active = result.file.measurements.filter((m) => m.status === 'active').map((m) => [m.metricType, m.value]);
    expect(active).toEqual([['systolic_bp', 120], ['diastolic_bp', 80]]);
  });

  it('a right-way-up pair saves', () => {
    const result = bulkAppendValues(withRows(), [row('systolic_bp', 120), row('diastolic_bp', 80)], NOW);
    expect(result.saved).toHaveLength(2);
    expect(result.measurementRefusals).toEqual([]);
  });
});

describe('US-02 AC8: a device import (Apple Health)', () => {
  const pair = (id: string, systolic: number, diastolic: number) => [
    { externalId: `${id}-s`, pairId: id, metricType: 'systolic_bp', value: systolic, measuredAt: '2026-10-20T08:30:00+13:00' },
    { externalId: `${id}-d`, pairId: id, metricType: 'diastolic_bp', value: diastolic, measuredAt: '2026-10-20T08:30:00+13:00' },
  ];

  it('skips an inverted reading as invalid, both halves', () => {
    const result = importDeviceSamples(withRows(), pair('r1', 80, 120), { now: NOW, source: 'apple_health' });
    expect(result.added).toBe(0);
    expect(result.skipped.invalid).toBe(2);
    expect(result.file.measurements).toEqual([]);
  });

  it('still imports a right-way-up reading', () => {
    expect(importDeviceSamples(withRows(), pair('r1', 120, 80), { now: NOW, source: 'apple_health' }).added).toBe(2);
  });
});

describe('US-02 AC8: the plan reads an inverted blood pressure as none (review R1, R2, R5)', () => {
  const inputs = { heightCm: 178, sex: 'male', birthYear: 1971, birthMonth: 1, weightKg: 80, waistCm: 90 } as HealthInputs;
  const bpCards = (r: ReturnType<typeof calculateHealthResults>) => r.suggestions.filter((s) => /pressure|bp/i.test(`${s.id} ${s.title}`)).map((s) => s.id);

  // Brad 2026-10-30: the plan, not calculateHealthResults, leaves the pair out:
  // every caller strips what validateHealthInputs refuses before calculating.
  it('80/120 from one day drives no blood pressure card, where 160/100 does', () => {
    const planOf = (sys: number, dia: number) => {
      const file = withRows(['s', 'systolic_bp', sys], ['d', 'diastolic_bp', dia]);
      Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
      return computePlan(file, new Date(NOW));
    };
    expect(bpCards(planOf(160, 100).results)).not.toEqual([]);
    expect(bpCards(planOf(80, 120).results)).toEqual([]);
  });

  it('validation names the rule on both halves, so every surface leaves both out', () => {
    const result = validateHealthInputs({ ...inputs, systolicBp: 80, diastolicBp: 120 });
    expect(result.success).toBe(false);
    expect(result.errors!.issues.map((i) => [i.path[0], i.message])).toEqual([['systolicBp', PRESSURE_ORDER], ['diastolicBp', PRESSURE_ORDER]]);
    expect(validateHealthInputs({ ...inputs, systolicBp: 120, diastolicBp: 80 }).success).toBe(true);
  });

  it('two devices each correct one half of 120/80; the merged day is inverted, and the plan has no blood pressure', () => {
    const base = withRows(['s', 'systolic_bp', 120], ['d', 'diastolic_bp', 80]);
    Object.assign(base.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
    const phone = correctValue(base, { id: 's', newValue: 100, now: '2026-10-30T09:01:00Z' });
    const web = correctValue(base, { id: 'd', newValue: 110, now: '2026-10-30T09:02:00Z' });
    if (!phone.ok || !web.ok) throw new Error('each correction alone is right way up');
    const merged = mergeFiles(phone.file, web.file, { now: NOW, deviceId: 'us02_ac8' });
    const active = merged.measurements.filter((m) => m.status === 'active').map((m) => [m.metricType, m.value]).sort();
    expect(active).toEqual([['diastolic_bp', 110], ['systolic_bp', 100]]);
    const plan = computePlan(merged, new Date(NOW));
    expect(plan.inputs.systolicBp).toBeUndefined();
    expect(plan.inputs.diastolicBp).toBeUndefined();
    expect(plan.excluded).toEqual(expect.arrayContaining(['systolicBp', 'diastolicBp']));
    expect(bpCards(plan.results)).toEqual([]);
  });
});

