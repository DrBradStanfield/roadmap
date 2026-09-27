/**
 * The medication cascades' golden record (US-06 AC5): the plan's cascade card
 * ids for a set of medication combinations, as the plan computed them BEFORE
 * the cascades moved into medication-cascades.ts. The parity tables in
 * medication-cascades.test.ts compare the step functions with a plan that now
 * calls those same functions, so they cannot catch a change of behaviour;
 * this record can, because it came from the old code.
 *
 * US-06 AC8 (2026-09-28) changed it on purpose: a listed GLP-1 or statin with
 * no dose now asks for the dose. The record was regenerated from the working
 * tree after a script compared HEAD's plan with the new one over both sets:
 * only rows under that rule changed, and only as the rule says.
 *
 * Each cascade has an `explicit` set, stored row by row in
 * medication-cascades.golden.json, and a `full` cross product, stored as one
 * SHA-256 over its rows (about 81,000 combinations, too many to keep).
 *
 * Regenerate only when a cascade change is intended, from the commit whose
 * behaviour is the reference:
 *   git archive <commit> packages/health-core/src | tar -x -C <dir>
 *   npx tsx scripts/gen-cascade-golden.ts <dir>/packages/health-core/src/calculations.ts <commit>
 *
 * Test support only. It imports nothing from health-core, so the generator
 * can run it against any version's calculateHealthResults.
 */
import { createHash } from 'node:crypto';

type Meds = Record<string, unknown>;
/** Any version's calculateHealthResults, as far as this record reads it. */
export type CalculateHealthResults = (inputs: never, unitSystem: 'si', meds: Meds) => { suggestions: Array<{ id: string }> };

interface Cascade {
  /** The plan's inputs: this cascade's trigger on, the other's off. */
  inputs: object;
  /** Card ids that belong to this cascade. */
  prefix: string;
  /** Each field's values, for the explicit set and the full cross product. */
  explicit: Record<string, unknown[]>;
  full: Record<string, unknown[]>;
}

const drug = (name: string, doses: Array<number | null | undefined>) =>
  doses.map((dose) => (dose === undefined ? { drug: name } : { drug: name, dose }));
/** Every listed dose, a null dose, one off the list and (`absent`) a row with no dose field. */
const allDoses = (name: string, doses: number[], absent = true) => drug(name, [null, ...(absent ? [undefined] : []), ...doses, 99]);
const answers = (...values: string[]) => [undefined, '', ...values];

const GLP1_DOSES: Record<string, number[]> = {
  tirzepatide: [2.5, 5, 7.5, 10, 12.5, 15],
  semaglutide_injection: [0.25, 0.5, 1, 1.7, 2.4],
  semaglutide_oral: [3, 7, 14],
  dulaglutide: [0.75, 1.5, 3, 4.5],
};
const STATIN_DOSES: Record<string, number[]> = {
  atorvastatin: [10, 20, 40, 80],
  pitavastatin: [1, 2, 4],
  pravastatin: [20, 40],
  rosuvastatin: [5, 10, 20, 40],
  simvastatin: [10, 20, 40],
};
const METFORMIN = ['none', 'ir_500', 'ir_1000', 'ir_1500', 'ir_2000', 'xr_500', 'xr_1000', 'xr_1500', 'xr_2000', 'not_tolerated'];
const BEMPEDOIC = ['not_yet', 'bempedoic_acid', 'bempedoic_acid_ezetimibe', 'none', 'not_tolerated'];

