/**
 * US-07 AC8 (Brad 2026-10-31, web redesign §4): the engine plans without sex.
 * The web form asks height and weight first, then sex, so BMI must show before
 * sex arrives. Every output that depends on sex is gated on it explicitly:
 * none falls back to the male or female formula.
 */
import { describe, it, expect } from 'vitest';
import { calculateHealthResults, missingPlanInputs } from './calculations';
import { createEmptyFile, createLabValue, createMeasurement, type RoadmapFile } from './roadmap-file';
import { computePlan, NEEDS_SEX, planPayload, withLabEgfr } from './plan';
import { statTiles } from './stat-tiles';
import { validateHealthInputs } from './validation';
import type { HealthInputs, ScreeningInputs } from './types';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const NO_SEX: HealthInputs = { heightCm: 170, weightKg: 80, sex: undefined };
const ids = (inputs: HealthInputs, screenings?: ScreeningInputs) =>
  calculateHealthResults(inputs, 'si', undefined, screenings, undefined, NOW).suggestions.map((s) => s.id);

describe('US-07 AC8: the plan without sex', () => {
  it('the schema accepts a record with height and no sex', () => {
    expect(validateHealthInputs({ heightCm: 170 }).success).toBe(true);
  });

  it('BMI still shows', () => {
    const r = calculateHealthResults(NO_SEX, 'si', undefined, undefined, undefined, NOW);
    expect(r.bmi).toBe(27.7);
    expect(r.bmiCategory).toBe('Overweight');
  });

  it('calculateIBW gate: no ideal body weight and no protein target without sex', () => {
    const r = calculateHealthResults(NO_SEX, 'si', undefined, undefined, undefined, NOW);
    expect(r.idealBodyWeight).toBeUndefined();
    expect(r.proteinTarget).toBeUndefined();
  });

  it('calculateEGFR gate: no calculated eGFR without sex', () => {
    const r = calculateHealthResults({ ...NO_SEX, birthYear: 1960, creatinine: 80 }, 'si', undefined, undefined, undefined, NOW);
    expect(r.age).toBe(66);
    expect(r.eGFR).toBeUndefined();
  });

  it('a lab eGFR still stands without sex', () => {
    const r = calculateHealthResults({ ...NO_SEX, labEgfr: 52, labEgfrDate: '2026-07-01' }, 'si', undefined, undefined, undefined, NOW);
    expect(r.eGFR).toBe(52);
  });

  it('the protein-target card is absent, never "undefinedg"', () => {
    const r = calculateHealthResults(NO_SEX, 'si', undefined, undefined, undefined, NOW);
    expect(r.suggestions.map((s) => s.id)).not.toContain('protein-target');
    expect(JSON.stringify(r.suggestions)).not.toContain('undefined');
  });

  it('the HDL card has no sex threshold without sex: no "for women", no hdl-low', () => {
    // 1.2 mmol/L is low for a woman (<1.29) and fine for a man (<1.03).
    const r = calculateHealthResults({ ...NO_SEX, hdlC: 1.2 }, 'si', undefined, undefined, undefined, NOW);
    expect(r.suggestions.map((s) => s.id)).not.toContain('hdl-low');
    expect(JSON.stringify(r.suggestions)).not.toMatch(/for (wo)?men/);
  });

  it('statTiles: BMI, but no ideal body weight or protein tile without sex', () => {
    const r = calculateHealthResults(NO_SEX, 'si', undefined, undefined, undefined, NOW);
    const keys = statTiles(r, { unitSystem: 'si', sex: undefined }).map((t) => t.key);
    expect(keys).toContain('bmi');
    expect(keys).not.toContain('ibw');
    expect(keys).not.toContain('protein');
  });

  it('no sexed screening for a returning record with an age and no sex', () => {
    const got = ids({ ...NO_SEX, birthYear: 1960 }, {});
    for (const id of ['screening-breast', 'screening-cervical', 'screening-prostate', 'screening-endometrial', 'screening-dexa']) {
      expect(got.some((g) => g.startsWith(id))).toBe(false);
    }
    // The unsexed bowel screening still shows.
    expect(got.some((g) => g.startsWith('screening-colorectal'))).toBe(true);
  });

  it('with sex, all of it comes back', () => {
    const r = calculateHealthResults({ ...NO_SEX, sex: 'female', hdlC: 1.2 }, 'si', undefined, undefined, undefined, NOW);
    expect(r.idealBodyWeight).toBeGreaterThan(0);
    expect(r.suggestions.map((s) => s.id)).toEqual(expect.arrayContaining(['protein-target', 'hdl-low']));
  });
});

