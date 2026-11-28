/**
 * US-07 AC23 to AC27: plan cards state the published guideline first and label
 * where Dr Brad's view goes further. Doses, strengths and brand names leave card
 * faces; creatine, omega-3 and protein amounts stay. Each test reads the card
 * text a caller sees, per branch, at the branch's boundaries.
 */
import { describe, it, expect } from 'vitest';
import { generateSuggestions } from './suggestions';
import { calculateHealthResults, getBMICategory } from './calculations';
import { medicationForm } from './input-form';
import { lipidMarkerFor, weightMedicationTrigger } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { toCanonicalValue, type UnitSystem } from './units';
import type { HealthInputs, HealthResults, MedicationInputs, Suggestion } from './types';

const ldlMg = (mg: number) => toCanonicalValue('ldl', mg, 'conventional');
const hba1cPct = (pct: number) => toCanonicalValue('hba1c', pct, 'conventional');

/** The plan for a 40-year-old man, 175 cm, from raw inputs, as the widget computes it. */
const plan = (inputs: Partial<HealthInputs>, meds?: MedicationInputs, us: UnitSystem = 'si') =>
  calculateHealthResults({ heightCm: 175, sex: 'male', birthYear: 1986, ...inputs }, us, meds).suggestions;
const card = (cards: Suggestion[], id: string) => {
  const found = cards.find((s) => s.id === id);
  if (!found) throw new Error(`no card ${id}; have ${cards.map((s) => s.id).join(', ')}`);
  return found;
};

/** Hand-built results, for the weight bands' exact BMI boundaries. */
function weightPlan(bmi: number, inputs: Partial<HealthInputs> = {}, meds?: MedicationInputs, whr?: number) {
  const results: HealthResults = {
    heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], bmi,
    ...(whr !== undefined ? { waistToHeightRatio: whr } : {}),
  };
  results.bmiCategory = getBMICategory(bmi, results.waistToHeightRatio);
  return generateSuggestions({ heightCm: 175, sex: 'male', ...inputs }, results, 'si', meds);
}

