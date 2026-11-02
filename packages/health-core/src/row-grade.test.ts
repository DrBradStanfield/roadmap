// US-62 AC8, US-25 AC17: a value's grade and its spoken words, moved unchanged
// from the widget so the iPhone grades by the same rule. The statusOf cases are
// the widget's own (widget-src/src/lib/blood-test-cell.test.ts), run here against
// health-core; the rest pin the vitals grades and words the widget had no test for.
import { describe, expect, it } from 'vitest';
import { bpStatus, gradeWords, limitUngraded, pressureStatus, savedStatus, statusOf, valueStatus, type GradeContext, type PressureReading } from './row-grade';

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
    const ideal = (idealBodyWeight?: number) => ({ grading: {}, plan: { idealBodyWeight } });
    expect([64, 65, 72, 72.5, 75, 75.5, 50].map((kg) => valueStatus('weight', kg, ideal(70)))).toEqual(['warn', 'ok', 'ok', 'warn', 'warn', 'bad', 'warn']);
    expect(valueStatus('weight', 70, ideal(undefined))).toBeNull();
  });

  it('waist: ok while the rounded ratio is under 0.5 (from 0.495), amber to 8 cm over half the height, red past it; none without a height', () => {
    const tall = (heightCm?: number) => ({ grading: {}, plan: { heightCm } });
    expect([89, 89.1, 98, 98.5].map((cm) => valueStatus('waist', cm, tall(180)))).toEqual(['ok', 'warn', 'warn', 'bad']);
    expect(valueStatus('waist', 90, tall(undefined))).toBeNull();
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

// US-12 AC20: a value printed as a limit is graded only when its bound decides, never by the bound
// itself (moved from the widget's blood-test-cell.ts with the merge of PR 615).
describe('savedStatus and limitUngraded: a limit is graded only when its bound decides (US-12 AC20)', () => {
  it('grades LDL <3 nothing and calls it ungraded, though 3 itself is amber', () => {
    expect(statusOf('ldl', 3, {})).toBe('warn');
    expect(savedStatus('ldl', 3, '<', {})).toBeNull();
    expect(limitUngraded('ldl', savedStatus('ldl', 3, '<', {}), { grading: {}, plan: null }, { value: 3, comparator: '<' })).toBe(true);
  });

  it('grades a limit whose bound decides: LDL >5 red, LDL <1 plain', () => {
    expect(savedStatus('ldl', 5, '>', {})).toBe('bad');
    expect(savedStatus('ldl', 1, '<', {})).toBe('ok');
    const adult = { grading: {}, plan: null };
    expect([limitUngraded('ldl', 'bad', adult, { value: 5, comparator: '>' }), limitUngraded('ldl', 'ok', adult, { value: 1, comparator: '<' })]).toEqual([false, false]);
  });

  it('grades an exact value as statusOf does, and passes the limit through valueStatus', () => {
    expect(savedStatus('ldl', 3, undefined, {})).toBe('warn');
    expect(limitUngraded('ldl', 'warn', { grading: {}, plan: null }, { value: 3 })).toBe(false);
    expect(valueStatus('ldl', 3, { grading: {}, plan: null }, '<')).toBeNull();
    expect(savedStatus('ldl', 5, '>', null)).toBeNull();
  });
});

// US-12 AC21 (Brad 2026-11-02, "grade only when certain"): a vital printed as a limit is graded only
// when every value the limit allows grades the same; otherwise no grade, and the limit note.
describe('vitals printed as a limit: graded only when certain (US-12 AC21)', () => {
  const ctx: GradeContext = { grading: {}, plan: { age: 50, idealBodyWeight: 70, heightCm: 180 } }; // BP target 120/80
  const bp = (r: PressureReading, c: GradeContext = ctx) => ({ grade: pressureStatus(r, c), note: limitUngraded('blood_pressure', pressureStatus(r, c), c, r) });

  it('blood pressure: "<125/78" could be on target or above, so no grade, and the note', () => {
    expect(bp({ value: 125, comparator: '<', dia: { value: 78 } })).toEqual({ grade: null, note: true });
  });

  it('blood pressure: the pair is the worse half, so a half certainly high makes it high whatever the other', () => {
    expect(bp({ value: 160, comparator: '>', dia: { value: 90, comparator: '<' } })).toEqual({ grade: 'bad', note: false });
    expect(bp({ value: 150, dia: { value: 90, comparator: '<' } })).toEqual({ grade: 'bad', note: false });
    expect(bp({ value: 160, comparator: '>', dia: { value: 78 } }).grade).toBe('bad');
  });

  it('blood pressure: certainly on target, or certainly amber, when every pair both bounds allow agrees', () => {
    expect(bp({ value: 110, comparator: '<', dia: { value: 70, comparator: '<' } }).grade).toBe('ok');
    expect(bp({ value: 110, comparator: '<=', dia: { value: 70, comparator: '<=' } }).grade).toBe('ok');
    expect(bp({ value: 125, dia: { value: 82, comparator: '<' } }).grade).toBe('warn');
    expect(bp({ value: 115, dia: { value: 82, comparator: '<' } })).toEqual({ grade: null, note: true });
  });

  it('blood pressure: a bound on a line, "<120" is under the target and "<=120" is not certainly', () => {
    expect(bp({ value: 120, comparator: '<', dia: { value: 70 } }).grade).toBe('ok');
    expect(bp({ value: 120, comparator: '<=', dia: { value: 70 } }).grade).toBeNull();
    expect(bp({ value: 130, comparator: '>=', dia: { value: 70 } }).grade).toBe('bad');
  });

  it('blood pressure: exact pairs as before; no note with no plan or for a known minor', () => {
    expect(bp({ value: 125, dia: { value: 78 } })).toEqual({ grade: 'warn', note: false });
    expect(bp({ value: 125, comparator: '<', dia: { value: 78 } }, { grading: null, plan: ctx.plan })).toEqual({ grade: null, note: false });
    expect(bp({ value: 125, comparator: '<', dia: { value: 78 } }, { grading: {}, plan: null })).toEqual({ grade: null, note: false });
  });

  // Codex R1 on PR 639: a fractional bound just past a line once read as certain (an epsilon nudge
  // crossed the line). Exact strict-vs-inclusive reasoning: each case's expected grade is what every
  // value the limit allows gets, checked by the samples below.
  it.each([
    // [label, reading, expected]: an adult of 50, target 120/80; 120 and 80 are amber, 130 and 85 red.
    ['"<120.00001/70": 120 itself is amber', { value: 120.00001, comparator: '<', dia: { value: 70 } }, null],
    ['"<119.99999/70"', { value: 119.99999, comparator: '<', dia: { value: 70 } }, 'ok'],
    ['"<120/70"', { value: 120, comparator: '<', dia: { value: 70 } }, 'ok'],
    ['"<=120/70": 120 itself is amber', { value: 120, comparator: '<=', dia: { value: 70 } }, null],
    ['"<=119.99999/70"', { value: 119.99999, comparator: '<=', dia: { value: 70 } }, 'ok'],
    ['">129.99999/70": 129.999995 is amber, 130 red', { value: 129.99999, comparator: '>', dia: { value: 70 } }, null],
    ['">=130/70"', { value: 130, comparator: '>=', dia: { value: 70 } }, 'bad'],
    ['">130.00001/70"', { value: 130.00001, comparator: '>', dia: { value: 70 } }, 'bad'],
    ['"110/<80.00001": 80 itself is amber', { value: 110, dia: { value: 80.00001, comparator: '<' } }, null],
    ['"110/<80"', { value: 110, dia: { value: 80, comparator: '<' } }, 'ok'],
    ['"110/<=80"', { value: 110, dia: { value: 80, comparator: '<=' } }, null],
    ['"110/>84.99999": 84.999995 is amber, 85 red', { value: 110, dia: { value: 84.99999, comparator: '>' } }, null],
    ['"110/>=85"', { value: 110, dia: { value: 85, comparator: '>=' } }, 'bad'],
  ] as const)('blood pressure on a line: %s', (_label, reading, expected) => {
    expect(pressureStatus(reading as PressureReading, ctx)).toBe(expected);
    // The samples: every value the limit allows near its bound, exact, grades as expected when certain.
    if (expected !== null) {
      const r = reading as PressureReading;
      const near = (v: number, c?: string) => !c ? [v] : c === '<' ? [v - 1e-9, v - 0.5] : c === '<=' ? [v, v - 0.5] : c === '>' ? [v + 1e-9, v + 0.5] : [v, v + 0.5];
      for (const sys of near(r.value, r.comparator)) for (const dia of near(r.dia!.value, r.dia!.comparator)) {
        expect(bpStatus(sys, dia, 120), `${sys}/${dia}`).toBe(expected);
      }
    }
  });

  it.each([
    // Weight, ideal 70: ok from 65 to 72 inclusive, amber to 75 inclusive and below 65, red past 75.
    ['weight "<65.00001": 65 itself is on target', 'weight', 65.00001, '<', null],
    ['weight "<65"', 'weight', 65, '<', 'warn'],
    ['weight "<=65": 65 itself is on target', 'weight', 65, '<=', null],
    ['weight ">74.99999": up to 75 amber, past it red', 'weight', 74.99999, '>', null],
    ['weight ">75"', 'weight', 75, '>', 'bad'],
    ['weight ">=75": 75 itself is amber', 'weight', 75, '>=', null],
    ['weight ">=75.00001"', 'weight', 75.00001, '>=', 'bad'],
    // Waist, 180 cm: healthy below 89.1 cm, amber to 98 inclusive, red past it.
    ['waist "<89.10001": 89.1 itself is elevated', 'waist', 89.10001, '<', null],
    ['waist "<89.1"', 'waist', 89.1, '<', 'ok'],
    ['waist "<=89.1": 89.1 itself is elevated', 'waist', 89.1, '<=', null],
    ['waist ">97.99999": up to 98 amber, past it red', 'waist', 97.99999, '>', null],
    ['waist ">98"', 'waist', 98, '>', 'bad'],
    ['waist ">=98": 98 itself is amber', 'waist', 98, '>=', null],
  ] as const)('%s', (_label, metric, bound, comparator, expected) => {
    expect(valueStatus(metric, bound, ctx, comparator)).toBe(expected);
  });

  it('weight: ">90" is certainly far over the ideal (70 kg), so red; ">70" could be on target or over, so none', () => {
    expect(valueStatus('weight', 90, ctx, '>')).toBe('bad');
    expect(valueStatus('weight', 70, ctx, '>')).toBeNull();
    expect(valueStatus('weight', 60, ctx, '<')).toBe('warn');
    expect(valueStatus('weight', 75, ctx, '>=')).toBeNull();
    expect(valueStatus('weight', 75.5, ctx, '>=')).toBe('bad');
    expect(limitUngraded('weight', null, ctx, { value: 70, comparator: '>' })).toBe(true);
    expect(limitUngraded('weight', 'bad', ctx, { value: 90, comparator: '>' })).toBe(false);
    expect(valueStatus('weight', 90, ctx)).toBe('bad');
  });

  it('weight: no ideal weight or a known minor, no grade and no note, as an exact value', () => {
    const noIdeal = { grading: {}, plan: { age: 50, heightCm: 180 } };
    expect([valueStatus('weight', 70, noIdeal, '>'), valueStatus('weight', 70, noIdeal)]).toEqual([null, null]);
    expect(limitUngraded('weight', null, noIdeal, { value: 70, comparator: '>' })).toBe(false);
    expect(limitUngraded('weight', null, { grading: null, plan: ctx.plan }, { value: 70, comparator: '>' })).toBe(false);
  });

  it('waist: a limit below the healthy line is certainly fine; one across it is open', () => {
    // 180 cm: elevated from 89.1 cm, red past 98 cm.
    expect(valueStatus('waist', 85, ctx, '<')).toBe('ok');
    expect(valueStatus('waist', 95, ctx, '<')).toBeNull();
    expect(valueStatus('waist', 100, ctx, '>')).toBe('bad');
    expect(limitUngraded('waist', null, ctx, { value: 95, comparator: '<' })).toBe(true);
  });

  it('LDL is unchanged: graded through savedStatus as before; a known minor says no note', () => {
    expect([valueStatus('ldl', 3, ctx, '<'), valueStatus('ldl', 5, ctx, '>'), valueStatus('ldl', 1, ctx, '<')]).toEqual([null, 'bad', 'ok']);
    expect(limitUngraded('ldl', null, ctx, { value: 3, comparator: '<' })).toBe(true);
    expect(limitUngraded('ldl', null, { grading: null, plan: ctx.plan }, { value: 3, comparator: '<' })).toBe(false);
  });
});