describe('US-07 AC7 + AC8: withLabEgfr without sex', () => {
  const lab = { labEgfr: 52, labEgfrDate: '2026-06-01' };

  it('no sex, an older lab eGFR, a newer creatinine: the lab eGFR is kept', () => {
    const inputs = withLabEgfr<Partial<HealthInputs>>({ heightCm: 170, birthYear: 1960, creatinine: 80 }, '2026-08-01', lab, '2026-09-01');
    expect(inputs.labEgfr).toBe(52);
    const r = calculateHealthResults(inputs as HealthInputs, 'si', undefined, undefined, undefined, NOW);
    expect(r.eGFR).toBe(52);
    expect(r.eGFRFromLab).toBe(true);
  });

  it('with sex, the newer creatinine still outranks the older lab eGFR', () => {
    const inputs = withLabEgfr<Partial<HealthInputs>>({ heightCm: 170, sex: 'male', birthYear: 1960, creatinine: 80 }, '2026-08-01', lab, '2026-09-01');
    expect(inputs.labEgfr).toBeUndefined();
  });
});

function fileWithoutSex(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'no_sex', now: NOW.toISOString() });
  Object.assign(file.profile, { heightCm: 170, birthYear: 1960, birthMonth: 1, unitSystem: 'si' });
  file.measurements = [
    createMeasurement({ id: 'w', metricType: 'weight', value: 80, recordedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' }),
    createMeasurement({ id: 'cr', metricType: 'creatinine', value: 80, recordedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' }),
  ];
  file.labValues = [createLabValue({
    id: 'egfr', metricName: 'egfr', value: 52, unit: 'mL/min/1.73m²', recordedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z',
  })];
  return file;
}

describe('US-07 AC8, US-32: get_plan without sex', () => {
  it('computePlan plans a record with height and no sex, keeping the older lab eGFR', () => {
    const plan = computePlan(fileWithoutSex(), NOW);
    expect(plan.results.bmi).toBe(27.7);
    expect(plan.results.eGFR).toBe(52);
  });

  it('the payload names sex as missing, nulls what needs it, and says what needs it', () => {
    const payload = planPayload(computePlan(fileWithoutSex(), NOW));
    expect(payload.profile.sex).toBeNull();
    expect(payload.profile.idealBodyWeightKg).toBeNull();
    expect(payload.profile.proteinTargetG).toBeNull();
    expect(payload.profile.bmi).toBe(27.7);
    expect(payload.missingInputs).toContain('sex');
    expect(payload.profile.needsSex).toEqual(NEEDS_SEX);
    expect(JSON.parse(JSON.stringify(payload)).profile).toHaveProperty('sex', null);
  });

  it('with sex, needsSex is empty', () => {
    const file = fileWithoutSex();
    file.profile.sex = 'male';
    const payload = planPayload(computePlan(file, NOW));
    expect(payload.profile.needsSex).toEqual([]);
    expect(missingPlanInputs(payload.inputs)).not.toContain('sex');
  });

  it('no height is still a PlanError, and its hint asks for height alone', () => {
    const file = createEmptyFile({ deviceId: 'no_height', now: NOW.toISOString() });
    expect(() => computePlan(file, NOW)).toThrow(/height/);
    try { computePlan(file, NOW); } catch (e) {
      expect((e as Error).message).not.toMatch(/sex/);
    }
  });
});
