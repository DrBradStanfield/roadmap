/**
 * US-07 AC23 to AC27: plan cards state the published guideline first and label
 * where Dr Brad's view goes further; doses, strengths and brand names leave the
 * faces of the cards this change words. Cards whose wording is pending keep
 * their earlier words, pinned here. Each test reads the card text a caller sees.
 */
import { describe, it, expect } from 'vitest';
import { generateSuggestions, weightMedIntro } from './suggestions';
import { calculateHealthResults, getBMICategory } from './calculations';
import { MEDICATION_TEXT, medicationForm, screeningForm } from './input-form';
import { lipidMarkerFor, weightMedicationTrigger } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { toCanonicalValue, type UnitSystem } from './units';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs, Suggestion } from './types';

const ldlMg = (mg: number) => toCanonicalValue('ldl', mg, 'conventional');
const NOW = new Date(Date.UTC(2026, 6, 1, 12));

/** The plan for a 40-year-old man, 175 cm, from raw inputs, as the widget computes it. */
const plan = (inputs: Partial<HealthInputs>, meds?: MedicationInputs, us: UnitSystem = 'si', scr?: ScreeningInputs) =>
  calculateHealthResults({ heightCm: 175, sex: 'male', birthYear: 1986, ...inputs }, us, meds, scr, undefined, NOW).suggestions;
const card = (cards: Suggestion[], id: string) => {
  const found = cards.find((s) => s.id === id);
  if (!found) throw new Error(`no card ${id}; have ${cards.map((s) => s.id).join(', ')}`);
  return found;
};

/** Hand-built results, for exact BMI values. */
function weightPlan(bmi: number, inputs: Partial<HealthInputs> = {}, meds?: MedicationInputs) {
  const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age: 40, suggestions: [], bmi };
  results.bmiCategory = getBMICategory(bmi, results.waistToHeightRatio);
  return generateSuggestions({ heightCm: 175, sex: 'male', ...inputs }, results, 'si', meds);
}