describe('US-07 AC23: cholesterol cards', () => {
  it('L1: the target sentence labels Dr Brad\'s target, LDL-c as the very-high-risk goal, in both units', () => {
    const si = card(plan({ ldlC: 3.0 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description;
    expect(si.startsWith('Your LDL-c is 3.0 mmol/L. Guidelines set goals by heart risk. Dr Brad aims for below 1.4 mmol/L, the guideline goal for very high risk.')).toBe(true);
    const us = card(plan({ ldlC: ldlMg(116) }, { statin: { drug: 'none', dose: null } }, 'conventional'), 'med-statin').description;
    expect(us.startsWith('Your LDL-c is 116 mg/dL. Guidelines set goals by heart risk. Dr Brad aims for below 55 mg/dL, the guideline goal for very high risk.')).toBe(true);
    expect(si).not.toContain('treatment target');
  });

  it('L1: ApoB and non-HDL targets read lower than guideline goals', () => {
    const apob = card(plan({ apoB: 0.9 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description;
    expect(apob).toMatch(/^Your ApoB is 0\.90 g\/L\. Guidelines set goals by heart risk\. Dr Brad aims for below 0\.50 g\/L, lower than guideline goals\./);
    const nonHdl = card(plan({ totalCholesterol: 5.5, hdlC: 1.2 }, { statin: { drug: 'none', dose: null } }, 'conventional'), 'med-statin').description;
    expect(nonHdl).toMatch(/^Your non-HDL cholesterol is \d+ mg\/dL\. Guidelines set goals by heart risk\. Dr Brad aims for below 62 mg\/dL, lower than guideline goals\./);
  });

  it('L1: the form intro says the same sentence', () => {
    const inputs: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1986, ldlC: 3.0 };
    const results = calculateHealthResults(inputs, 'si', {});
    const [lipid] = medicationForm({ statin: { drug: 'none', dose: null } }, {
      lipidMarker: lipidMarkerFor(inputs, results), weightMedTrigger: weightMedicationTrigger(inputs, results), bmi: undefined,
      hasLipidInput: true, hasWeightInput: false, unitFor: () => 'si',
    });
    expect(lipid.intro)
      .toMatch(/^Your LDL-c is 3\.0 mmol\/L\. Guidelines set goals by heart risk\. Dr Brad aims for below 1\.4 mmol\/L/);
  });

  it('L2: the statin card names the guideline first and drops the dose', () => {
    const text = card(plan({ ldlC: 3.0 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description;
    expect(text).toContain('Guidelines name a statin first. Dr Brad suggests a low-dose statin, such as Rosuvastatin, then Ezetimibe before a higher dose. Consider discussing a statin with your doctor. If you are pregnant or planning a pregnancy, talk to your doctor before starting a statin.');
  });

  const ezetimibe = (drug: string, dose: number | null, extra: MedicationInputs = {}) =>
    card(plan({ ldlC: 3.0 }, { statin: { drug, dose }, ...extra }), 'med-ezetimibe').description;
  const BEFORE_TOP = 'The European guideline (ESC/EAS 2019) raises a statin to the highest tolerated dose before adding Ezetimibe. Dr Brad suggests discussing Ezetimibe with your doctor first.';
  const AT_TOP = 'Adding Ezetimibe is the next step for Dr Brad and for the European guideline (ESC/EAS 2019). Consider discussing it with your doctor.';

  it('L3 (b): Rosuvastatin 40 and Atorvastatin 80 (and a dose graded to them) read the shared next step', () => {
    expect(ezetimibe('rosuvastatin', 40)).toContain(AT_TOP);
    expect(ezetimibe('atorvastatin', 80)).toContain(AT_TOP);
    expect(ezetimibe('atorvastatin', 70)).toContain(AT_TOP);
  });

  it('L3 (a): below the top dose, other statins at their top, or no dose recorded', () => {
    expect(ezetimibe('rosuvastatin', 20)).toContain(BEFORE_TOP);
    expect(ezetimibe('atorvastatin', 40)).toContain(BEFORE_TOP);
    for (const [drug, dose] of [['simvastatin', 40], ['pravastatin', 40], ['pitavastatin', 4]] as const) expect(ezetimibe(drug, dose)).toContain(BEFORE_TOP);
    expect(ezetimibe('rosuvastatin', null)).toContain(BEFORE_TOP);
    expect(ezetimibe('rosuvastatin', 20)).toContain('Not studied enough in pregnancy');
  });

  it('L3 (c): statin not tolerated, after the PCSK9 inhibitor step', () => {
    expect(ezetimibe('not_tolerated', null, { pcsk9i: 'no' }))
      .toContain('When a statin is not tolerated, Dr Brad comes to Ezetimibe after a PCSK9 inhibitor. Consider discussing Ezetimibe with your doctor. Not studied enough in pregnancy');
  });

  it('L4, L6, L7: bempedoic acid without its brand; a higher dose; the switch card without "maximum"', () => {
    const bemp = card(plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'no', ezetimibe: 'no' }), 'med-bempedoic-acid').description;
    expect(bemp).toContain('Bempedoic acid lowers cholesterol by a different pathway than statins. Consider discussing it with your doctor. Not recommended in pregnancy');
    const inc = card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 10 }, ezetimibe: 'yes' }), 'med-statin-increase').description;
    expect(inc).toContain('Consider discussing a higher statin dose with your doctor. The FDA advises');
    const sw = card(plan({ ldlC: 3.0 }, { statin: { drug: 'pravastatin', dose: 40 }, ezetimibe: 'yes' }), 'med-statin-switch').description;
    expect(sw).toContain('You take the highest dose of Pravastatin this plan lists, or close to it. Consider discussing a more potent statin, such as Rosuvastatin, with your doctor.');
  });

  it('L5: dose cards, both arms, statin and GLP-1 (switch arm names Tirzepatide)', () => {
    const statinSwitch = card(plan({ ldlC: 3.0 }, { statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes' }), 'med-statin-dose').description;
    expect(statinSwitch).toContain('Your statin dose isn\'t recorded. The next option to discuss with your doctor, a higher dose or a more potent statin, depends on it. Add your dose to see which.');
    const statinTop = card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: null }, ezetimibe: 'yes' }), 'med-statin-dose').description;
    expect(statinTop).toContain('Your statin dose isn\'t recorded. Add it to see whether a higher dose is an option to discuss with your doctor.');
    const glp1 = card(weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: null } }), 'weight-med-glp1-dose').description;
    expect(glp1).toBe('Your GLP-1 dose isn\'t recorded. The next option to discuss with your doctor, a higher dose or Tirzepatide, depends on it. Add your dose to see which.');
    const glp1Top = card(weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: null } }), 'weight-med-glp1-dose').description;
    expect(glp1Top).toBe('Your GLP-1 dose isn\'t recorded. Add it to see whether a higher dose is an option to discuss with your doctor.');
  });

  it('L8: PCSK9 inhibitor, on a statin and with a statin not tolerated', () => {
    const on = card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes' }), 'med-pcsk9i').description;
    expect(on).toMatch(/1\.4 mmol\/L, the guideline goal for very high risk\. Consider discussing a PCSK9 inhibitor with your doctor\. Not studied/);
    const off = card(plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null } }), 'med-pcsk9i').description;
    expect(off).toContain('When a statin is not tolerated, Dr Brad suggests a PCSK9 inhibitor first. Consider discussing it with your doctor. Not studied enough in pregnancy');
  });

  it('L9: borderline cards, each marker, both units', () => {
    expect(card(plan({ apoB: 0.6 }), 'apob-borderline').description)
      .toBe('Your ApoB of 0.60 g/L is borderline against Dr Brad\'s target of below 0.50 g/L, which is lower than guideline goals.');
    expect(card(plan({ ldlC: ldlMg(140) }, undefined, 'conventional'), 'ldl-borderline').description)
      .toBe('Your LDL-c of 140 mg/dL is borderline high. Dr Brad aims for below 55 mg/dL, the guideline goal for very high risk.');
    expect(card(plan({ totalCholesterol: 5.6, hdlC: 1.2 }), 'non-hdl-borderline').description)
      .toMatch(/^Your non-HDL cholesterol of 4\.4 mmol\/L is borderline against Dr Brad's target of below 1\.6 mmol\/L, which is lower than guideline goals\.$/);
  });

  it('L10: very high cards', () => {
    expect(card(plan({ apoB: 1.5 }), 'apob-very-high').description).toContain('is very high. Levels like this carry a much higher heart risk.');
    expect(card(plan({ ldlC: ldlMg(200) }, undefined, 'conventional'), 'ldl-very-high').description)
      .toContain('Levels this high can be inherited (familial hypercholesterolemia); your doctor can check.');
    expect(card(plan({ totalCholesterol: 7.5, hdlC: 1.0 }), 'non-hdl-very-high').description).toContain('Levels like this carry a much higher heart risk.');
  });

  it('L11: the Lp(a) checklist says whose lipid target it shows, by marker', () => {
    expect(card(plan({ ldlC: 2.0, lpa: 200 }), 'lpa-elevated').description).toContain('The LDL-c target is Dr Brad\'s, the guideline goal for very high risk.');
    expect(card(plan({ apoB: 0.6, lpa: 200 }), 'lpa-elevated').description).toContain('The ApoB target is Dr Brad\'s, lower than guideline goals.');
    expect(card(plan({ lpa: 200 }), 'lpa-elevated').description).not.toContain('target is Dr Brad\'s');
  });
});