const CASCADES: Record<'weight' | 'lipid', Cascade> = {
  weight: {
    inputs: { heightCm: 178, sex: 'male', weightKg: 101.4 }, // BMI 32, no lipid
    prefix: 'weight-med-',
    explicit: {
      glp1: [undefined, { drug: '' }, { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null }, { drug: 'other', dose: null },
        ...drug('tirzepatide', [null, undefined, 2.5, 15]), ...drug('semaglutide_injection', [1, 2.4]), ...drug('liraglutide', [null, 1.8])],
      glp1Escalation: answers('not_yet', 'not_tolerated', 'yes'),
      sglt2i: [undefined, { drug: 'none', dose: null }, ...drug('empagliflozin', [10, null])],
      metformin: [undefined, 'none', 'xr_1000'],
    },
    full: {
      glp1: [undefined, { drug: '' }, { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null }, { drug: 'other', dose: null },
        // No absent-dose rows: the old plan read a GLP-1 row with no dose field
        // unlike one with a null dose (a switch card, not the next step). Today
        // both are "no dose recorded"; medication-cascades.test.ts pins that.
        ...Object.entries(GLP1_DOSES).flatMap(([name, doses]) => allDoses(name, doses, false)), ...drug('liraglutide', [null, 1.8])],
      glp1Escalation: answers('not_yet', 'not_tolerated', 'yes'),
      sglt2i: [undefined, { drug: '' }, { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null },
        ...drug('empagliflozin', [10, 25, null, undefined]), ...drug('dapagliflozin', [5]), ...drug('canagliflozin', [300])],
      metformin: answers(...METFORMIN),
    },
  },
  lipid: {
    inputs: { heightCm: 178, sex: 'male', weightKg: 70, ldlC: 3.0 }, // BMI 22, LDL above its target
    prefix: 'med-',
    explicit: {
      statin: [undefined, { drug: '' }, { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null }, { drug: 'tier_1', dose: null },
        ...drug('atorvastatin', [null, 20, 80]), ...drug('rosuvastatin', [40])],
      ezetimibe: answers('yes', 'not_tolerated', 'ezetimibe'),
      statinEscalation: [undefined, 'not_tolerated', 'yes'],
      bempedoicAcid: [undefined, 'bempedoic_acid'],
      pcsk9i: [undefined, 'not_yet', 'yes'],
    },
    full: {
      statin: [undefined, { drug: '' }, { drug: 'none', dose: null }, { drug: 'not_tolerated', dose: null }, { drug: 'tier_1', dose: null },
        ...Object.entries(STATIN_DOSES).flatMap(([name, doses]) => allDoses(name, doses))],
      ezetimibe: answers('not_yet', 'yes', 'no', 'not_tolerated', 'ezetimibe'),
      statinEscalation: answers('not_yet', 'not_tolerated', 'yes'),
      bempedoicAcid: answers(...BEMPEDOIC),
      pcsk9i: answers('not_yet', 'yes', 'no', 'not_tolerated', 'pcsk9i'),
    },
  },
};

/** Every combination of the fields' values; an undefined value leaves the field out. */
function combinations(fields: Record<string, unknown[]>): Meds[] {
  return Object.entries(fields).reduce<Meds[]>((rows, [field, values]) =>
    rows.flatMap((row) => values.map((v) => (v === undefined ? row : { ...row, [field]: v }))), [{}]);
}

/** A row's key: its fields' values in the cascade's field order, joined by
 *  `|`; `-` for unset, `""` for empty, and a dose after `@` (`@-` when absent). */
function keyOf(fields: string[], meds: Meds): string {
  const show = (v: unknown): string => {
    if (v === undefined) return '-';
    if (v === '') return '""';
    if (typeof v !== 'object' || v === null) return String(v);
    const m = v as { drug: string; dose?: number | null };
    return `${show(m.drug)}@${'dose' in m ? String(m.dose) : '-'}`;
  };
  return fields.map((f) => show(meds[f])).join('|');
}

/** The cascade's card ids for each combination, keyed by `keyOf`. */
function cardIds(calc: CalculateHealthResults, cascade: Cascade, fields: Record<string, unknown[]>): Record<string, string> {
  const names = Object.keys(fields);
  return Object.fromEntries(combinations(fields).map((meds) => [
    keyOf(names, meds),
    calc(cascade.inputs as never, 'si', meds).suggestions.map((s) => s.id).filter((id) => id.startsWith(cascade.prefix)).join(','),
  ]));
}

const sha256 = (rows: Record<string, string>) =>
  createHash('sha256').update(Object.entries(rows).map(([k, v]) => `${k} => ${v}`).join('\n')).digest('hex');

export interface GoldenRecord {
  source: string;
  /** Each cascade's fields, in key order. */
  fields: Record<'weight' | 'lipid', string[]>;
  weight: Record<string, string>;
  lipid: Record<string, string>;
  full: Record<'weight' | 'lipid', { rows: number; sha256: string }>;
}

/** The record for this version of the plan: what the generator writes and the test recomputes. */
export function goldenRecord(calc: CalculateHealthResults, source: string): GoldenRecord {
  const full = (c: Cascade) => {
    const rows = cardIds(calc, c, c.full);
    return { rows: Object.keys(rows).length, sha256: sha256(rows) };
  };
  return {
    source,
    fields: { weight: Object.keys(CASCADES.weight.full), lipid: Object.keys(CASCADES.lipid.full) },
    weight: cardIds(calc, CASCADES.weight, CASCADES.weight.explicit),
    lipid: cardIds(calc, CASCADES.lipid, CASCADES.lipid.explicit),
    full: { weight: full(CASCADES.weight), lipid: full(CASCADES.lipid) },
  };
}