describe('US-07 AC23: cholesterol cards', () => {
  it('L1: the target sentence labels Dr Brad\'s target, LDL-c as the very-high-risk goal, in both units', () => {
    const si = card(plan({ ldlC: 3.0 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description;
    expect(si.startsWith('Your LDL-c is 3.0 mmol/L. Guidelines set goals by heart risk. Dr Brad aims for below 1.4 mmol/L, the guideline goal for very high risk.')).toBe(true);
    const us = card(plan({ ldlC: ldlMg(116) }, { statin: { drug: 'none', dose: null } }, 'conventional'), 'med-statin').description;
    expect(us.startsWith('Your LDL-c is 116 mg/dL. Guidelines set goals by heart risk. Dr Brad aims for below 55 mg/dL, the guideline goal for very high risk.')).toBe(true);
  });

  it('L1: ApoB and non-HDL targets read lower than guideline goals', () => {
    expect(card(plan({ apoB: 0.9 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description)
      .toMatch(/^Your ApoB is 0\.90 g\/L\. Guidelines set goals by heart risk\. Dr Brad aims for below 0\.50 g\/L, lower than guideline goals\./);
    expect(card(plan({ totalCholesterol: 5.5, hdlC: 1.2 }, { statin: { drug: 'none', dose: null } }, 'conventional'), 'med-statin').description)
      .toMatch(/^Your non-HDL cholesterol is \d+ mg\/dL\. Guidelines set goals by heart risk\. Dr Brad aims for below 62 mg\/dL, lower than guideline goals\./);
  });

  it('L1: the form intro says the same sentence', () => {
    const inputs: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1986, ldlC: 3.0 };
    const results = calculateHealthResults(inputs, 'si', {});
    const [lipid] = medicationForm({ statin: { drug: 'none', dose: null } }, {
      lipidMarker: lipidMarkerFor(inputs, results), weightMedTrigger: weightMedicationTrigger(inputs, results), bmi: undefined,
      hasLipidInput: true, hasWeightInput: false, unitFor: () => 'si',
    });
    expect(lipid.intro).toMatch(/^Your LDL-c is 3\.0 mmol\/L\. Guidelines set goals by heart risk\. Dr Brad aims for below 1\.4 mmol\/L/);
  });

  it('L2: the statin card names the guideline first and drops the dose', () => {
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'none', dose: null } }), 'med-statin').description)
      .toContain('Guidelines name a statin first. Dr Brad suggests a low-dose statin, such as Rosuvastatin. Consider discussing a statin with your doctor. If you are pregnant or planning a pregnancy, talk to your doctor before starting a statin.');
  });

  it('L2: the statin card face names no other medicine when Ezetimibe is recorded taken or not tolerated', () => {
    for (const ezetimibe of ['yes', 'not_tolerated'] as const) {
      const text = card(plan({ ldlC: 3.0 }, { statin: { drug: 'none', dose: null }, ezetimibe }), 'med-statin').description;
      expect(text, ezetimibe).toContain('Dr Brad suggests a low-dose statin, such as Rosuvastatin. Consider discussing a statin with your doctor.');
      expect(text, ezetimibe).not.toMatch(/Ezetimibe/i);
    }
    expect(SUGGESTION_EVIDENCE['med-statin'].reason).toContain('Dr Brad suggests Ezetimibe before a higher dose.');
  });

  it('L4, L6, L7: Bempedoic acid without its brand and with the lipid guidelines; a higher dose; the switch card without "maximum"', () => {
    const bemp = card(plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'no', ezetimibe: 'no' }), 'med-bempedoic-acid');
    expect(bemp.description).toContain('Bempedoic acid lowers cholesterol by a different pathway than statins. Consider discussing it with your doctor. Not recommended in pregnancy');
    expect(bemp.references!.map((r) => r.url)).toEqual(expect.arrayContaining(['https://doi.org/10.1016/j.jacc.2025.11.016', 'https://doi.org/10.1093/eurheartj/ehz455']));
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 10 }, ezetimibe: 'yes' }), 'med-statin-increase').description)
      .toContain('Consider discussing a higher statin dose with your doctor. The FDA advises');
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'atorvastatin', dose: 70 }, ezetimibe: 'yes' }), 'med-statin-switch').description)
      .toContain('You take the highest dose of Atorvastatin this plan lists, or close to it. Consider discussing a more potent statin, such as Rosuvastatin, with your doctor.');
  });

  it('L5: dose cards, both arms, statin and GLP-1 (the switch arm names Tirzepatide)', () => {
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes' }), 'med-statin-dose').description)
      .toContain('Your statin dose isn\'t recorded. The next option to discuss with your doctor, a higher dose or a more potent statin, depends on it. Add your dose to see which.');
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: null }, ezetimibe: 'yes' }), 'med-statin-dose').description)
      .toContain('Your statin dose isn\'t recorded. Add it to see whether a higher dose is an option to discuss with your doctor.');
    expect(card(weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: null } }), 'weight-med-glp1-dose').description)
      .toBe('Your GLP-1 dose isn\'t recorded. The next option to discuss with your doctor, a higher dose or Tirzepatide, depends on it. Add your dose to see which.');
    expect(card(weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: null } }), 'weight-med-glp1-dose').description)
      .toBe('Your GLP-1 dose isn\'t recorded. Add it to see whether a higher dose is an option to discuss with your doctor.');
  });

  it('L8: the PCSK9 inhibitor card on a statin; with a statin not tolerated it is unchanged', () => {
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes' }), 'med-pcsk9i').description)
      .toMatch(/the guideline goal for very high risk\. Consider discussing a PCSK9 inhibitor with your doctor\. Not studied/);
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null } }), 'med-pcsk9i').description)
      .toMatch(/the guideline goal for very high risk\. Discuss a PCSK9 inhibitor with your doctor\. Not studied enough in pregnancy/);
  });

  it('L10: very high cards', () => {
    expect(card(plan({ apoB: 1.5 }), 'apob-very-high').description).toContain('is very high. Levels like this carry a much higher heart risk.');
    expect(card(plan({ ldlC: ldlMg(200) }, undefined, 'conventional'), 'ldl-very-high').description)
      .toContain('Levels this high can be inherited (familial hypercholesterolemia); your doctor can check.');
    expect(card(plan({ totalCholesterol: 7.5, hdlC: 1.0 }), 'non-hdl-very-high').description)
      .toContain('is very high. This reflects total atherogenic particle burden. Levels like this carry a much higher heart risk.');
  });

  it('L11: the Lp(a) checklist says whose lipid target it shows, by marker', () => {
    expect(card(plan({ ldlC: 2.0, lpa: 200 }), 'lpa-elevated').description).toContain('The LDL-c target is Dr Brad\'s, the guideline goal for very high risk.');
    expect(card(plan({ apoB: 0.6, lpa: 200 }), 'lpa-elevated').description).toContain('The ApoB target is Dr Brad\'s, lower than guideline goals.');
    expect(card(plan({ lpa: 200 }), 'lpa-elevated').description).not.toContain('target is Dr Brad\'s');
  });

  it('unchanged in this PR: the Ezetimibe card, the borderline cards and the switch card\'s Sources line', () => {
    expect(card(plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 40 } }), 'med-ezetimibe').description).toContain('Discuss adding Ezetimibe 10mg with your doctor.');
    expect(card(plan({ apoB: 0.6 }), 'apob-borderline').description).toBe('Your ApoB of 0.60 g/L is borderline. Optimal is <0.50 g/L.');
    expect(card(plan({ ldlC: ldlMg(140) }, undefined, 'conventional'), 'ldl-borderline').description).toBe('Your LDL-c of 140 mg/dL is borderline high. Optimal is <55 mg/dL.');
    expect(SUGGESTION_EVIDENCE['med-statin-switch'].reason).toContain('Switching to a more potent statin is recommended by ESC/EAS guidelines before adding additional medications.');
  });
});