describe('US-07 AC24: weight and diabetes cards', () => {
  const glp1 = (bmi: number, inputs: Partial<HealthInputs> = {}, whr?: number) =>
    card(weightPlan(bmi, inputs, undefined, whr), 'weight-glp1').description;
  const highTg = { triglycerides: 2.0 };

  it('W1 (c): a diabetes-range HbA1c, at any BMI the trigger passes', () => {
    for (const bmi of [25, 26.9, 31]) {
      expect(glp1(bmi, { hba1c: 50 })).toBe(`With a BMI of ${bmi} and an HbA1c in the diabetes range: if type 2 diabetes is confirmed, Tirzepatide and Semaglutide are licensed for it at any BMI. Consider discussing them with your doctor, alongside diet, exercise and sleep.`);
    }
  });

  it('W1 (a): BMI 30 or more, or 27 or more with a raised blood marker', () => {
    expect(glp1(30)).toBe('With a BMI of 30, guidelines consider a weight medicine once lifestyle changes alone have not been enough. Dr Brad raises it from the start, alongside diet, exercise and sleep. Consider discussing Tirzepatide or Semaglutide with your doctor.');
    expect(glp1(27, highTg)).toMatch(/^With a BMI of 27 and elevated triglycerides, guidelines consider/);
    expect(glp1(27, { hba1c: hba1cPct(6.0) })).toMatch(/^With a BMI of 27 and an HbA1c in the prediabetes range, guidelines consider/);
  });

  it('W1 (b): below the guideline line, waist alone included', () => {
    const b = (who: string) => `Guidelines consider a weight medicine from a BMI of 30, or 27 with a weight-related condition. With ${who}, Dr Brad raises it earlier, alongside diet, exercise and sleep. A doctor may not prescribe below the licensed levels. Consider discussing Tirzepatide or Semaglutide with your doctor.`;
    expect(glp1(26.9, highTg)).toBe(b('a BMI of 26.9 and elevated triglycerides'));
    expect(glp1(29.9, {}, 0.55)).toBe(b('a BMI of 29.9 and elevated waist-to-height ratio'));
    expect(glp1(29.9)).toBe(b('a BMI of 29.9'));
    expect(glp1(28.1)).toBe(b('a BMI of 28.1'));
  });

  it('W1: the cascade\'s first card says the same; the old benefit line is gone', () => {
    const text = card(weightPlan(30, {}, {}), 'weight-med-glp1').description;
    expect(text).toBe(glp1(30));
    expect(text).not.toContain('support weight management');
  });

  it('W2: the form intro, by band', async () => {
    const { weightMedIntro } = await import('./suggestions');
    expect(weightMedIntro(26, ['an HbA1c in the diabetes range'])).toBe('At a BMI of 26 and an HbA1c in the diabetes range, diabetes and weight medicines are an option to discuss with your doctor.');
    expect(weightMedIntro(30, [])).toBe('At a BMI of 30, guidelines consider a weight medicine. It is an option to discuss with your doctor.');
    expect(weightMedIntro(29.9, ['elevated waist-to-height ratio'])).toBe('At a BMI of 29.9 and elevated waist-to-height ratio, Dr Brad raises weight medicines earlier than guidelines do. They are an option to discuss with your doctor.');
  });

  it('W3, W4: switch and increase cards, without brands', () => {
    const sw = card(weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: 2.4 } }), 'weight-med-glp1-switch').description;
    expect(sw).toBe('In a head-to-head trial, people lost more weight on Tirzepatide than on Semaglutide. Consider discussing switching to Tirzepatide with your doctor.');
    const inc = card(weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 5 } }), 'weight-med-glp1-increase').description;
    expect(inc).toBe('Consider discussing a higher dose of your GLP-1 medicine with your doctor, including its pros and cons.');
  });

  const onGlp1 = { glp1: { drug: 'tirzepatide', dose: 15 } } as MedicationInputs;
  it('W5: SGLT2 inhibitor, diabetes-range HbA1c or not', () => {
    expect(card(weightPlan(31, { hba1c: 50 }, onGlp1), 'weight-med-sglt2i').description)
      .toBe('If type 2 diabetes is confirmed, SGLT2 inhibitors are licensed for it, and they also protect the heart and kidneys in some people. Consider discussing one, such as Empagliflozin or Dapagliflozin, with your doctor.');
    for (const inputs of [{}, { hba1c: 40 }]) {
      expect(card(weightPlan(31, inputs, onGlp1), 'weight-med-sglt2i').description)
        .toBe('SGLT2 inhibitors are not licensed for weight loss, and guidelines advise against medicines for other conditions only to lose weight. Dr Brad includes them for heart and kidney benefits in some groups. Consider discussing one, such as Empagliflozin or Dapagliflozin, with your doctor.');
    }
  });

  it('W6: Metformin by HbA1c band, at the band lines', () => {
    const meds = { ...onGlp1, sglt2i: { drug: 'empagliflozin' } } as MedicationInputs;
    const met = (inputs: Partial<HealthInputs>) => card(weightPlan(31, inputs, meds), 'weight-med-metformin').description;
    expect(met({ hba1c: hba1cPct(6.5) })).toMatch(/^If type 2 diabetes is confirmed, Metformin is a long-used diabetes medicine\./);
    expect(met({ hba1c: hba1cPct(5.7) })).toBe('For prediabetes, diabetes guidelines consider Metformin for some people at high risk. In a large trial it cut the move to diabetes by about a third. Consider discussing it with your doctor.');
    expect(met({ hba1c: hba1cPct(6.4) })).toMatch(/^For prediabetes/);
    for (const inputs of [{}, { hba1c: hba1cPct(5.6) }]) {
      expect(met(inputs)).toBe('Guidelines advise against medicines for other conditions only to lose weight. Dr Brad includes Metformin as a later step. Extended-release forms may cause fewer stomach side effects. Consider discussing it with your doctor.');
    }
  });
});

