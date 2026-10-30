/**
 * Exact cut-offs in generateSuggestions, taken from health_roadmap_algorithm.md
 * (mutation-testing trial, 2026-10-30). Each threshold is tested AT the line
 * and just below it, with the expected side read from the doc. Lipid lines are
 * the doc's mg/dL values converted with the doc's factors (§2: cholesterol
 * 38.67, triglycerides 88.57, ApoB 100); HbA1c lines use the doc's NGSP→IFCC
 * formula. Screening due dates are local month starts (doc §8), so the fake
 * clock is set with the local Date constructor and holds in any TZ.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateSuggestions } from './suggestions';
import { getBMICategory } from './calculations';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs, Suggestion } from './types';

const chol = (mgdl: number) => mgdl / 38.67;
const trig = (mgdl: number) => mgdl / 88.57;
const apoB = (mgdl: number) => mgdl / 100;
const ifcc = (ngsp: number) => (ngsp - 2.152) / 0.09148;
const BELOW = 0.001; // just under a line, in the canonical unit

function plan(
  inputs: Partial<HealthInputs> = {},
  results: Partial<HealthResults> = {},
  medications?: MedicationInputs,
  screenings?: ScreeningInputs,
): Suggestion[] {
  const r: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], ...results };
  if (r.bmi !== undefined && r.bmiCategory === undefined) r.bmiCategory = getBMICategory(r.bmi, r.waistToHeightRatio);
  return generateSuggestions({ heightCm: 175, sex: 'male', ...inputs }, r, 'si', medications, screenings);
}
const ids = (s: Suggestion[]) => s.map((x) => x.id);
const byId = (s: Suggestion[], id: string) => s.find((x) => x.id === id);
/** The ids of a family (e.g. 'ldl-'), so "none of them" is checked too. */
const family = (s: Suggestion[], prefix: string) => ids(s).filter((id) => id.startsWith(prefix));

