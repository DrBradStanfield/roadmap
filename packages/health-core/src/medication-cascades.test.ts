/**
 * US-06 AC5: the input form steps through a medication cascade exactly as the
 * plan does. Both read one step function per cascade. These parity tables run
 * every medication combination through the step function and through
 * generateSuggestions, with the cascade's trigger forced on, and check they
 * agree: on the cards the plan shows, and on how far the steps have opened.
 * Both cascades answer in one shape: `suggest` lists the plan's cards, the
 * `<step>Reached` flags say which later steps are open, and `escalation` is
 * the step-up the plan would ask about, null until the step before it is answered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { calculateHealthResults } from './calculations';
import { generateSuggestions } from './suggestions';
import { weightCascade, lipidCascade } from './medication-cascades';
import { goldenRecord, type CalculateHealthResults, type GoldenRecord } from './medication-cascades.golden';
import { MEDICATION_KEYS, UNANSWERED_OF } from './validation';
import { medicationsToInputs } from './mappings';
import {
  GLP1_DRUGS, STATIN_DRUGS, METFORMIN_OPTIONS, EZETIMIBE_OPTIONS, BEMPEDOIC_ACID_OPTIONS, PCSK9I_OPTIONS,
  type HealthInputs, type MedicationInputs,
} from './types';

/** Every value a medication field can hold: unset, each option, and off-list strings an agent could write. */
const withUnset = <T,>(values: T[]): (T | undefined)[] => [undefined, ...values];
const drugsWithDoses = (drugs: Record<string, { doses: number[] }>, oddDrug: string) => [
  ...Object.entries(drugs).flatMap(([drug, { doses }]) =>
    [null, ...doses, 99].map((dose) => ({ drug, dose }))),
  { drug: oddDrug, dose: null }, { drug: oddDrug, dose: 1 },
];

/** The plan's steps for these inputs: its cards whose ids start with `prefix`, prefix cut. */
function planSteps(inputs: HealthInputs, prefix: string): (meds: MedicationInputs) => string[] {
  const results = calculateHealthResults(inputs);
  return (meds) => generateSuggestions(inputs, results, 'si', meds).map((s) => s.id)
    .filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
}

describe('US-06 AC5: weightCascade agrees with the plan on every medication combination', () => {
  const bmi32: HealthInputs = { heightCm: 178, weightKg: 101.4, sex: 'male' }; // BMI 32: the trigger is on
  const glp1s = withUnset([
    { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null }, { drug: 'other', dose: null },
    ...drugsWithDoses(GLP1_DRUGS, 'liraglutide'),
  ]);
  const escalations = withUnset(['not_yet', 'not_tolerated', 'yes'] as MedicationInputs['glp1Escalation'][]);
  const sglt2is = withUnset([
    { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null },
    { drug: 'empagliflozin', dose: 10 }, { drug: 'empagliflozin', dose: null },
  ]);
  const metformins = withUnset(METFORMIN_OPTIONS.map((o) => o.value));

  const steps = planSteps(bmi32, 'weight-med-');

  it('suggests the card the plan shows, and opens the steps the plan has reached', () => {
    let checked = 0;
    for (const glp1 of glp1s) for (const glp1Escalation of escalations)
      for (const sglt2i of sglt2is) for (const metformin of metformins) {
        const meds: MedicationInputs = { glp1, glp1Escalation, sglt2i, metformin };
        const cascade = weightCascade(meds);
        const label = JSON.stringify(meds);
        expect(cascade.suggest.length, label).toBeLessThanOrEqual(1);
        expect(cascade.suggest, label).toEqual(steps(meds));
        // The plan suggests one step at a time, in order, so the steps it has
        // reached are the current one and those before it.
        const current = cascade.suggest[0] ?? null;
        expect(cascade.sglt2iReached, label).toBe(['sglt2i', 'metformin', null].includes(current));
        expect(cascade.metforminReached, label).toBe(['metformin', null].includes(current));
        // The escalation question applies when the plan, with it unanswered, asks it.
        const unanswered = steps({ glp1 });
        expect(cascade.escalation, label).toBe(unanswered.includes('glp1-increase') ? 'increase'
          : unanswered.includes('glp1-switch') ? 'switch' : null);
        checked++;
      }
    expect(checked).toBeGreaterThan(3000);
  });

  it("an escalation answer other than 'not_yet' moves on to the SGLT2 inhibitor, as the plan does", () => {
    const meds: MedicationInputs = { glp1: { drug: 'semaglutide_injection', dose: 1 }, glp1Escalation: 'yes' as MedicationInputs['glp1Escalation'] };
    expect(weightCascade(meds)).toMatchObject({ escalation: 'increase', sglt2iReached: true, suggest: ['sglt2i'] });
  });
});