describe('US-07 AC25: blood pressure cards', () => {
  const stage1 = (birthYear: number | undefined) => card(calculateHealthResults(
    { heightCm: 175, sex: 'male', ...(birthYear ? { birthYear } : {}), systolicBp: 135, diastolicBp: 82 }, 'si', undefined, undefined, undefined, new Date(Date.UTC(2026, 6, 1))).suggestions, 'bp-stage1').description;

  // B1 and B2 are held at their earlier words until the ACC/AHA 2025 goal wording is read in the guideline itself.
  it('B1, B2 (held): the stage 1 target and the measure card keep their earlier words', () => {
    expect(stage1(1962)).toContain('Consider discussing it with your doctor. Target is <120/80.\n\n');
    expect(stage1(1961)).toContain('Consider discussing it with your doctor. Target is <130/80.\n\n');
    const measure = card(calculateHealthResults({ heightCm: 175, sex: 'male', birthYear: 1962 }, 'si', undefined, undefined, undefined, new Date(Date.UTC(2026, 6, 1))).suggestions, 'measure-bp').description;
    expect(measure).toMatch(/Aim for below 120\/80 \(130\/80 if you're frail\)\.$/);
  });

  it('B3: the weight-medicine line in stage 1 and 2 cards', () => {
    const cards = plan({ weightKg: 95, systolicBp: 145, diastolicBp: 92 });
    expect(card(cards, 'bp-stage2').description).toContain('Even a 5% reduction can make a meaningful difference. GLP-1 medicines, such as Tirzepatide or Semaglutide, may also lower blood pressure. Consider discussing them with your doctor.');
  });
});

describe('US-07 AC26: protein card', () => {
  const protein = (eGFR?: number) => card(weightPlanProtein(eGFR), 'protein-target').description;
  function weightPlanProtein(eGFR?: number) {
    const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], ...(eGFR !== undefined ? { eGFR } : {}) };
    return generateSuggestions({ heightCm: 175, sex: 'male' }, results, 'si');
  }

  // P1 is held at its earlier words until the 0.8 g/kg allowance is read in the IOM text itself.
  it('P1 (held): eGFR 60 or more, or unknown', () => {
    for (const e of [undefined, 60, 90]) expect(protein(e)).toBe('Based on your ideal body weight of 73.8 kg, aim for 89g of protein daily. This supports muscle maintenance and metabolic health.');
  });
  it('P2: eGFR 45 to 59', () => {
    for (const e of [45, 59]) expect(protein(e)).toBe('With reduced kidney function, kidney guidelines (KDIGO 2024) suggest about 0.8 g of protein per kg of body weight a day. Dr Brad suggests 89g a day, from your ideal body weight of 73.8 kg. Discuss the right amount with your doctor.');
  });
  it('P2 needs an exact eGFR: one printed as a limit ("> 50") keeps P1\'s words (US-12 AC20)', () => {
    const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], eGFR: 50 };
    const limited: HealthInputs = { heightCm: 175, sex: 'male', limits: { labEgfr: { comparator: '>', bound: 50, graded: true } } };
    expect(card(generateSuggestions(limited, results, 'si'), 'protein-target').description).toMatch(/^Based on your ideal body weight of 73\.8 kg, aim for 89g of protein daily\./);
  });
  it('P3: eGFR below 45', () => {
    expect(protein(44)).toBe('With reduced kidney function, kidney guidelines (KDIGO 2024) suggest about 0.8 g of protein per kg of body weight a day. Dr Brad lowers his target to 89g a day, from your ideal body weight of 73.8 kg. Discuss the right amount with your doctor.');
  });
});