describe('US-07 AC1: lipid tiers at each exact line (doc §3, §4)', () => {
  it('LDL (only marker): 130 borderline, 160 high, 190 very high; just below each drops a tier', () => {
    const ldl = (v: number) => family(plan({ ldlC: v }), 'ldl-');
    expect(ldl(chol(130) - BELOW)).toEqual([]);
    expect(ldl(chol(130))).toEqual(['ldl-borderline']);
    expect(ldl(chol(160) - BELOW)).toEqual(['ldl-borderline']);
    expect(ldl(chol(160))).toEqual(['ldl-high']);
    expect(ldl(chol(190) - BELOW)).toEqual(['ldl-high']);
    expect(ldl(chol(190))).toEqual(['ldl-very-high']);
  });

  it('ApoB: 50 borderline, 70 high, 100 very high mg/dL', () => {
    const ab = (v: number) => family(plan({ apoB: v }), 'apob-');
    expect(ab(apoB(50) - BELOW)).toEqual([]);
    expect(ab(apoB(50))).toEqual(['apob-borderline']);
    expect(ab(apoB(70) - BELOW)).toEqual(['apob-borderline']);
    expect(ab(apoB(70))).toEqual(['apob-high']);
    expect(ab(apoB(100) - BELOW)).toEqual(['apob-high']);
    expect(ab(apoB(100))).toEqual(['apob-very-high']);
  });

  it('non-HDL: 160 borderline, 190 high, 220 very high mg/dL', () => {
    const nh = (v: number) => family(plan({}, { nonHdlCholesterol: v }), 'non-hdl-');
    expect(nh(chol(160) - BELOW)).toEqual([]);
    expect(nh(chol(160))).toEqual(['non-hdl-borderline']);
    expect(nh(chol(190) - BELOW)).toEqual(['non-hdl-borderline']);
    expect(nh(chol(190))).toEqual(['non-hdl-high']);
    expect(nh(chol(220) - BELOW)).toEqual(['non-hdl-high']);
    expect(nh(chol(220))).toEqual(['non-hdl-very-high']);
  });

  it('a high atherogenic card suppresses total cholesterol; a borderline one does not (doc §4)', () => {
    const tc = chol(250);
    expect(family(plan({ ldlC: chol(160), totalCholesterol: tc }), 'total-chol-')).toEqual([]);
    expect(family(plan({ apoB: apoB(70), totalCholesterol: tc }), 'total-chol-')).toEqual([]);
    expect(family(plan({ totalCholesterol: tc }, { nonHdlCholesterol: chol(190) }), 'total-chol-')).toEqual([]);
    expect(family(plan({ ldlC: chol(190), totalCholesterol: tc }), 'total-chol-')).toEqual([]);
    expect(family(plan({ apoB: apoB(100), totalCholesterol: tc }), 'total-chol-')).toEqual([]);
    expect(family(plan({ ldlC: chol(130), totalCholesterol: tc }), 'total-chol-')).toEqual(['total-chol-high']);
  });

  it('total cholesterol: 200 borderline, 240 high mg/dL', () => {
    const t = (v: number) => family(plan({ totalCholesterol: v }), 'total-chol-');
    expect(t(chol(200) - BELOW)).toEqual([]);
    expect(t(chol(200))).toEqual(['total-chol-borderline']);
    expect(t(chol(240) - BELOW)).toEqual(['total-chol-borderline']);
    expect(t(chol(240))).toEqual(['total-chol-high']);
  });

  it('triglycerides: trig-nutrition and reduce-alcohol from 150 mg/dL; trig-very-high (urgent) from 500', () => {
    const at150 = plan({ triglycerides: trig(150) });
    expect(ids(at150)).toEqual(expect.arrayContaining(['trig-nutrition', 'reduce-alcohol']));
    const below150 = ids(plan({ triglycerides: trig(150) - BELOW }));
    expect(below150).not.toContain('trig-nutrition');
    expect(below150).not.toContain('reduce-alcohol');
    expect(ids(plan({ triglycerides: trig(500) - BELOW }))).not.toContain('trig-very-high');
    expect(byId(plan({ triglycerides: trig(500) }), 'trig-very-high')?.priority).toBe('urgent');
  });

  it('HDL low: men below 40 mg/dL, women below 50; the line itself is not low, and the text names the sex', () => {
    expect(ids(plan({ sex: 'male', hdlC: chol(40) }))).not.toContain('hdl-low');
    expect(byId(plan({ sex: 'male', hdlC: chol(40) - BELOW }), 'hdl-low')?.description).toContain('for men');
    expect(ids(plan({ sex: 'female', hdlC: chol(50) }))).not.toContain('hdl-low');
    const female = byId(plan({ sex: 'female', hdlC: chol(50) - BELOW }), 'hdl-low');
    expect(female?.priority).toBe('attention');
    expect(female?.description).toContain('for women');
    // A woman's 45 mg/dL is low; a man's is not.
    expect(ids(plan({ sex: 'female', hdlC: chol(45) }))).toContain('hdl-low');
    expect(ids(plan({ sex: 'male', hdlC: chol(45) }))).not.toContain('hdl-low');
  });
});

describe('US-07 AC1: HbA1c tiers at 5.7% and 6.5% (doc §4 HbA1c Tiers, >=)', () => {
  const tier = (v: number) => family(plan({ hba1c: v }), 'hba1c-');
  it('6.5% is diabetic (urgent); just below is prediabetic', () => {
    expect(tier(ifcc(6.5))).toEqual(['hba1c-diabetic']);
    expect(byId(plan({ hba1c: ifcc(6.5) }), 'hba1c-diabetic')?.priority).toBe('urgent');
    expect(tier(ifcc(6.5) - BELOW)).toEqual(['hba1c-prediabetic']);
  });
  it('5.7% is prediabetic; just below is normal', () => {
    expect(tier(ifcc(5.7))).toEqual(['hba1c-prediabetic']);
    expect(tier(ifcc(5.7) - BELOW)).toEqual(['hba1c-normal']);
  });
});