describe('US-06 AC5: lipidCascade agrees with the plan on every medication combination', () => {
  const ldl3: HealthInputs = { heightCm: 178, weightKg: 80, sex: 'male', ldlC: 3.0 }; // above the 1.4 target
  const statins = withUnset([
    { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null },
    ...drugsWithDoses(STATIN_DRUGS, 'tier_1'),
  ]);
  const ezetimibes = withUnset([...EZETIMIBE_OPTIONS.map((o) => o.value), 'ezetimibe'] as MedicationInputs['ezetimibe'][]);
  const bempedoics = withUnset(BEMPEDOIC_ACID_OPTIONS.map((o) => o.value));
  const escalations = withUnset(['not_yet', 'not_tolerated', 'yes'] as MedicationInputs['statinEscalation'][]);
  const pcsk9is = withUnset(PCSK9I_OPTIONS.map((o) => o.value));

  const steps = planSteps(ldl3, 'med-');

  it('suggests the cards the plan shows, and opens the steps the plan has reached', () => {
    let checked = 0;
    for (const statin of statins) for (const ezetimibe of ezetimibes) for (const bempedoicAcid of bempedoics)
      for (const statinEscalation of escalations) for (const pcsk9i of pcsk9is) {
        const meds: MedicationInputs = { statin, ezetimibe, bempedoicAcid, statinEscalation, pcsk9i };
        const cascade = lipidCascade(meds);
        const label = JSON.stringify(meds);
        expect(cascade.suggest, label).toEqual(steps(meds));
        expect(cascade.ezetimibeReached, label).toBe(!cascade.suggest.includes('statin'));
        expect(cascade.bempedoicAcidReached, label).toBe(cascade.ezetimibeReached && !cascade.suggest.includes('ezetimibe'));
        expect(cascade.pcsk9iReached, label).toBe(cascade.bempedoicAcidReached && !cascade.suggest.includes('statin-increase')
          && !cascade.suggest.includes('statin-switch') && !cascade.suggest.includes('statin-dose'));
        // The escalation question applies when the plan, with it unanswered, asks it.
        const unanswered = steps({ statin, ezetimibe });
        expect(cascade.escalation, label).toBe(unanswered.includes('statin-increase') ? 'increase'
          : unanswered.includes('statin-switch') ? 'switch' : null);
        checked++;
      }
    expect(checked).toBeGreaterThan(10000);
  });

  it('a legacy statin value the plan does not know is still the statin step', () => {
    expect(lipidCascade({ statin: { drug: 'tier_1', dose: null } })).toMatchObject({ ezetimibeReached: false, suggest: ['statin'] });
  });
});