describe('US-07 AC27: colorectal order, skin, supplements, form', () => {
  it('S1, S2: the guideline\'s 45 comes before Dr Brad\'s 35', async () => {
    const start = card(calculateHealthResults({ heightCm: 175, sex: 'male', birthYear: 1986 }, 'si', undefined, {}).suggestions, 'screening-colorectal').description;
    expect(start).toBe('The American Cancer Society starts colorectal screening at 45. Dr Brad recommends starting at 35, because colorectal cancer has become more common in younger adults. He suggests a FIT test every year until 55, then a colonoscopy every 10 years. Discuss with your doctor.');
    const { screeningForm } = await import('./input-form');
    const note = screeningForm(40, 'male', {}).flatMap((s) => s.groups).find((g) => g.id === 'colorectal')!.notes[0];
    expect(note).toBe('The American Cancer Society starts screening at 45 for people at average risk. Starting at 35 is Dr Brad\'s recommendation, because colorectal cancer has become more common in younger adults. Discuss timing with your doctor.');
  });

  it('K1, K2: the retinoid card and its Sources line', () => {
    const cards = plan({});
    expect(card(cards, 'skin-retinoid').description).toBe('Consider discussing a topical retinoid, such as Adapalene or Tretinoin, with your doctor or pharmacist. Retinoids are well studied for skin texture and collagen, and are used at night with daily sunscreen. They must not be used during pregnancy. Tretinoin needs a prescription.');
    expect(SUGGESTION_EVIDENCE['skin-retinoid'].reason).toMatch(/^Retinoids \(vitamin A derivatives\) are a well-studied topical treatment for skin ageing\./);
  });

  it('K3, K4: omega-3 names Dr Brad, for adults; the multivitamin labels his view', () => {
    const cards = plan({});
    expect(card(cards, 'supplement-omega3').description).toContain('Dr Brad thinks it is reasonable for adults to consider up to 1 g a day');
    expect(card(cards, 'supplement-micronutrient-base').description)
      .toMatch(/Suggesting a daily multivitamin is Dr Brad's view; no guideline recommends one for everyone\. Whether it suits you is worth discussing/);
  });

  it('F1 to F3: form titles, the Ezetimibe label, step-up hints', async () => {
    const { MEDICATION_TEXT: T } = await import('./input-form');
    expect([T.lipidTitle, T.weightTitle, T.ezetimibeLabel]).toEqual(['Your cholesterol medications', 'Your weight & diabetes medications', 'On Ezetimibe?']);
    for (const hint of [T.statinEscalationHint.increase('LDL-c'), T.statinEscalationHint.switch('ApoB'), T.glp1EscalationHint.increase, T.glp1EscalationHint.switch]) {
      expect(hint.endsWith(' An option to discuss with your doctor.')).toBe(true);
    }
  });
});

describe('US-07 AC23 to AC27: no dose, strength or dropped brand on a card face', () => {
  const MEDICINE = 'Rosuvastatin|Atorvastatin|Simvastatin|Pravastatin|Pitavastatin|Ezetimibe|Bempedoic acid|Tirzepatide|Semaglutide|Dulaglutide|Empagliflozin|Dapagliflozin|Metformin|Adapalene|Tretinoin|statin';
  const DOSE = new RegExp(`\\b(?:${MEDICINE})\\b[^.]{0,12}?\\d+(?:\\.\\d+)?\\s*(?:mg|%)`, 'i');
  const BRANDS = /Nexletol|Nexlizet|Mounjaro|Zepbound|Ozempic|Wegovy/;
  // The person's own recorded statin, in the Lp(a) checklist, is their record, not a suggested dose.
  const faces = (cards: Suggestion[]) => cards.map((s) => `${s.title}\n${s.description.split('\n').filter((l) => !l.startsWith('✅ Statin:')).join('\n')}`);
  const scenarios: Suggestion[][] = [
    plan({ ldlC: 3.0, lpa: 200, weightKg: 95, systolicBp: 135, diastolicBp: 85 }, { statin: { drug: 'none', dose: null } }),
    plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 20 } }),
    plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes' }),
    plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'no', ezetimibe: 'no' }),
    plan({ ldlC: 3.0 }, { statin: { drug: 'pravastatin', dose: 40 }, ezetimibe: 'yes' }),
    weightPlan(31, { hba1c: 50 }, { glp1: { drug: 'semaglutide_injection', dose: 2.4 } }),
    weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 15 } }),
    weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 15 }, sglt2i: { drug: 'empagliflozin' } } as MedicationInputs),
  ];

  it('no medicine dose or strength, no dropped brand name', () => {
    for (const face of scenarios.flatMap(faces)) {
      expect(face).not.toMatch(DOSE);
      expect(face).not.toMatch(BRANDS);
    }
  });

  it('creatine, omega-3 and protein amounts stay', () => {
    const cards = scenarios[0];
    expect(card(cards, 'supplement-creatine').description).toContain('creatine (3–5 g/day)');
    expect(card(cards, 'supplement-omega3').description).toContain('up to 1 g a day of EPA and DHA');
    expect(card(cards, 'protein-target').description).toMatch(/\d+g of protein daily/);
  });

  it('the dose pattern would catch the words it replaced', () => {
    expect('Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.').toMatch(DOSE);
    expect('A topical retinoid (Adapalene 0.3% or Tretinoin 0.05%)').toMatch(DOSE);
    expect('Discuss adding Ezetimibe 10mg with your doctor.').toMatch(DOSE);
  });
});