describe('US-07 AC1: blood-pressure stages (doc §3 and §4 BP Tiers)', () => {
  const bp = (sys: number, dia: number, age = 40) => family(plan({ systolicBp: sys, diastolicBp: dia }, { age }), 'bp-');

  it('stage 1: systolic 130 or diastolic over 80; 129/80 is neither', () => {
    expect(bp(129, 80)).toEqual([]);
    expect(bp(130, 70)).toEqual(['bp-stage1']);
    expect(bp(120, 81)).toEqual(['bp-stage1']);
  });

  it('stage 2: systolic 140 or diastolic 90, either alone', () => {
    expect(bp(139, 89)).toEqual(['bp-stage1']);
    expect(bp(140, 70)).toEqual(['bp-stage2']);
    expect(bp(120, 90)).toEqual(['bp-stage2']);
  });

  it('crisis: systolic 180 or diastolic 120, either alone, is urgent', () => {
    expect(bp(179, 119)).toEqual(['bp-stage2']);
    expect(bp(180, 70)).toEqual(['bp-crisis']);
    expect(bp(110, 120)).toEqual(['bp-crisis']);
    expect(byId(plan({ systolicBp: 110, diastolicBp: 120 }), 'bp-crisis')?.priority).toBe('urgent');
  });

  it('a stage card needs both halves to show (doc §3)', () => {
    expect(family(plan({ systolicBp: 190 }), 'bp-')).toEqual([]);
    expect(family(plan({ diastolicBp: 125 }), 'bp-')).toEqual([]);
  });

  it('the stage card names the age-dependent target: <120/80 at 64, <130/80 at 65', () => {
    expect(byId(plan({ systolicBp: 135, diastolicBp: 70 }, { age: 64 }), 'bp-stage1')?.description).toContain('Target is <120/80');
    expect(byId(plan({ systolicBp: 135, diastolicBp: 70 }, { age: 65 }), 'bp-stage1')?.description).toContain('Target is <130/80');
  });

  it('the potassium paragraph needs eGFR 45 or more (doc §4)', () => {
    const desc = (eGFR: number) => byId(plan({ systolicBp: 135, diastolicBp: 70 }, { eGFR }), 'bp-stage1')!.description;
    expect(desc(45)).toContain('potassium');
    expect(desc(44)).not.toContain('potassium');
    expect(byId(plan({ systolicBp: 135, diastolicBp: 70 }), 'bp-stage1')!.description).not.toContain('potassium');
  });
});

describe('US-07 AC1: conditional lifestyle cards at their lines (doc §4)', () => {
  it('high-potassium from eGFR 45; not at 44 or with no eGFR', () => {
    expect(ids(plan({}, { eGFR: 45 }))).toContain('high-potassium');
    expect(ids(plan({}, { eGFR: 44 }))).not.toContain('high-potassium');
    expect(ids(plan({}, {}))).not.toContain('high-potassium');
  });

  it('low-salt: systolic over 120 under 65, over 130 at 65', () => {
    const salt = (sys: number, age: number) => ids(plan({ systolicBp: sys }, { age })).includes('low-salt');
    expect(salt(120, 64)).toBe(false);
    expect(salt(121, 64)).toBe(true);
    expect(salt(130, 65)).toBe(false);
    expect(salt(131, 65)).toBe(true);
  });

  it('reduce-alcohol: BMI 30 alone; BMI 25 or more with WHtR 0.5; not BMI 24.9', () => {
    const alc = (bmi: number, waistToHeightRatio?: number) => ids(plan({}, { bmi, waistToHeightRatio })).includes('reduce-alcohol');
    expect(alc(29.9)).toBe(false);
    expect(alc(30)).toBe(true);
    expect(alc(25, 0.5)).toBe(true);
    expect(alc(24.9, 0.5)).toBe(false);
    expect(alc(25.1, 0.5)).toBe(true);
    expect(alc(25.1, 0.49)).toBe(false);
  });

  it('measure-waist: BMI 25.1 to 29.9 with no waist; not at 30, not with a waist', () => {
    const waist = (bmi: number, waistToHeightRatio?: number) => ids(plan({}, { bmi, waistToHeightRatio })).includes('measure-waist');
    expect(waist(25.1)).toBe(true);
    expect(waist(29.9)).toBe(true);
    expect(waist(30)).toBe(false);
    expect(waist(27, 0.45)).toBe(false);
  });

  it('measure-waist at exactly BMI 25.0 with no waist (doc §1: 25.0–29.9, unknown WHtR → prompt)', () => {
    expect(ids(plan({}, { bmi: 25 }))).toContain('measure-waist');
  });
});

