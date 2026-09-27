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

  it('a GLP-1 with no dose recorded moves on to the SGLT2 inhibitor, as the plan does', () => {
    expect(weightCascade({ glp1: { drug: 'semaglutide_injection', dose: null } }))
      .toEqual({ escalation: null, sglt2iReached: true, metforminReached: false, suggest: ['sglt2i'] });
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
        expect(cascade.pcsk9iReached, label).toBe(cascade.bempedoicAcidReached
          && !cascade.suggest.includes('statin-increase') && !cascade.suggest.includes('statin-switch'));
        // The escalation question applies when the plan, with it unanswered, asks it.
        const unanswered = steps({ statin, ezetimibe });
        expect(cascade.escalation, label).toBe(unanswered.includes('statin-increase') ? 'increase'
          : unanswered.includes('statin-switch') ? 'switch' : null);
        checked++;
      }
    expect(checked).toBeGreaterThan(10000);
  });

  it('a statin with no dose recorded opens the PCSK9 inhibitor step, as the plan does', () => {
    expect(lipidCascade({ statin: { drug: 'rosuvastatin', dose: null }, ezetimibe: 'yes' })).toEqual({
      ezetimibeReached: true, bempedoicAcidReached: true, escalation: null, pcsk9iReached: true,
      suggest: ['bempedoic-acid', 'pcsk9i'],
    });
  });

  it('a legacy statin value the plan does not know is still the statin step', () => {
    expect(lipidCascade({ statin: { drug: 'tier_1', dose: null } })).toMatchObject({ ezetimibeReached: false, suggest: ['statin'] });
  });
});

// The tables above compare the step functions with a plan that now calls
// them, so they cannot see a change of behaviour. This record came from the
// plan before the refactor (medication-cascades.golden.ts says how to
// regenerate it), so today's plan must match it card for card.
describe('US-06 AC5: the plan\'s cascade cards match the pre-refactor plan exactly', () => {
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
  it('a GLP-1 row with no dose field reads as no dose recorded: the SGLT2 inhibitor step', () => {
    const ids = (meds: MedicationInputs) => calculateHealthResults({ heightCm: 178, sex: 'male', weightKg: 101.4 }, 'si', meds)
      .suggestions.map((s) => s.id).filter((id) => id.startsWith('weight-med-'));
    const noField = { drug: 'semaglutide_injection' } as MedicationInputs['glp1'];
    expect(ids({ glp1: noField })).toEqual(['weight-med-sglt2i']);
    expect(ids({ glp1: noField })).toEqual(ids({ glp1: { drug: 'semaglutide_injection', dose: null } }));
  });
});
