// US-13 AC13 (rulings D and the owner's plan of 2026-11-15): the review agrees
// with Save. For every generated combination, submitting exactly the rows the
// review says Save writes, through the real writer, writes each of them and
// refuses none; nothing the review calls saved or not saved is among them.
import { describe, it, expect } from 'vitest';
import { classifyImportValues, type ClassifiedValue, type ImportFile } from './import-review';
import { bulkAppendValues } from './record-edits';
import type { ExtractedValue } from './lab-extraction';
import type { RoadmapFile } from './roadmap-file';
import { core, EMPTY, extra, lab, NOW, recordWith } from './import-review.test-helpers';

const HELD = recordWith([
  { kind: 'measurement', metricType: 'systolic_bp', value: 120 },
  { kind: 'measurement', metricType: 'ldl', value: 2.4 },
  { kind: 'lab', metricName: 'ferritin', value: 80, unit: 'µg/L' },
]);
const heldId = (metric: string) => [...HELD.measurements, ...HELD.labValues].find((r) => ('metricType' in r ? r.metricType : r.metricName) === metric)!.id;

/** One extracted value: a core value or the one lab. */
type Spec = { name: string; core?: Partial<ExtractedValue>; lab?: { value: number; unit: string } };
const SPECS: Spec[] = [
  { name: 'systolic 80', core: { metric: 'systolic_bp', valueSI: 80, displayUnit: 'mmHg' } },
  { name: 'systolic 120 (held)', core: { metric: 'systolic_bp', valueSI: 120, displayUnit: 'mmHg' } },
  { name: 'diastolic 120', core: { metric: 'diastolic_bp', valueSI: 120, displayUnit: 'mmHg' } },
  { name: 'diastolic 90', core: { metric: 'diastolic_bp', valueSI: 90, displayUnit: 'mmHg' } },
  { name: 'LDL 500 (out of range)', core: { metric: 'ldl', valueSI: 500 } },
  { name: 'HDL 600 (out of range)', core: { metric: 'hdl', valueSI: 600 } },
  { name: 'LDL 3.1 (held 2.4)', core: { metric: 'ldl', valueSI: 3.1 } },
  { name: 'ferritin 80 (held)', lab: { value: 80, unit: 'µg/L' } },
];
const HELD_METRIC: Record<string, string> = { systolic_bp: 'systolic_bp', ldl: 'ldl' };

/** The file for one combination: core values as `v<i>`, the lab as `a<i>`. */
function fileFor(specs: Spec[], opts: { untickFirst: boolean; replace: boolean }): ImportFile {
  const values = specs.filter((s) => s.core).map((s) => core(s.core));
  const additionalValues = specs.filter((s) => s.lab).map((s) => extra(s.lab));
  const refs = [...values.map((_, i) => `v${i}`), ...additionalValues.map((_, i) => `a${i}`)];
  const replaces = opts.replace ? Object.fromEntries([
    ...values.flatMap((v, i) => (HELD_METRIC[v.metric] ? [[`v${i}`, heldId(HELD_METRIC[v.metric])]] : [])),
    ...additionalValues.map((_, i) => [`a${i}`, heldId('ferritin')]),
  ]) : undefined;
  return lab({ values, additionalValues }, { unsent: opts.untickFirst ? refs.slice(0, 1) : [], replaces });
}

/** The property: Save's rows all write, none is refused, and only `writes` values are among them. */
function agrees(file: ImportFile, record: RoadmapFile): void {
  const { values, rows } = classifyImportValues([file], record, NOW);
  const run = bulkAppendValues(record, rows, NOW);
  expect(run.outcomes).toEqual(rows.map(() => 'written'));
  expect(run.refused).toEqual([]);
  expect(run.measurementRefusals).toEqual([]);
  const writing = values.filter((v) => v.writes);
  expect(writing.map((v) => file.rows[v.ref])).toEqual(rows);
  for (const v of values) {
    if (v.group === 'saved' || v.group === 'notSaved' || v.group === 'waiting') expect(v.writes).toBe(false);
    if (v.group === 'sure' && v.sent) expect(v.writes).toBe(true);
    if (!v.sent) expect(v.writes).toBe(false);
  }
}

