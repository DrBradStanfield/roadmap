/**
 * US-12 AC20 (Brad 2026-11-02, "Only when it decides"): a lab result printed as
 * a limit grades the plan only when the bound decides, and every surface the
 * plan feeds shows the bound with its symbol, never the representative.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyFile, createLabValue, createMeasurement, type RoadmapFile } from './roadmap-file';
import { computePlan, planPayload } from './plan';
import { statTiles, NOT_GRADED } from './stat-tiles';
import { LIMIT_NOT_GRADED, type Comparator } from './lab-limits';
import { isReadableRow, readableView } from './readable-rows';
import { HBA1C_THRESHOLDS } from './units';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const DAY = '2026-08-01T00:00:00.000Z';

type Row = { metricType: string; value: number; comparator?: Comparator; recordedAt?: string };
type Lab = { metricName: string; value: number; unit: string; comparator?: Comparator; recordedAt?: string };

function record(rows: Row[], labs: Lab[] = []): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'plan_lab_limits', now: NOW.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 180, birthYear: 1970, birthMonth: 1, unitSystem: 'si' });
  file.measurements = rows.map((r, i) => createMeasurement({ id: `m${i}`, recordedAt: DAY, createdAt: DAY, ...r }));
  file.labValues = labs.map((l, i) => createLabValue({ id: `l${i}`, recordedAt: DAY, createdAt: DAY, ...l }));
  return file;
}

const BP: Row[] = [{ metricType: 'systolic_bp', value: 135 }, { metricType: 'diastolic_bp', value: 85 }, { metricType: 'weight', value: 80 }];
const POTASSIUM = 'Increase potassium-rich foods';

describe('US-12 AC20: eGFR printed as a limit', () => {
  it('"> 90" decides: the potassium advice and the protein rate work, and eGFR reads "> 90", never the representative', () => {
    const plan = computePlan(record(BP, [{ metricName: 'egfr', value: 90, unit: 'mL/min/1.73m²', comparator: '>' }]), NOW);
    const payload = planPayload(plan);
    expect(payload.profile.eGFR).toBe('> 90');
    expect(payload.suggestions.find((s) => s.id.startsWith('bp-'))?.description).toContain(POTASSIUM);
    const tile = statTiles(plan.results, { unitSystem: 'si', sex: 'male' }).find((t) => t.key === 'egfr')!;
    expect(tile.value).toBe('> 90');
    expect(tile.status).toEqual({ label: 'Normal', tone: 'normal' });
    expect(payload.labValues.find((l) => l.key === 'egfr')).toMatchObject({ value: 90, comparator: '>' });
    expect(JSON.stringify(payload)).not.toContain(String(plan.inputs.labEgfr));
  });

  // The orchestrator, 2026-11-02 (option B): the plan grades against its own lines (45 here);
  // the tile's 70 line drives only its word.
  it('"> 60" decides for the plan: potassium advice and 1.2 g/kg; the tile shows "> 60" with no Normal or Low Normal', () => {
    const plan = computePlan(record(BP, [{ metricName: 'egfr', value: 60, unit: 'mL/min/1.73m²', comparator: '>' }]), NOW);
    const payload = planPayload(plan);
    expect(payload.profile.eGFR).toBe('> 60');
    expect(payload.inputs.limits).toEqual({ labEgfr: { comparator: '>', bound: 60, graded: true } });
    expect(payload.suggestions.find((s) => s.id.startsWith('bp-'))?.description).toContain(POTASSIUM);
    expect(payload.suggestions.find((s) => s.id === 'protein-target')?.description).not.toContain('adjusted for kidney function');
    const tile = statTiles(plan.results, { unitSystem: 'si', sex: 'male' }).find((t) => t.key === 'egfr')!;
    expect(tile.value).toBe('> 60');
    expect(tile.status).toBeUndefined();
    expect(tile.about).not.toContain(LIMIT_NOT_GRADED);
  });

  it('"> 30" does not decide (45 lies above): no eGFR, no potassium advice, no eGFR from an older creatinine, not missing', () => {
    const older = { metricType: 'creatinine', value: 80, recordedAt: '2026-01-01T00:00:00.000Z' };
    const plan = computePlan(record([...BP, older], [{ metricName: 'egfr', value: 30, unit: 'mL/min/1.73m²', comparator: '>' }]), NOW);
    const payload = planPayload(plan);
    expect(plan.results.eGFR).toBeUndefined();
    expect(payload.profile.eGFR).toBe('> 30');
    expect(payload.inputs.limits).toEqual({ labEgfr: { comparator: '>', bound: 30, graded: false } });
    expect(payload.suggestions.find((s) => s.id.startsWith('bp-'))?.description).not.toContain(POTASSIUM);
    expect(payload.missingInputs).not.toContain('creatinine');
    const tile = statTiles(plan.results, { unitSystem: 'si', sex: 'male' }).find((t) => t.key === 'egfr')!;
    expect(tile).toMatchObject({ value: '> 30', status: NOT_GRADED });
    expect(tile.about).toContain(LIMIT_NOT_GRADED);
  });
});

describe('US-12 AC20: the common cases', () => {
  it('Lp(a) "< 10" nmol/L decides: the normal card, titled with the limit', () => {
    const payload = planPayload(computePlan(record([{ metricType: 'lpa', value: 10, comparator: '<' }]), NOW));
    const card = payload.suggestions.find((s) => s.id === 'lpa-normal');
    expect(card?.title).toBe('Lp(a): < 10 nmol/L');
    expect(payload.inputs.lpa).toBe('< 10');
    expect(payload.currentValues.find((v) => v.metric === 'lpa')).toMatchObject({ value: '< 10', comparator: '<' });
  });

  it('PSA "< 0.01" decides, and prints its bound at the places it needs', () => {
    const plan = computePlan(record([{ metricType: 'psa', value: 0.01, comparator: '<' }]), NOW);
    expect(plan.inputs.limits?.psa?.graded).toBe(true);
    expect(planPayload(plan).currentValues.find((v) => v.metric === 'psa')?.value).toBe('< 0.01');
  });

  it('HDL "> 1.5" mmol/L decides: no low-HDL card, and no non-HDL from it beside an exact total cholesterol', () => {
    const plan = computePlan(record([{ metricType: 'hdl', value: 1.5, comparator: '>' }, { metricType: 'total_cholesterol', value: 5 }]), NOW);
    expect(plan.inputs.limits?.hdlC?.graded).toBe(true);
    expect(plan.results.suggestions.some((s) => s.id === 'hdl-low')).toBe(false);
    expect(plan.results.nonHdlCholesterol).toBeUndefined();
  });

  it('LDL "< 1.5" mmol/L does not decide (target 1.4 lies below): no LDL card, shown with its limit and the plain line', () => {
    const plan = computePlan(record([{ metricType: 'ldl', value: 1.5, comparator: '<' }]), NOW);
    const payload = planPayload(plan);
    expect(plan.inputs.ldlC).toBeUndefined();
    expect(plan.results.suggestions.some((s) => s.id.startsWith('ldl-') || s.id === 'med-statin')).toBe(false);
    expect(payload.currentValues.find((v) => v.metric === 'ldl')).toMatchObject({ value: '< 1.5', notGraded: LIMIT_NOT_GRADED });
    const tile = statTiles(plan.results, { unitSystem: 'si', sex: 'male' }).find((t) => t.key === 'ldl');
    expect(tile).toMatchObject({ value: '< 1.5', status: NOT_GRADED });
  });

  it('an undecided limit never falls back to an older exact value', () => {
    const older = { metricType: 'ldl', value: 3.5, recordedAt: '2025-01-01T00:00:00.000Z' };
    const plan = computePlan(record([older, { metricType: 'ldl', value: 1.5, comparator: '<' }]), NOW);
    expect(plan.inputs.ldlC).toBeUndefined();
  });

  it('a strict limit at a cutoff decides; the non-strict one at the same cutoff does not (HbA1c at the prediabetes line)', () => {
    const at = HBA1C_THRESHOLDS.prediabetes; // 38.8 mmol/mol as displayed
    const strict = computePlan(record([{ metricType: 'hba1c', value: at, comparator: '<' }]), NOW);
    expect(strict.results.suggestions.find((s) => s.id === 'hba1c-normal')?.description).toContain('< 38.8');
    const loose = computePlan(record([{ metricType: 'hba1c', value: at, comparator: '<=' }]), NOW);
    expect(loose.results.suggestions.some((s) => s.id.startsWith('hba1c-'))).toBe(false);
    expect(planPayload(loose).currentValues.find((v) => v.metric === 'hba1c')?.value).toBe('≤ 38.8');
  });
});

describe('US-12 AC20: a comparator a reader cannot interpret makes the row unreadable', () => {
  it.each(['=', '≥', 'gt', null, 1])('%s', (comparator) => {
    expect(isReadableRow('measurements', { id: 'a', metricType: 'ldl', value: 1, comparator })).toBe(false);
    expect(isReadableRow('labValues', { id: 'a', metricName: 'egfr', value: 60, unit: 'mL/min/1.73m²', comparator })).toBe(false);
  });

  it('the four codes, and none, are readable; an unreadable one is kept in the file and hidden from the plan', () => {
    for (const comparator of ['<', '<=', '>', '>=', undefined]) {
      expect(isReadableRow('measurements', { id: 'a', metricType: 'ldl', value: 1, comparator })).toBe(true);
    }
    const file = record([{ metricType: 'ldl', value: 1.5, comparator: '≤' as Comparator }]);
    expect(readableView(file).count).toBe(1);
    expect(file.measurements).toHaveLength(1);
    expect(computePlan(readableView(file).file, NOW).currentRows).toEqual([]);
  });
});

// Codex review of 0a2b89b0 (C2): the elevated Lp(a) checklist said "not tested"
// for a test saved as a limit the plan could not grade. Held is not missing.
describe('US-12 AC20: the Lp(a) checklist names a saved limit, never "not tested"', () => {
  it('an undecided LDL and HbA1c read as printed with the plain line; an absent blood pressure is still "not entered"', () => {
    const plan = computePlan(record([
      { metricType: 'lpa', value: 150 },
      { metricType: 'ldl', value: 1.5, comparator: '<' },
      { metricType: 'hba1c', value: HBA1C_THRESHOLDS.prediabetes, comparator: '<=' },
    ]), NOW);
    const card = plan.results.suggestions.find((s) => s.id === 'lpa-elevated')!;
    expect(card.description).toContain(`LDL-c: < 1.5 mmol/L — ${LIMIT_NOT_GRADED}`);
    expect(card.description).toContain(`HbA1c: ≤ 38.8 mmol/mol — ${LIMIT_NOT_GRADED}`);
    expect(card.description).not.toContain('Lipids — not tested');
    expect(card.description).not.toContain('HbA1c — not tested');
    expect(card.description).toContain('Blood pressure — not entered');
  });
});

// Adversary review of 0a2b89b0 (R4): an inverted pair is left out with its limits (US-02 AC8).
it('US-12 AC20: a blood pressure the wrong way up leaves the plan with its limit', () => {
  const payload = planPayload(computePlan(record([{ metricType: 'systolic_bp', value: 100, comparator: '<' }, { metricType: 'diastolic_bp', value: 90 }]), NOW));
  expect(payload.inputs.systolicBp).toBeUndefined();
  expect(payload.inputs).not.toHaveProperty('limits');
});