describe('US-07 AC1a: the elevated Lp(a) checklist grades each factor at its target (doc §4 Lp(a))', () => {
  const LPA = 130; // nmol/L, elevated
  const checklist = (inputs: Partial<HealthInputs>, results: Partial<HealthResults> = {}, meds?: MedicationInputs) =>
    byId(plan({ lpa: LPA, ...inputs }, results, meds), 'lpa-elevated')!.description.split('Your modifiable risk factors:\n')[1].split('\n');
  const line = (lines: string[], label: string) => lines.find((l) => l.includes(label));

  it('blood pressure: on target only below the age target AND below 80 diastolic', () => {
    expect(line(checklist({ systolicBp: 119, diastolicBp: 79 }), 'Blood pressure')).toMatch(/^✅/);
    expect(line(checklist({ systolicBp: 120, diastolicBp: 79 }), 'Blood pressure')).toMatch(/^⚠/);
    expect(line(checklist({ systolicBp: 119, diastolicBp: 80 }), 'Blood pressure')).toMatch(/^⚠/);
    expect(line(checklist({ systolicBp: 129, diastolicBp: 79 }, { age: 65 }), 'Blood pressure')).toMatch(/^✅/);
    expect(line(checklist({ systolicBp: 130, diastolicBp: 79 }, { age: 65 }), 'Blood pressure')).toMatch(/^⚠/);
    expect(line(checklist({ systolicBp: 119 }), 'Blood pressure')).toBe('❓ Blood pressure — not entered');
  });

  it('BMI: below 25, or 25–29.9 with WHtR under 0.5; no BMI, no line', () => {
    expect(line(checklist({}, { bmi: 24.9 }), 'BMI')).toMatch(/^✅/);
    expect(line(checklist({}, { bmi: 25 }), 'BMI')).toMatch(/^⚠/);
    expect(line(checklist({}, { bmi: 29.9, waistToHeightRatio: 0.49 }), 'BMI')).toMatch(/^✅/);
    expect(line(checklist({}, { bmi: 29.9, waistToHeightRatio: 0.5 }), 'BMI')).toMatch(/^⚠/);
    expect(line(checklist({}, { bmi: 30, waistToHeightRatio: 0.4 }), 'BMI')).toMatch(/^⚠/);
    expect(line(checklist({}), 'BMI')).toBeUndefined();
  });

  it('HbA1c: on target below 5.7%; at 5.7% it is not', () => {
    expect(line(checklist({ hba1c: ifcc(5.7) - BELOW }), 'HbA1c')).toMatch(/^✅ HbA1c: /);
    expect(line(checklist({ hba1c: ifcc(5.7) }), 'HbA1c')).toMatch(/^⚠️ HbA1c: /);
    expect(line(checklist({}), 'HbA1c')).toBe('❓ HbA1c — not tested');
  });

  it('with nothing entered the list is exactly the three unknowns', () => {
    expect(checklist({})).toEqual([
      '❓ Lipids — not tested (consider getting ApoB or a lipid panel)',
      '❓ Blood pressure — not entered',
      '❓ HbA1c — not tested',
    ]);
  });

  it('a statin and a PCSK9 inhibitor not tolerated read "not tolerated", with no "not started" line', () => {
    const lines = checklist({}, {}, { statin: { drug: 'not_tolerated', dose: null }, ezetimibe: 'yes', pcsk9i: 'not_tolerated' });
    expect(lines).toContain('⚠️ Statin: not tolerated');
    expect(lines).toContain('⚠️ PCSK9 inhibitor: not tolerated');
    expect(lines).toContain('✅ Ezetimibe: taking');
    expect(lines.filter((l) => l.includes('not started'))).toEqual([]);
  });

  it('a statin taken shows its name and dose', () => {
    const lines = checklist({}, {}, { statin: { drug: 'atorvastatin', dose: 40 } });
    expect(lines).toContain('✅ Statin: Atorvastatin 40mg');
  });
});