describe('US-07 AC24: weight cards', () => {
  it('W3, W4: switch and increase cards, without brands', () => {
    expect(card(weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: 2.4 } }), 'weight-med-glp1-switch').description)
      .toBe('In a head-to-head trial, people lost more weight on Tirzepatide than on Semaglutide. Consider discussing switching to Tirzepatide with your doctor.');
    expect(card(weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 5 } }), 'weight-med-glp1-increase').description)
      .toBe('Consider discussing a higher dose of your GLP-1 medicine with your doctor, including its pros and cons.');
  });

  it('unchanged in this PR: the GLP-1 card, the form intro, SGLT2 inhibitor and Metformin', () => {
    expect(card(weightPlan(30), 'weight-glp1').description)
      .toBe('With a BMI of 30, consider discussing Tirzepatide or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health.');
    expect(weightMedIntro(30, [])).toBe('At a BMI of 30, medications that support weight management and metabolic health are an option to discuss with your doctor.');
    const onGlp1 = { glp1: { drug: 'tirzepatide', dose: 15 } } as MedicationInputs;
    expect(card(weightPlan(31, {}, onGlp1), 'weight-med-sglt2i').description).toMatch(/^SGLT2 inhibitors like Empagliflozin or Dapagliflozin/);
    expect(card(weightPlan(31, {}, { ...onGlp1, sglt2i: { drug: 'empagliflozin' } } as MedicationInputs), 'weight-med-metformin').description).toMatch(/^Metformin provides additional glycemic control/);
  });
});

