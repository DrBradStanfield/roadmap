/**
 * US-02 AC8 (Brad 2026-10-30): the plan judges a blood pressure pair only when
 * both halves are from the same day. An inverted same-day pair is no blood
 * pressure in the plan; halves from different days are used as before.
 *
 * Adversary N1: Monday 150/100, then a single systolic 98 on Tuesday. The
 * value-only guard compared 98 with 100, dropped both, and get-plan called
 * the readings "out of range".
 */
import { describe, it, expect } from 'vitest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { computePlan, currentValues, PRESSURE_EXCLUDED } from './plan';
import { buildChatContextJson } from './chat-context';
import { runRoadmap } from './run-roadmap';
import { PRESSURE_ORDER, validateHealthInputs } from './validation';
import { localDay } from './merge';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const BP_CARDS = ['bp-crisis', 'bp-stage2', 'bp-stage1'];

function fileWith(rows: Array<{ metricType: string; value: number; day: string }>) {
  const file = createEmptyFile({ deviceId: 'pressure_pair', now: NOW.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 180, birthYear: 1970, birthMonth: 1, unitSystem: 'si' });
  file.measurements = rows.map((r, i) => createMeasurement({
    id: `m${i}`, metricType: r.metricType, value: r.value,
    recordedAt: `${r.day}T08:00:00.000Z`, createdAt: `${r.day}T08:00:00.000Z`,
  }));
  return file;
}
const bpCards = (plan: ReturnType<typeof computePlan>) =>
  plan.results.suggestions.map((s) => s.id).filter((id) => BP_CARDS.includes(id));

describe('US-02 AC8: the plan judges a pair only within one day', () => {
  it('US-02 AC8 (N1): 150/100 on Monday, then systolic 98 on Tuesday: the plan uses 98/100, a BP card shows, nothing is excluded', () => {
    const plan = computePlan(fileWith([
      { metricType: 'systolic_bp', value: 150, day: '2026-10-26' },
      { metricType: 'diastolic_bp', value: 100, day: '2026-10-26' },
      { metricType: 'systolic_bp', value: 98, day: '2026-10-27' },
    ]), NOW);
    expect(plan.inputs).toMatchObject({ systolicBp: 98, diastolicBp: 100 });
    expect(plan.excluded).toEqual([]);
    expect(bpCards(plan)).not.toEqual([]);
    expect(currentValues(plan).filter((v) => v.excluded)).toEqual([]);
  });

  it('US-02 AC8: a same-day 98/100 is no blood pressure: no BP card, both excluded, and the reason is the order, not the range', () => {
    const plan = computePlan(fileWith([
      { metricType: 'systolic_bp', value: 150, day: '2026-10-26' },
      { metricType: 'diastolic_bp', value: 100, day: '2026-10-26' },
      { metricType: 'systolic_bp', value: 98, day: '2026-10-27' },
      { metricType: 'diastolic_bp', value: 100, day: '2026-10-27' },
    ]), NOW);
    expect(plan.inputs.systolicBp).toBeUndefined();
    expect(plan.inputs.diastolicBp).toBeUndefined();
    expect([...plan.excluded].sort()).toEqual(['diastolicBp', 'systolicBp']);
    expect(bpCards(plan)).toEqual([]);
    const rows = currentValues(plan).filter((v) => v.metric.endsWith('_bp'));
    expect(rows.map((r) => [r.metric, r.excluded, r.excludedReason])).toEqual([
      ['diastolic_bp', true, PRESSURE_EXCLUDED], ['systolic_bp', true, PRESSURE_EXCLUDED],
    ]);
  });

  it('US-02 AC8: an out-of-range row keeps its plain exclusion, with no order reason', () => {
    const plan = computePlan(fileWith([{ metricType: 'systolic_bp', value: 400, day: '2026-10-27' }]), NOW);
    const row = currentValues(plan).find((v) => v.metric === 'systolic_bp');
    expect(row).toMatchObject({ excluded: true });
    expect(row?.excludedReason).toBeUndefined();
  });
});

describe('US-02 AC8: validateHealthInputs judges the pair by day', () => {
  const BASE = { heightCm: 180, sex: 'male' as const, systolicBp: 98, diastolicBp: 100 };
  const pairIssues = (r: ReturnType<typeof validateHealthInputs>) =>
    (r.errors?.issues ?? []).filter((i) => i.message === PRESSURE_ORDER).map((i) => i.path[0]);

  it('US-02 AC8: unknown days or one day: both halves get the order issue', () => {
    expect(pairIssues(validateHealthInputs(BASE))).toEqual(['systolicBp', 'diastolicBp']);
    expect(pairIssues(validateHealthInputs(BASE, { systolicBp: '2026-10-27', diastolicBp: '2026-10-27' }))).toEqual(['systolicBp', 'diastolicBp']);
    expect(pairIssues(validateHealthInputs(BASE, { systolicBp: '2026-10-27', diastolicBp: null }))).toEqual(['systolicBp', 'diastolicBp']);
  });

  it('US-02 AC8: two known, different days: not judged, the inputs pass', () => {
    expect(validateHealthInputs(BASE, { systolicBp: '2026-10-27', diastolicBp: '2026-10-26' }).success).toBe(true);
  });

  it('US-02 AC8 (N3): a half the schema refuses does not knock out the other', () => {
    const r = validateHealthInputs({ ...BASE, systolicBp: 98, diastolicBp: 400 });
    expect(pairIssues(r)).toEqual([]);
    expect((r.errors?.issues ?? []).map((i) => i.path[0])).toEqual(['diastolicBp']);
  });
});