const combos: Array<{ specs: Spec[]; record: RoadmapFile; untickFirst: boolean; replace: boolean }> = [];
for (const size of [2, 3]) {
  const pick = (prefix: Spec[]): void => {
    if (prefix.length === size) {
      for (const [record, replaces] of [[EMPTY, [false]], [HELD, [false, true]]] as const) {
        for (const untickFirst of [false, true]) for (const replace of replaces) combos.push({ specs: prefix, record, untickFirst, replace });
      }
      return;
    }
    for (const s of SPECS) pick([...prefix, s]);
  };
  pick([]);
}

describe('the review agrees with Save, generated', () => {
  it(`holds for all ${combos.length} combinations`, () => {
    expect(combos.length).toBe(3456);
    for (const c of combos) {
      try {
        agrees(fileFor(c.specs, c), c.record);
      } catch (e) {
        throw new Error(`${c.specs.map((s) => s.name).join(' + ')} on ${c.record === HELD ? 'a held record' : 'an empty record'}${c.untickFirst ? ', first unticked' : ''}${c.replace ? ', Replace selected' : ''}: ${(e as Error).message}`);
      }
    }
  });
});

describe('the three cases that blocked (owner\'s diagnosis, 2026-11-15)', () => {
  const groups = (values: ClassifiedValue[]) => values.map((v) => ({ ref: v.ref, group: v.group, ...(v.group === 'unsure' ? { reasons: v.reasons } : v.group === 'notSaved' ? { reason: v.reason } : null), writes: v.writes }));

  it('R1: two refused core values on one day each stay unsure, out of range; none competes for a slot', () => {
    const file = lab({ values: [core({ valueSI: 500 }), core({ metric: 'hdl', valueSI: 600 })] });
    const { values, rows } = classifyImportValues([file], EMPTY, NOW);
    expect(groups(values)).toEqual([
      { ref: 'v0', group: 'unsure', reasons: ['outOfRange'], writes: false },
      { ref: 'v1', group: 'unsure', reasons: ['outOfRange'], writes: false },
    ]);
    expect(rows).toEqual([]);
    const equal = classifyImportValues([lab({ values: [core({ valueSI: 500 }), core({ valueSI: 500 })] })], EMPTY, NOW);
    expect(groups(equal.values).map((v) => v.group)).toEqual(['unsure', 'unsure']);
  });

  it('R2: systolic 80, diastolic 120, systolic 80 again: the duplicate is refused with its winner, never "saved"', () => {
    const file = lab({ values: [core({ metric: 'systolic_bp', valueSI: 80 }), core({ metric: 'diastolic_bp', valueSI: 120 }), core({ metric: 'systolic_bp', valueSI: 80 })] });
    const { values, rows } = classifyImportValues([file], EMPTY, NOW);
    expect(groups(values)).toEqual([
      { ref: 'v0', group: 'unsure', reasons: ['outOfRange'], writes: false },
      { ref: 'v1', group: 'unsure', reasons: ['outOfRange'], writes: false },
      { ref: 'v2', group: 'unsure', reasons: ['outOfRange'], writes: false },
    ]);
    expect(rows).toEqual([]);
  });

  it('R3: Replace a held systolic 120 with 80 beside a diastolic 90: Save refuses both, so the review does', () => {
    const file = lab({ values: [core({ metric: 'systolic_bp', valueSI: 80 }), core({ metric: 'diastolic_bp', valueSI: 90 })] }, { replaces: { v0: heldId('systolic_bp') } });
    const { values, rows } = classifyImportValues([file], HELD, NOW);
    expect(groups(values)).toEqual([
      { ref: 'v0', group: 'unsure', reasons: ['outOfRange', 'conflict'], writes: false },
      { ref: 'v1', group: 'unsure', reasons: ['outOfRange'], writes: false },
    ]);
    expect(rows).toEqual([]);
    const real = bulkAppendValues(HELD, Object.values(file.rows), NOW);
    expect(real.outcomes).toEqual(['refused', 'refused']);
  });
});