describe('US-07 AC25: blood pressure cards, unchanged in this PR', () => {
  it('keep their weight line, the stage 1 target and the measure card\'s words', () => {
    expect(card(plan({ weightKg: 95, systolicBp: 145, diastolicBp: 92 }), 'bp-stage2').description)
      .toContain('Even a 5% reduction can make a meaningful difference. GLP-1 medications (Tirzepatide, Semaglutide) can assist with both weight loss and blood pressure reduction.');
    expect(card(plan({ systolicBp: 135, diastolicBp: 82 }), 'bp-stage1').description).toContain('Consider discussing it with your doctor. Target is <120/80.\n\n');
    expect(card(plan({}), 'measure-bp').description).toMatch(/Aim for below 120\/80 \(130\/80 if you're frail\)\.$/);
  });
});

describe('US-07 AC27: colorectal order, skin, supplements, form', () => {
  it('S1, S2: the guideline\'s 45 comes before Dr Brad\'s 35', () => {
    expect(card(plan({}, undefined, 'si', {}), 'screening-colorectal').description)
      .toBe('The American Cancer Society starts colorectal screening at 45. Dr Brad recommends starting at 35, because colorectal cancer has become more common in younger adults. He suggests a FIT test every year until 55, then a colonoscopy every 10 years. Discuss with your doctor.');
    const note = screeningForm(40, 'male', {}).flatMap((s) => s.groups).find((g) => g.id === 'colorectal')!.notes[0];
    expect(note).toBe('The American Cancer Society starts screening at 45 for people at average risk. Starting at 35 is Dr Brad\'s recommendation, because colorectal cancer has become more common in younger adults. Discuss timing with your doctor.');
  });

  it('K1, K2: the retinoid card and its Sources line', () => {
    expect(card(plan({}), 'skin-retinoid').description).toBe('Consider discussing a topical retinoid, such as Adapalene or Tretinoin, with your doctor or pharmacist. Retinoids are well studied for skin texture and collagen, and are used at night with daily sunscreen. They must not be used during pregnancy. Tretinoin needs a prescription.');
    expect(SUGGESTION_EVIDENCE['skin-retinoid'].reason).toMatch(/^Retinoids \(vitamin A derivatives\) are a well-studied topical treatment for skin ageing\./);
  });

  it('K3: omega-3 names Dr Brad, for adults; the multivitamin card is unchanged', () => {
    const cards = plan({});
    expect(card(cards, 'supplement-omega3').description).toContain('Dr Brad thinks it is reasonable for adults to consider up to 1 g a day');
    expect(card(cards, 'supplement-micronutrient-base').description).not.toContain('Dr Brad');
  });

  it('F1, F3: form titles and step-up hints; the Ezetimibe question keeps its dose (a plain Yes records 10 mg)', () => {
    const T = MEDICATION_TEXT;
    expect([T.lipidTitle, T.weightTitle, T.ezetimibeLabel]).toEqual(['Your cholesterol medications', 'Your weight & diabetes medications', 'On Ezetimibe 10mg?']);
    for (const hint of [T.statinEscalationHint.increase('LDL-c'), T.statinEscalationHint.switch('ApoB'), T.glp1EscalationHint.increase, T.glp1EscalationHint.switch]) {
      expect(hint.endsWith(' An option to discuss with your doctor.')).toBe(true);
    }
  });
});

/**
 * The one phrase each listed card may still show: a dose kept while its wording
 * is pending, or the person's own recorded dose. The rest of each listed card is
 * scanned like every other card, and a listed phrase no card shows fails too.
 */
const HELD_FOR_OWNER_WORDING: Readonly<Record<string, { phrase: RegExp; why: string }>> = {
  'med-ezetimibe': { phrase: /Ezetimibe 10mg/, why: 'wording pending: the card keeps "Ezetimibe 10mg" (US-07 AC23)' },
  'lpa-elevated': { phrase: /^\u2705 Statin: [A-Z][a-z]+ \d+mg$/m, why: 'its checklist shows the person\'s own recorded statin and dose, not a suggested dose' },
};

describe('US-07 AC23 to AC27: no dose, strength or brand on a card face outside HELD_FOR_OWNER_WORDING', () => {
  const MEDICINE = 'Rosuvastatin|Atorvastatin|Simvastatin|Pravastatin|Pitavastatin|Ezetimibe|Bempedoic acid|Evolocumab|Alirocumab|Tirzepatide|Semaglutide|Dulaglutide|Empagliflozin|Dapagliflozin|Metformin|Adapalene|Tretinoin|statin';
  const DOSE = new RegExp(`\\b(?:${MEDICINE})\\b[^.]{0,12}?\\d+(?:\\.\\d+)?\\s*(?:mg|%)`, 'i');
  const BRANDS = /Nexletol|Nexlizet|Mounjaro|Zepbound|Ozempic|Wegovy|Rybelsus|Trulicity|Jardiance|Farxiga|Repatha|Praluent|Zetia/;
  const screenings: ScreeningInputs = {};
  const scenarios: Suggestion[][] = [
    plan({ ldlC: 3.0, lpa: 200, weightKg: 95, systolicBp: 135, diastolicBp: 85 }, { statin: { drug: 'none', dose: null } }, 'si', screenings),
    plan({ ldlC: 3.0, lpa: 200 }, { statin: { drug: 'atorvastatin', dose: 40 } }),
    plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 10 }, ezetimibe: 'yes' }), // statin-increase
    plan({ ldlC: 3.0 }, { statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes' }), // statin-dose
    plan({ ldlC: 3.0 }, { statin: { drug: 'pravastatin', dose: 40 }, ezetimibe: 'yes' }), // statin-switch
    plan({ ldlC: 3.0 }, { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes' }), // pcsk9i
    plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null } }), // pcsk9i, not tolerated
    plan({ ldlC: 3.0 }, { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'no', ezetimibe: 'no' }), // bempedoic acid
    plan({ apoB: 1.5, systolicBp: 185, diastolicBp: 125, triglycerides: 6, hba1c: 50, creatinine: 200 }),
    plan({ apoB: 0.6, hdlC: 0.8, totalCholesterol: 5.4, systolicBp: 145, diastolicBp: 92 }, undefined, 'conventional'),
    weightPlan(31), // standalone weight-glp1
    weightPlan(31, { hba1c: 50 }, {}), // glp1
    weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: null } }), // glp1-dose
    weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 5 } }), // glp1-increase
    weightPlan(31, {}, { glp1: { drug: 'semaglutide_injection', dose: 2.4 } }), // glp1-switch
    weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 15 } }), // sglt2i
    weightPlan(31, {}, { glp1: { drug: 'tirzepatide', dose: 15 }, sglt2i: { drug: 'empagliflozin' } } as MedicationInputs), // metformin
    calculateHealthResults({ heightCm: 165, sex: 'female', birthYear: 1960 }, 'conventional', {}, {}, undefined, NOW).suggestions, // screening cards
  ];
  const faces = scenarios.flat().map((s) => ({ id: s.id, face: `${s.title}\n${s.description}` }));

  it('reaches every card the change words and every held card', () => {
    const ids = new Set(faces.map((f) => f.id));
    for (const id of ['med-statin', 'med-ezetimibe', 'med-bempedoic-acid', 'med-statin-dose', 'med-statin-increase', 'med-statin-switch', 'med-pcsk9i',
      'weight-glp1', 'weight-med-glp1', 'weight-med-glp1-dose', 'weight-med-glp1-increase', 'weight-med-glp1-switch', 'weight-med-sglt2i', 'weight-med-metformin',
      'bp-stage1', 'bp-stage2', 'lpa-elevated', 'skin-retinoid', 'protein-target']) expect(ids, id).toContain(id);
  });

  /** A face with its card's one permitted phrase taken out. */
  const scanned = (id: string, face: string) => (id in HELD_FOR_OWNER_WORDING ? face.replace(HELD_FOR_OWNER_WORDING[id].phrase, '') : face);
  const offends = (id: string, face: string) => { const t = scanned(id, face); return DOSE.test(t) || BRANDS.test(t); };

  it('no card face shows a medicine dose, a strength or a brand beyond its listed phrase; each listed phrase is shown', () => {
    expect(faces.filter((f) => offends(f.id, f.face)).map((f) => f.id)).toEqual([]);
    for (const [id, { phrase }] of Object.entries(HELD_FOR_OWNER_WORDING)) expect(faces.some((f) => f.id === id && phrase.test(f.face)), id).toBe(true);
  });

  it('a listed card still fails on anything beyond its phrase', () => {
    const ezetimibe = faces.find((f) => f.id === 'med-ezetimibe')!;
    expect(offends(ezetimibe.id, ezetimibe.face)).toBe(false);
    expect(offends(ezetimibe.id, `${ezetimibe.face} Ask about Zetia.`)).toBe(true);
    expect(offends(ezetimibe.id, `${ezetimibe.face} Or Rosuvastatin 40mg.`)).toBe(true);
    const lpa = faces.find((f) => f.id === 'lpa-elevated' && HELD_FOR_OWNER_WORDING['lpa-elevated'].phrase.test(f.face))!;
    expect(offends(lpa.id, `${lpa.face}\nRepatha`)).toBe(true);
  });

  it('creatine, omega-3 and protein amounts stay', () => {
    const cards = scenarios[0];
    expect(card(cards, 'supplement-creatine').description).toContain('creatine (3–5 g/day)');
    expect(card(cards, 'supplement-omega3').description).toContain('up to 1 g a day of EPA and DHA');
    expect(card(cards, 'protein-target').description).toMatch(/\d+g of protein daily/);
  });

  it('the scan would catch the words it replaced', () => {
    expect('Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.').toMatch(DOSE);
    expect('A topical retinoid (Adapalene 0.3% or Tretinoin 0.05%)').toMatch(DOSE);
    expect('Tirzepatide (Mounjaro/Zepbound) may be more effective').toMatch(BRANDS);
  });
});