describe('US-02 AC8: the chat context', () => {
  const PROFILE = { sex: 'male', heightCm: 180, birthYear: 1970, unitSystem: 'si', medications: [], screenings: [] };
  const ctx = (payload: unknown) => JSON.parse(buildChatContextJson(payload)!);
  const ids = (c: { currentSuggestions: Array<{ id: string }> }) => c.currentSuggestions.map((s) => s.id);

  it('US-02 AC8: a merged same-day 98/100 is out of latestValues and the plan, named in excludedFields, and history does not restore it', () => {
    const c = ctx({
      ...PROFILE, systolicBp: 98, diastolicBp: 100,
      measurementHistory: {
        systolic_bp: [{ date: '2026-10-26', value: 150 }, { date: '2026-10-27', value: 98 }],
        diastolic_bp: [{ date: '2026-10-26', value: 100 }, { date: '2026-10-27', value: 100 }],
      },
    });
    expect(c.latestValues).not.toHaveProperty('systolicBp');
    expect(c.latestValues).not.toHaveProperty('diastolicBp');
    expect(c.excludedFields).toEqual(['systolicBp', 'diastolicBp']);
    expect(ids(c).filter((id) => BP_CARDS.includes(id))).toEqual([]);
  });

  it('US-02 AC8: a snapshot with no history behind it is one reading, and judged', () => {
    const c = ctx({ ...PROFILE, systolicBp: 98, diastolicBp: 100 });
    expect(c.latestValues).not.toHaveProperty('systolicBp');
    expect(c.excludedFields).toEqual(['systolicBp', 'diastolicBp']);
  });

  it('US-02 AC8: no snapshot pair, and history\'s latest pair is one day the wrong way up: not filled', () => {
    const c = ctx({
      ...PROFILE,
      measurementHistory: { systolic_bp: [{ date: '2026-10-27', value: 98 }], diastolic_bp: [{ date: '2026-10-27', value: 100 }] },
    });
    expect(c.latestValues).not.toHaveProperty('systolicBp');
    expect(c.latestValues).not.toHaveProperty('diastolicBp');
    expect(c.excludedFields).toEqual(['systolicBp', 'diastolicBp']);
  });

  it('US-02 AC8 (N1): halves from different days are used: in latestValues and the plan, nothing excluded', () => {
    const c = ctx({
      ...PROFILE, systolicBp: 98, diastolicBp: 100,
      measurementHistory: {
        systolic_bp: [{ date: '2026-10-26', value: 150 }, { date: '2026-10-27', value: 98 }],
        diastolic_bp: [{ date: '2026-10-26', value: 100 }],
      },
    });
    expect(c.latestValues).toMatchObject({ systolicBp: '98', diastolicBp: '100' });
    expect(c).not.toHaveProperty('excludedFields');
    expect(ids(c).filter((id) => BP_CARDS.includes(id))).not.toEqual([]);
  });

  it('US-02 AC8: an unsaved systolic 98 typed against Monday\'s 150/100 is today\'s draft, not Monday\'s: used, nothing excluded', () => {
    const c = ctx({
      ...PROFILE, systolicBp: 98, diastolicBp: 100,
      measurementHistory: {
        systolic_bp: [{ date: '2026-10-26', value: 150 }],
        diastolic_bp: [{ date: '2026-10-26', value: 100 }],
      },
    });
    expect(c.latestValues).toMatchObject({ systolicBp: '98', diastolicBp: '100' });
    expect(c).not.toHaveProperty('excludedFields');
    expect(ids(c).filter((id) => BP_CARDS.includes(id))).not.toEqual([]);
  });

  it('US-02 AC8: an unsaved systolic 98 against a diastolic 100 saved today is one reading, and judged', () => {
    const today = localDay(new Date());
    const c = ctx({
      ...PROFILE, systolicBp: 98, diastolicBp: 100,
      measurementHistory: {
        systolic_bp: [{ date: '2026-10-26', value: 150 }],
        diastolic_bp: [{ date: '2026-10-26', value: 90 }, { date: today, value: 100 }],
      },
    });
    expect(c.latestValues).not.toHaveProperty('systolicBp');
    expect(c.excludedFields).toEqual(['systolicBp', 'diastolicBp']);
  });
});

describe('US-02 AC8: runRoadmap', () => {
  const SAVED = {
    unitSystem: 'si', medications: [], screenings: [],
    sex: 'male', heightCm: 178, birthYear: 1972, birthMonth: 5, systolicBp: 118, diastolicBp: 76,
    measurementHistory: { systolic_bp: [{ date: '2026-10-01', value: 118 }], diastolic_bp: [{ date: '2026-10-01', value: 76 }] },
  };
  const val = (field: string, value: number) => ({ field, value, unit: 'mmHg' });

  it('US-02 AC8: a stated 98/100 is rejected with the order reason, not applied, and the saved pair does not answer either', () => {
    const r = runRoadmap(SAVED, { values: [val('systolicBp', 98), val('diastolicBp', 100)] }, NOW);
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([
      { field: 'systolicBp', reason: expect.stringContaining(PRESSURE_ORDER) },
      { field: 'diastolicBp', reason: expect.stringContaining(PRESSURE_ORDER) },
    ]);
    const latest = JSON.parse(r.contextJson!).latestValues;
    expect(latest).not.toHaveProperty('systolicBp');
    expect(latest).not.toHaveProperty('diastolicBp');
  });

  it('US-02 AC8: a lone stated half is never applied, so it cannot join a saved half the wrong way up', () => {
    const r = runRoadmap(SAVED, { values: [val('systolicBp', 70)] }, NOW);
    expect(r.applied).toEqual([]);
  });
});