// US-06 AC8 (Brad, 2026-09-28): a listed GLP-1 or statin with no dose
// recorded asks for the dose. The next step depends on it: a higher dose, a
// switch, or the next drug. Before, the plan skipped straight to the next drug.
describe('US-06 AC8: a listed GLP-1 or statin with no dose recorded asks for the dose', () => {
  const answers = withUnset(['not_yet', 'not_tolerated', 'yes'] as MedicationInputs['glp1Escalation'][]);
  const asksForGlp1Dose = { escalation: null, sglt2iReached: false, metforminReached: false, suggest: ['glp1-dose'] };

  it.each(Object.keys(GLP1_DRUGS))('%s with no dose: the GLP-1 dose step, whatever the escalation answer', (drug) => {
    for (const glp1Escalation of answers) {
      expect(weightCascade({ glp1: { drug, dose: null }, glp1Escalation }), String(glp1Escalation)).toEqual(asksForGlp1Dose);
    }
  });

  it('tirzepatide with no dose asks for it too, though no switch follows (before, the SGLT2 inhibitor step)', () => {
    expect(weightCascade({ glp1: { drug: 'tirzepatide', dose: null } })).toEqual(asksForGlp1Dose);
  });

  it('asks for the GLP-1 dose even with an SGLT2 inhibitor and metformin recorded', () => {
    expect(weightCascade({
      glp1: { drug: 'semaglutide_injection', dose: null },
      sglt2i: { drug: 'empagliflozin', dose: 10 }, metformin: 'xr_1000',
    })).toEqual(asksForGlp1Dose);
  });

  it("'Other GLP-1' with no dose is still the switch step", () => {
    expect(weightCascade({ glp1: { drug: 'other', dose: null } }))
      .toEqual({ escalation: 'switch', sglt2iReached: false, metforminReached: false, suggest: ['glp1-switch'] });
  });

  it('an unlisted name such as liraglutide, which the form cannot give a dose, still moves on to the SGLT2 inhibitor', () => {
    expect(weightCascade({ glp1: { drug: 'liraglutide', dose: null } }))
      .toEqual({ escalation: null, sglt2iReached: true, metforminReached: false, suggest: ['sglt2i'] });
  });

  const statinAnswers = withUnset(['not_yet', 'not_tolerated', 'yes'] as MedicationInputs['statinEscalation'][]);

  it.each(Object.keys(STATIN_DRUGS))('%s with no dose, before ezetimibe is answered: the ezetimibe step, as before', (drug) => {
    for (const ezetimibe of withUnset(['not_yet', 'no'] as MedicationInputs['ezetimibe'][])) {
      expect(lipidCascade({ statin: { drug, dose: null }, ezetimibe }), String(ezetimibe)).toEqual({
        ezetimibeReached: true, bempedoicAcidReached: false, escalation: null, pcsk9iReached: false, suggest: ['ezetimibe'],
      });
    }
  });

  it.each(Object.keys(STATIN_DRUGS))('%s with no dose, ezetimibe answered: bempedoic acid, then the statin dose step', (drug) => {
    for (const ezetimibe of ['yes', 'not_tolerated', 'ezetimibe'] as MedicationInputs['ezetimibe'][])
      for (const statinEscalation of statinAnswers) {
        const label = `${ezetimibe} ${statinEscalation}`;
        expect(lipidCascade({ statin: { drug, dose: null }, ezetimibe, statinEscalation }), label).toEqual({
          ezetimibeReached: true, bempedoicAcidReached: true, escalation: null, pcsk9iReached: false,
          suggest: ['bempedoic-acid', 'statin-dose'],
        });
        expect(lipidCascade({ statin: { drug, dose: null }, ezetimibe, statinEscalation, bempedoicAcid: 'bempedoic_acid' }).suggest, label)
          .toEqual(['statin-dose']);
      }
  });

  it('a statin with no dose and a PCSK9 inhibitor recorded still asks for the dose', () => {
    for (const pcsk9i of ['yes', 'not_tolerated'] as MedicationInputs['pcsk9i'][]) {
      expect(lipidCascade({ statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes', pcsk9i }), String(pcsk9i))
        .toMatchObject({ escalation: null, pcsk9iReached: false, suggest: ['bempedoic-acid', 'statin-dose'] });
      expect(lipidCascade({ statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes', pcsk9i, bempedoicAcid: 'not_tolerated' }).suggest)
        .toEqual(['statin-dose']);
    }
  });
});

// US-06 AC10 (Brad, 2026-09-28): a dose the form does not list is graded as
// that drug's nearest listed dose, the lower on a tie, so a step up is never
// skipped. Before, rosuvastatin 2.5 mg went straight to the PCSK9 inhibitor.
describe('US-06 AC10: a dose the form does not list is graded as the nearest listed dose', () => {
  const lipidSteps = planSteps({ heightCm: 178, weightKg: 80, sex: 'male', ldlC: 3.0 }, 'med-');
  const weightSteps = planSteps({ heightCm: 178, weightKg: 101.4, sex: 'male' }, 'weight-med-');

  // Ezetimibe and bempedoic acid answered, the step up not: one card, the dose's own.
  it.each([
    ['rosuvastatin', 2.5, 'statin-increase'],
    ['pravastatin', 10, 'statin-increase'],
    ['atorvastatin', 30, 'statin-increase'], // a tie: graded 20 mg, not 40
    ['rosuvastatin', 30, 'statin-increase'], // a tie: graded 20 mg, not 40
    ['simvastatin', 80, 'statin-switch'],
    ['pravastatin', 80, 'statin-switch'],
    ['atorvastatin', 99, 'statin-switch'],
    ['rosuvastatin', 99, 'pcsk9i'],
  ] as const)('%s %s mg: %s', (drug, dose, step) => {
    const meds: MedicationInputs = { statin: { drug, dose }, ezetimibe: 'yes', bempedoicAcid: 'bempedoic_acid' };
    expect(lipidCascade(meds).suggest).toEqual([step]);
    expect(lipidSteps(meds)).toEqual([step]);
  });

  it.each([
    ['semaglutide_injection', 2.0, 'glp1-increase'], // graded 1.7 mg
    ['tirzepatide', 3, 'glp1-increase'],
    ['tirzepatide', 99, 'sglt2i'],
    ['dulaglutide', 99, 'glp1-switch'],
    ['liraglutide', 1, 'glp1-switch'], // an unlisted name: unchanged
  ] as const)('%s %s mg: %s', (drug, dose, step) => {
    const meds: MedicationInputs = { glp1: { drug, dose } };
    expect(weightCascade(meds).suggest).toEqual([step]);
    expect(weightSteps(meds)).toEqual([step]);
  });
});

// The tables above compare the step functions with a plan that now calls
// them, so they cannot see a change of behaviour. This record came from the
// plan before the refactor, with only US-06 AC8's and AC10's dose rows changed since
// (medication-cascades.golden.ts says how to regenerate it), so today's plan
// must match it card for card.
describe('US-06 AC5: the plan\'s cascade cards match the golden record exactly', () => {
  const golden = JSON.parse(readFileSync(new URL('./medication-cascades.golden.json', import.meta.url), 'utf8')) as GoldenRecord;
  const now = goldenRecord(calculateHealthResults as unknown as CalculateHealthResults, golden.source);

  it.each(['weight', 'lipid'] as const)('%s: every combination in the explicit set', (cascade) => {
    expect(Object.keys(now[cascade]).length).toBeGreaterThan(700);
    expect(now[cascade]).toEqual(golden[cascade]);
  });

  it.each(['weight', 'lipid'] as const)('%s: the full cross product, by its hash', (cascade) => {
    expect(now.full[cascade]).toEqual(golden.full[cascade]);
  });

  // The one difference, left out of the record: the old plan suggested a
  // switch to tirzepatide for a semaglutide or dulaglutide row with no dose
  // field at all, but the next step for one with a null dose. Today both are
  // "no dose recorded", as a statin's always were.
  it('a GLP-1 row with no dose field reads as no dose recorded: the plan asks for the dose (US-06 AC8)', () => {
    const ids = (meds: MedicationInputs) => calculateHealthResults({ heightCm: 178, sex: 'male', weightKg: 101.4 }, 'si', meds)
      .suggestions.map((s) => s.id).filter((id) => id.startsWith('weight-med-'));
    const noField = { drug: 'semaglutide_injection' } as MedicationInputs['glp1'];
    expect(ids({ glp1: noField })).toEqual(['weight-med-glp1-dose']);
    expect(ids({ glp1: noField })).toEqual(ids({ glp1: { drug: 'semaglutide_injection', dose: null } }));
  });
});

// US-06 AC12: the chat's Undo writes UNANSWERED_OF[key] for a key that had no
// row (a row is never removed), so each value must read exactly as no row.
describe('US-06 AC12: each UNANSWERED_OF value reads as no row', () => {
  const row = (medicationKey: string, drugName: string, doseValue: number | null = null) => ({ medicationKey, drugName, doseValue });
  const bases = [
    [],
    [row('statin', 'atorvastatin', 20)],
    [row('statin', 'atorvastatin', 20), row('ezetimibe', 'ezetimibe', 10)],
    [row('statin', 'rosuvastatin', 40), row('ezetimibe', 'not_tolerated'), row('bempedoic_acid', 'bempedoic_acid'), row('statin_escalation', 'not_tolerated'), row('pcsk9i', 'no')],
    [row('glp1', 'semaglutide_injection', 1)],
    [row('glp1', 'tirzepatide', 15), row('glp1_escalation', 'not_tolerated'), row('sglt2i', 'empagliflozin', 10), row('metformin', 'xr_1000')],
  ];
  it.each([...MEDICATION_KEYS])('%s', (key) => {
    for (const base of bases) {
      const without = base.filter((r) => r.medicationKey !== key);
      const a = medicationsToInputs(without), b = medicationsToInputs([...without, row(key, UNANSWERED_OF[key])]);
      expect(lipidCascade(b), JSON.stringify(base)).toEqual(lipidCascade(a));
      expect(weightCascade(b), JSON.stringify(base)).toEqual(weightCascade(a));
    }
  });
});
