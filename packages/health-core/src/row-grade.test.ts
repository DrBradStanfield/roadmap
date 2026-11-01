// US-62 AC8, US-25 AC17: a value's grade and its spoken words, moved unchanged
// from the widget so the iPhone grades by the same rule. The statusOf cases are
// the widget's own (widget-src/src/lib/blood-test-cell.test.ts), run here against
// health-core; the rest pin the vitals grades and words the widget had no test for.
import { describe, expect, it } from 'vitest';
import { bpStatus, gradeWords, pressureStatus, simpleStatus, statusOf, valueStatus } from './row-grade';

describe('statusOf: the widget\'s cases (US-07 AC5, US-03 AC7, US-62 AC13, US-07 AC6)', () => {
  it.each([
    [1.39, 'ok'], [1.4, 'warn'], [3.2, 'warn'], [3.37, 'warn'], [4.13, 'warn'], [4.14, 'bad'],
  ])('LDL %s is %s', (value, status) => {
    expect(statusOf('ldl', value, {})).toBe(status);
  });

  it('ApoB: warn from 0.5, bad from 0.7', () => {
    expect([0.49, 0.5, 0.7].map((v) => statusOf('apob', v, {}))).toEqual(['ok', 'warn', 'bad']);
  });

  it.each(['ldl', 'hdl', 'total_cholesterol', 'triglycerides', 'apob'] as const)('%s 0 (out of range) has no status', (metric) => {
    expect(statusOf(metric, 0, {})).toBeNull();
  });

  it('an in-range value is still graded, and PSA 0 (in range) still is', () => {
    expect([statusOf('ldl', 1.0, {}), statusOf('hdl', 0.5, { sex: 'male' }), statusOf('psa', 0, {})]).toEqual(['ok', 'bad', 'ok']);
  });

  it('HDL and creatinine have no status without sex', () => {
    for (const [metric, value] of [['hdl', 0.5], ['hdl', 1.1], ['hdl', 2.0], ['creatinine', 60], ['creatinine', 100], ['creatinine', 200]] as const) {
      expect(statusOf(metric, value, {}), `${metric} ${value}`).toBeNull();
    }
  });

  it('with sex, each is graded on its own line', () => {
    expect([60, 90, 91, 116, 117].map((v) => statusOf('creatinine', v, { sex: 'female' }))).toEqual(['ok', 'ok', 'warn', 'warn', 'bad']);
    expect([100, 110, 111, 142, 143].map((v) => statusOf('creatinine', v, { sex: 'male' }))).toEqual(['ok', 'ok', 'warn', 'warn', 'bad']);
    expect([1.0, 1.04, 1.28, 1.3].map((v) => statusOf('hdl', v, { sex: 'female' }))).toEqual(['bad', 'warn', 'warn', 'ok']);
    expect([1.0, 1.04, 1.3].map((v) => statusOf('hdl', v, { sex: 'male' }))).toEqual(['bad', 'ok', 'ok']);
  });

  it('the unsexed tests are graded without sex; a known minor (null) gets none', () => {
    expect([statusOf('hba1c', 50, {}), statusOf('ldl', 4.2, {}), statusOf('triglycerides', 1.0, {})]).toEqual(['bad', 'bad', 'ok']);
    expect(statusOf('ldl', 4.2, null)).toBeNull();
  });
});

describe('the vitals grades (US-06 AC5)', () => {
  it('weight: ok from 5 under to 2 over the ideal, amber to 5 over and anywhere under, red past 5 over', () => {
    expect([64, 65, 72, 72.5, 75, 75.5, 50].map((kg) => simpleStatus('weight', kg, 70))).toEqual(['warn', 'ok', 'ok', 'warn', 'warn', 'bad', 'warn']);
    expect(simpleStatus('weight', 70, undefined)).toBeNull();
  });

  it('waist: ok while the rounded ratio is under 0.5 (from 0.495), amber to 8 cm over half the height, red past it; none without a height', () => {
    expect([89, 89.1, 98, 98.5].map((cm) => simpleStatus('waist', cm, undefined, 180))).toEqual(['ok', 'warn', 'warn', 'bad']);
    expect(simpleStatus('waist', 90, undefined, undefined)).toBeNull();
  });

  it('blood pressure: ok under target/80, amber within 10/5, red past; none without a target or a half', () => {
    expect([[119, 79], [120, 79], [129, 84], [130, 70], [110, 85]].map(([s, d]) => bpStatus(s, d, 120))).toEqual(['ok', 'warn', 'warn', 'bad', 'bad']);
    expect([bpStatus(119, 79, undefined), bpStatus(119, null, 120)]).toEqual([null, null]);
  });

  it('valueStatus and pressureStatus read the plan, and grade no weight or pressure for a known minor', () => {
    const plan = { age: 50, idealBodyWeight: 70, heightCm: 180 };
    expect([valueStatus('weight', 80, { grading: {}, plan }), valueStatus('waist', 95, { grading: {}, plan }), valueStatus('ldl', 2, { grading: {}, plan })]).toEqual(['bad', 'warn', 'warn']);
    expect(valueStatus('weight', 80, { grading: null, plan })).toBeNull();
    expect(valueStatus('waist', 95, { grading: null, plan })).toBe('warn');
    expect(pressureStatus({ value: 125, dia: { value: 82 } }, { grading: {}, plan })).toBe('warn');
    expect(pressureStatus({ value: 125, dia: { value: 82 } }, { grading: null, plan })).toBeNull();
    expect(pressureStatus({ value: 125, dia: { value: 82 } }, { grading: {}, plan: null })).toBeNull();
    expect(pressureStatus({ value: 125 }, { grading: {}, plan })).toBeNull();
  });
});

describe('gradeWords: said only off target (US-62 AC8)', () => {
  it('names the line each metric\'s target prints, and nothing on target or ungraded', () => {
    expect([gradeWords('warn', 'ldl'), gradeWords('warn', 'hba1c'), gradeWords('warn', 'waist'), gradeWords('warn', 'blood_pressure'), gradeWords('bad', 'ldl')])
      .toEqual(['above optimal', 'above normal', 'above target', 'above target', 'high']);
    expect([gradeWords('warn', 'hdl'), gradeWords('bad', 'hdl'), gradeWords('warn', 'weight'), gradeWords('bad', 'weight')])
      .toEqual(['below optimal', 'low', 'outside target', 'above target']);
    expect([gradeWords('ok', 'ldl'), gradeWords(null, 'ldl')]).toEqual([null, null]);
  });
});