describe('US-07 AC1: PSA is elevated only above 4.0 ng/mL (doc §8: "PSA > 4.0")', () => {
  const psa = (v: number) => ids(plan({}, { age: 55 }, undefined, { prostateDiscussion: 'will_screen', prostatePsaValue: v }));
  it('4.0 is not elevated; 4.01 is', () => {
    expect(psa(4.0)).not.toContain('screening-prostate-elevated');
    expect(psa(4.01)).toContain('screening-prostate-elevated');
  });
});

describe('US-06, US-07 AC1: screening eligibility at each age gate, one year either side (doc §8)', () => {
  const has = (sex: 'male' | 'female', age: number, id: string, scr: ScreeningInputs = {}) =>
    ids(plan({ sex }, { age }, undefined, scr)).includes(id);

  it('colorectal: 35 to 75, both sexes', () => {
    expect([34, 35, 75, 76].map((a) => has('male', a, 'screening-colorectal'))).toEqual([false, true, true, false]);
    expect(has('female', 35, 'screening-colorectal')).toBe(true);
  });

  it('breast: women from 40; 40–44 optional (info), 45+ recommended (attention); never men', () => {
    expect([39, 40].map((a) => has('female', a, 'screening-breast'))).toEqual([false, true]);
    const pri = (age: number) => byId(plan({ sex: 'female' }, { age }, undefined, {}), 'screening-breast')?.priority;
    expect([40, 44, 45].map(pri)).toEqual(['info', 'info', 'attention']);
    const text = (age: number) => byId(plan({ sex: 'female' }, { age }, undefined, {}), 'screening-breast')!.description;
    expect(text(44)).toContain('optional');
    expect(text(45)).not.toContain('optional');
    expect(has('male', 50, 'screening-breast')).toBe(false);
    expect(has('female', 45, 'screening-breast', { breastFrequency: 'not_yet_started' })).toBe(true);
  });

  it('cervical: women 25 to 65; never men', () => {
    expect([24, 25, 65, 66].map((a) => has('female', a, 'screening-cervical'))).toEqual([false, true, true, false]);
    expect(has('male', 30, 'screening-cervical')).toBe(false);
    expect(has('female', 30, 'screening-cervical', { cervicalMethod: 'not_yet_started' })).toBe(true);
  });

  it('lung: 50 to 80, former or current smoker, 15+ pack-years', () => {
    const smoker: ScreeningInputs = { lungSmokingHistory: 'former_smoker', lungPackYears: 15 };
    expect([49, 50, 80, 81].map((a) => has('male', a, 'screening-lung', smoker))).toEqual([false, true, true, false]);
    expect(has('female', 60, 'screening-lung', { lungSmokingHistory: 'current_smoker', lungPackYears: 15 })).toBe(true);
    expect(has('male', 60, 'screening-lung', { lungSmokingHistory: 'former_smoker', lungPackYears: 14 })).toBe(false);
    expect(has('male', 60, 'screening-lung', { lungSmokingHistory: 'former_smoker' })).toBe(false);
    expect(has('male', 60, 'screening-lung', { lungSmokingHistory: 'never_smoked', lungPackYears: 30 })).toBe(false);
    expect(has('male', 60, 'screening-lung', { lungPackYears: 30 })).toBe(false);
    expect(has('male', 60, 'screening-lung', { ...smoker, lungScreening: 'not_yet_started' })).toBe(true);
  });

  it('prostate: men from 45 (shared decision); never women; "not yet" still asks', () => {
    expect([44, 45].map((a) => has('male', a, 'screening-prostate'))).toEqual([false, true]);
    expect(has('female', 50, 'screening-prostate')).toBe(false);
    expect(has('male', 50, 'screening-prostate', { prostateDiscussion: 'not_yet' })).toBe(true);
    expect(family(plan({}, { age: 50 }, undefined, { prostateDiscussion: 'elected_not_to' }), 'screening-prostate')).toEqual([]);
    // Elected not to: no card even with an old PSA date on record.
    expect(family(plan({}, { age: 50 }, undefined, { prostateDiscussion: 'elected_not_to', prostateLastDate: '2020-01' }), 'screening-prostate')).toEqual([]);
    expect(family(plan({}, { age: 50 }, undefined, { prostateDiscussion: 'will_screen', prostateLastDate: '2020-01' }), 'screening-prostate')).toEqual(['screening-prostate-overdue']);
  });

  it('endometrial: women from 45; the bleeding card is urgent and never for men', () => {
    expect([44, 45].map((a) => has('female', a, 'screening-endometrial'))).toEqual([false, true]);
    expect(has('female', 50, 'screening-endometrial', { endometrialDiscussion: 'not_yet' })).toBe(true);
    expect(has('female', 50, 'screening-endometrial', { endometrialDiscussion: 'discussed' })).toBe(false);
    const bleed: ScreeningInputs = { endometrialAbnormalBleeding: 'yes_need_to_report' };
    expect([44, 45].map((a) => has('female', a, 'screening-endometrial-bleeding', bleed))).toEqual([false, true]);
    expect(byId(plan({ sex: 'female' }, { age: 45 }, undefined, bleed), 'screening-endometrial-bleeding')?.priority).toBe('urgent');
    expect(has('male', 50, 'screening-endometrial-bleeding', bleed)).toBe(false);
    expect(has('female', 50, 'screening-endometrial-bleeding')).toBe(false);
    expect(has('female', 50, 'screening-endometrial-bleeding', { endometrialAbnormalBleeding: 'yes_reported' })).toBe(false);
    expect(has('male', 50, 'screening-endometrial')).toBe(false);
  });

  it('DEXA: women from 50, men from 70', () => {
    expect([49, 50].map((a) => has('female', a, 'screening-dexa'))).toEqual([false, true]);
    expect([69, 70].map((a) => has('male', a, 'screening-dexa'))).toEqual([false, true]);
  });
});

describe('US-06, US-07 AC1: overdue only AFTER the due instant (doc §8: overdue = now > nextDue)', () => {
  afterEach(() => vi.useRealTimers());
  /** Fake "now" at a local instant: due dates are local month starts. */
  const at = (y: number, m0: number, ms = 0) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(y, m0, 1).getTime() + ms));
  };
  const screening = (sex: 'male' | 'female', age: number, scr: ScreeningInputs) =>
    plan({ sex }, { age }, undefined, scr).filter((s) => s.category === 'screening');

  it('colorectal FIT, last Jan 2026: due Jan 2027; on the instant upcoming, 1 ms later overdue', () => {
    const scr: ScreeningInputs = { colorectalMethod: 'fit_annual', colorectalLastDate: '2026-01' };
    at(2027, 0);
    const up = byId(screening('male', 50, scr), 'screening-colorectal-upcoming');
    expect(up?.priority).toBe('info');
    expect(up?.description).toContain('Jan 2027');
    at(2027, 0, 1);
    const over = byId(screening('male', 50, scr), 'screening-colorectal-overdue');
    expect(over?.priority).toBe('attention');
    expect(over?.description).toContain('Jan 2027');
  });

  it('breast biennial and lung LDCT: up to date before the due month, overdue after', () => {
    const breast: ScreeningInputs = { breastFrequency: 'biennial', breastLastDate: '2025-03', breastResult: 'normal' };
    at(2027, 2);
    expect(ids(screening('female', 50, breast))).toContain('screening-breast-upcoming');
    expect(byId(screening('female', 50, breast), 'screening-breast-upcoming')?.description).toContain('Mar 2027');
    at(2027, 2, 1);
    expect(ids(screening('female', 50, breast))).toContain('screening-breast-overdue');

    const lung: ScreeningInputs = { lungSmokingHistory: 'current_smoker', lungPackYears: 20, lungScreening: 'annual_ldct', lungLastDate: '2026-06', lungResult: 'normal' };
    at(2027, 5);
    expect(ids(screening('male', 60, lung))).toContain('screening-lung-upcoming');
    at(2027, 5, 1);
    expect(byId(screening('male', 60, lung), 'screening-lung-overdue')?.priority).toBe('attention');
  });

  it('prostate will_screen with a last PSA: yearly, up to date then overdue', () => {
    const scr: ScreeningInputs = { prostateDiscussion: 'will_screen', prostateLastDate: '2026-04' };
    at(2027, 3);
    expect(byId(screening('male', 55, scr), 'screening-prostate-upcoming')?.description).toContain('Apr 2027');
    at(2027, 3, 1);
    expect(ids(screening('male', 55, scr))).toContain('screening-prostate-overdue');
    // will_screen with no last date: nothing to grade, and no discussion card either.
    expect(family(screening('male', 55, { prostateDiscussion: 'will_screen' }), 'screening-prostate')).toEqual([]);
  });

  it('a last date with no month has no due date: no overdue or upcoming card', () => {
    at(2030, 0);
    expect(family(screening('male', 50, { colorectalMethod: 'fit_annual', colorectalLastDate: '2026' }), 'screening-colorectal')).toEqual([]);
    expect(family(screening('male', 50, { colorectalMethod: 'fit_annual', colorectalLastDate: '2026-01' }), 'screening-colorectal')).toEqual(['screening-colorectal-overdue']);
  });

  it('post-follow-up interval: breast biennial resumes at 24 months, judged at the exact instant', () => {
    const scr: ScreeningInputs = {
      breastFrequency: 'biennial', breastLastDate: '2025-06', breastResult: 'abnormal',
      breastFollowupStatus: 'completed', breastFollowupDate: '2026-01',
    };
    at(2028, 0);
    const up = byId(screening('female', 50, scr), 'screening-breast-followup');
    expect(up?.priority).toBe('info');
    expect(up?.title).toBe('Breast screening up to date');
    expect(up?.description).toContain('Jan 2028');
    at(2028, 0, 1);
    const over = byId(screening('female', 50, scr), 'screening-breast-followup');
    expect(over?.priority).toBe('attention');
    expect(over?.title).toBe('Breast screening overdue');
  });

  it('a scheduled follow-up names its screening; a completed one with no date falls back to the normal interval', () => {
    at(2026, 9);
    const scheduled = byId(screening('female', 50, { breastFrequency: 'annual', breastLastDate: '2026-06', breastResult: 'abnormal', breastFollowupStatus: 'scheduled' }), 'screening-breast-followup');
    expect(scheduled?.title).toBe('Breast follow-up scheduled');
    expect(scheduled?.priority).toBe('info');
    const noDate = screening('female', 50, { breastFrequency: 'annual', breastLastDate: '2026-06', breastResult: 'abnormal', breastFollowupStatus: 'completed' });
    expect(family(noDate, 'screening-breast')).toEqual(['screening-breast-upcoming']);
  });

  it('DEXA: osteopenia repeats at 2 years, normal at 5; awaiting a result asks for nothing', () => {
    at(2026, 5);
    const dexa = (scr: ScreeningInputs) => family(screening('female', 60, { dexaScreening: 'dexa_scan', dexaLastDate: '2024-01', ...scr }), 'screening-dexa');
    expect(dexa({ dexaResult: 'osteopenia' })).toEqual(['screening-dexa-overdue']);
    expect(dexa({ dexaResult: 'normal' })).toEqual(['screening-dexa-upcoming']);
    expect(dexa({ dexaResult: 'awaiting' })).toEqual([]);
  });
});
