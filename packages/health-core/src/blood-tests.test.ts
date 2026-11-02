// The golden (blood-table.golden.json) was taken on a Mac in New Zealand: the plan's `today` and day
// counts are local days at GOLDEN_NOW. Pinned here so CI, which runs in UTC, reads the same days
// (a forks child picks the zone up; see vitest.config.ts).
process.env.TZ = 'Pacific/Auckland';

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bloodTableReport, bloodTestKeyOf, bloodTestRows, FOLD_CREATININE, foldLegacyCoreRows, isCoreRow, labRowSlot, moveBloodMeasurements, toOldShape } from './blood-tests';
import { goldenOf, goldenRecords } from './blood-table.fixtures';
import { readableView } from './readable-rows';
import { derivePlanInputs } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { BLOOD_TEST_METRICS } from './mappings';
import { mergeFiles, rootIdOf } from './merge';
import { migrateFile } from './migrate';
import { appendLabValue, bulkAppendValues } from './record-edits';
import { limitRepresentative } from './lab-limits';
import { CORE_BLOOD_UNITS, createEmptyFile, createLabValue, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { reportedToCanonical } from './units';

const OPTS = { deviceId: 'dev', now: '2026-10-01T00:00:00Z' };

function record(measurements: FileMeasurement[] = [], labValues: FileLabValue[] = []): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'base', now: '2026-01-01T00:00:00Z' });
  return { ...file, measurements, labValues };
}

const m = (id: string, metricType: string, value: number, recordedAt = '2026-05-01', extra: Partial<FileMeasurement> = {}) =>
  createMeasurement({ id, metricType, value, recordedAt, createdAt: `${recordedAt}T08:00:00Z`, ...extra });

const lab = (id: string, metricName: string, value: number, unit: string, recordedAt = '2026-05-01', extra: Partial<FileLabValue> = {}) =>
  createLabValue({ id, metricName, value, unit, recordedAt, createdAt: `${recordedAt}T08:00:00Z`, ...extra });

const migrate = (file: unknown) => migrateFile(JSON.parse(JSON.stringify(file)), OPTS);
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe('US-66 AC1: the core units are pinned', () => {
  it('holds exactly the nine blood tests, each in its canonical unit', () => {
    expect(CORE_BLOOD_UNITS).toEqual({
      hba1c: 'mmol/mol', creatinine: 'µmol/L', psa: 'ng/mL', apob: 'g/L', ldl: 'mmol/L',
      total_cholesterol: 'mmol/L', hdl: 'mmol/L', triglycerides: 'mmol/L', lpa: 'nmol/L',
    });
    expect(Object.keys(CORE_BLOOD_UNITS).sort()).toEqual([...BLOOD_TEST_METRICS].sort());
  });

  it('slots a core row apart from any lab row, even one named "core:ldl"', () => {
    const core = { metricName: 'ldl', core: true as const };
    expect(labRowSlot(core)).toBe('core:ldl');
    expect(labRowSlot({ metricName: 'ldl' })).toBe('lab:ldl');
    expect(labRowSlot({ metricName: 'core:ldl' })).not.toBe('core:ldl');
    // The flag alone does not make a core row: the name must be a core key.
    expect(isCoreRow({ metricName: 'ferritin', core: true })).toBe(false);
  });
});

describe('US-66 AC2: the move', () => {
  it('renames the fields and keeps every other one verbatim, a null externalId and unknown fields included', () => {
    const row = { ...m('a', 'ldl', 3.1, '2026-05-01', { status: 'entered-in-error', correctsId: 'z' }), note: 'kept' } as FileMeasurement;
    const out = migrate(record([row, m('w', 'weight', 80)]));
    expect(out.measurements.map((r) => r.id)).toEqual(['w']);
    expect(out.labValues).toEqual([{
      id: 'a', metricName: 'ldl', value: 3.1, unit: 'mmol/L', referenceLow: null, referenceHigh: null, core: true,
      recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z', source: 'manual', status: 'entered-in-error',
      correctsId: 'z', externalId: null, note: 'kept',
    }]);
  });

  it('is idempotent, and returns the arrays it was given when nothing moves', () => {
    const once = migrate(record([m('a', 'hba1c', 40), m('w', 'weight', 80)]));
    expect(migrate(once)).toEqual(once);
    const vitals = [m('w', 'weight', 80)];
    const labs = [lab('f', 'ferritin', 100, 'µg/L')];
    const out = moveBloodMeasurements(vitals, labs);
    expect(out.measurements).toBe(vitals);
    expect(out.labValues).toBe(labs);
  });

  it('leaves a row that already has a lab field where it is, and readers do not see it (US-65)', () => {
    const odd = { ...m('a', 'ldl', 3.1), unit: 'mg/dL' } as FileMeasurement;
    const out = migrate(record([odd]));
    expect(out.measurements).toHaveLength(1);
    expect(out.measurements[0]).toEqual(odd);
    expect(out.labValues).toEqual([]);
    const view = readableView(out);
    expect(view.file.measurements).toEqual([]);
    expect(view.count).toBe(1);
  });

  it('a blood row left in measurements counts for neither the plan nor the reminders (US-66 AC7)', () => {
    const odd = { ...m('a', 'ldl', 3.1, '2026-05-01'), unit: 'mg/dL' } as FileMeasurement;
    const profile = { ...createEmptyFile(OPTS).profile, sex: 'male' as const, birthYear: 1970, birthMonth: 1 };
    const out = migrate({ ...record([odd]), profile });
    const without = migrate({ ...record([]), profile });
    const now = new Date('2026-10-01T00:00:00Z');
    expect(derivePlanInputs(out).inputs.ldlC).toBeUndefined();
    expect(computeReminderSchedule(out, now)).toEqual(computeReminderSchedule(without, now));
  });

  it('moves an unreadable row too, content kept, and readers still skip it (US-65 AC1)', () => {
    const bad = { ...m('a', 'ldl', 0), value: 'three' } as unknown as FileMeasurement;
    const out = migrate(record([bad]));
    expect(out.measurements).toEqual([]);
    expect(out.labValues[0]).toMatchObject({ id: 'a', value: 'three', core: true });
    const view = readableView(out);
    expect(view.file.labValues).toEqual([]);
    expect(view.count).toBe(1);
  });
});

describe('US-66 AC2/AC10: quarantined ids and their chains survive the move', () => {
  // v2: one device wrote id X for 3.0, another reused X for 3.5 on the same day; the
  // merge quarantined one under a #dup- id, and a correction points at that id.
  const a = () => record([m('X', 'ldl', 3.0, '2026-05-01')]);
  const b = () => record([m('X', 'ldl', 3.5, '2026-05-01', { createdAt: '2026-05-01T09:00:00Z' })]);

  it('keeps the v2 ids, the winner and the chain, in both orders', () => {
    const v2 = mergeFiles(a(), b(), OPTS);
    const dup = v2.measurements.find((r) => r.id.startsWith('X#dup-'))!;
    const winner = v2.measurements.find((r) => r.id === 'X')!;
    const corrected = {
      ...v2,
      measurements: [
        ...v2.measurements.map((r) => (r.id === dup.id ? { ...r, status: 'entered-in-error' as const } : r)),
        m('fix', 'ldl', 3.6, '2026-05-01', { createdAt: '2026-05-02T08:00:00Z', correctsId: dup.id, source: 'manual_correction' }),
      ],
    };
    const moved = migrate(corrected);
    for (const merged of [mergeFiles(moved, migrate(a()), OPTS), mergeFiles(migrate(b()), moved, OPTS)]) {
      const rows = merged.labValues;
      expect(rows.find((r) => r.id === 'X')?.value).toBe(winner.value);
      expect(rows.find((r) => r.id === dup.id)?.value).toBe(dup.value);
      expect(rows.find((r) => r.id === 'fix')?.correctsId).toBe(dup.id);
      expect(rows.filter((r) => r.status === 'active').map((r) => r.id)).toEqual(['fix']);
      expect(rows).toHaveLength(3);
    }
  });

  it('quarantines two rows that share an id after the move, before a reader sees them', () => {
    // An agent reused one id across the two arrays (the known limit, design §4).
    const out = migrate(record([m('X', 'ldl', 3.0)], [lab('X', 'ferritin', 100, 'µg/L')]));
    const ids = out.labValues.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.filter((id) => id === 'X')).toHaveLength(1);
    expect(ids.some((id) => id.startsWith('X#dup-'))).toBe(true);
  });
});

describe('US-66 AC5: old lab rows named like a core test', () => {
  it('folds a convertible mg/dL LDL, bounds converted alike, and flips the printed row', () => {
    const out = migrate(record([], [lab('p', 'LDL Cholesterol', 100, 'mg/dL', '2026-05-01', { referenceLow: null, referenceHigh: 130 })]));
    const printed = out.labValues.find((r) => r.id === 'p')!;
    const fold = out.labValues.find((r) => r.id === 'p#core')!;
    expect(printed.status).toBe('entered-in-error');
    expect(fold).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, status: 'active', correctsId: 'p', referenceLow: null,
      recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z' });
    expect(fold.value).toBeCloseTo(reportedToCanonical('ldl', 100, 'mg/dL')!.valueSI, 9);
    expect(fold.referenceHigh).toBeCloseTo(reportedToCanonical('ldl', 130, 'mg/dL')!.valueSI, 9);
    expect(bloodTestRows(out).map((r) => r.id)).toEqual(['p#core']);
  });

  it('folds a same-scale spelling with the number unchanged', () => {
    const out = migrate(record([], [lab('p', 'PSA', 1.2, 'ug/L')]));
    expect(out.labValues.find((r) => r.id === 'p#core')).toMatchObject({ metricName: 'psa', value: 1.2, unit: 'ng/mL' });
  });

  it('folds Lp(a) in mg/dL by the average factor, as a typed one converts', () => {
    const out = migrate(record([], [lab('p', 'Lp(a)', 50, 'mg/dL')]));
    expect(out.labValues.find((r) => r.id === 'p#core')!.value).toBeCloseTo(reportedToCanonical('lpa', 50, 'mg/dL')!.valueSI, 9);
  });

  it('leaves a garbled unit, an out-of-range value and creatinine as extra rows', () => {
    expect(FOLD_CREATININE).toBe(false);
    const rows = [
      lab('g', 'LDL', 3, 'mmol'),
      lab('r', 'HbA1c', 900, 'mmol/mol'),
      lab('c', 'Creatinine', 80, 'umol/L'),
    ];
    const out = migrate(record([], rows));
    expect(out.labValues).toEqual(rows);
    expect(bloodTestRows(out)).toEqual([]);
  });

  it('a fold for a day that holds a core value is born entered-in-error', () => {
    const out = migrate(record([m('core', 'ldl', 3.0, '2026-05-01')], [lab('p', 'LDL-C', 120, 'mg/dL', '2026-05-01', { createdAt: '2026-06-01T00:00:00Z' })]));
    expect(out.labValues.find((r) => r.id === 'p#core')!.status).toBe('entered-in-error');
    expect(bloodTestRows(out).map((r) => r.id)).toEqual(['core']);
  });

  it('two folds for one day: the newer createdAt stays active', () => {
    const out = migrate(record([], [
      lab('p1', 'LDL', 3.0, 'mmol/L', '2026-05-01', { createdAt: '2026-05-01T08:00:00Z' }),
      lab('p2', 'LDL Cholesterol', 3.2, 'mmol/L', '2026-05-01', { createdAt: '2026-05-01T09:00:00Z' }),
    ]));
    expect(bloodTestRows(out).map((r) => r.id)).toEqual(['p2#core']);
    expect(out.labValues.find((r) => r.id === 'p1#core')!.status).toBe('entered-in-error');
    expect(foldLegacyCoreRows(out.labValues)).toBe(out.labValues);
  });

  it('in merge a fold loses its slot to a real core value, whatever the clocks say, in both orders', () => {
    // Device A has not synced the upload's core value; device B has.
    const withFold = migrate(record([], [lab('p', 'LDL', 3.2, 'mmol/L', '2026-05-01', { createdAt: '2026-07-01T00:00:00Z' })]));
    const withCore = migrate(record([m('core', 'ldl', 3.0, '2026-05-01', { createdAt: '2026-05-01T00:00:00Z' })]));
    for (const merged of [mergeFiles(withFold, withCore, OPTS), mergeFiles(withCore, withFold, OPTS)]) {
      expect(bloodTestRows(merged).map((r) => r.id)).toEqual(['core']);
    }
  });

  it('rootIdOf strips #core in one alternation with #si and #dup-', () => {
    expect(rootIdOf('X#core')).toBe('X');
    expect(rootIdOf('X#dup-0a1b2c3d#core')).toBe('X');
    expect(rootIdOf('X#core#dup-0a1b2c3d')).toBe('X');
  });

  it('an erase listing the printed row takes its fold with it', () => {
    const raw = { ...record([], [lab('p', 'LDL', 3.2, 'mmol/L')]), meta: { ...record().meta, eraseEpoch: 1 }, erasedRows: { fromEpoch: 1, ids: ['p'] } };
    expect(migrate(raw).labValues).toEqual([]);
  });
});

describe('US-66 AC7: the plan, reminders and tiles are the same before and after the move', () => {
  const golden = JSON.parse(readFileSync(`${__dirname}/blood-table.golden.json`, 'utf8'));
  for (const [name, raw] of Object.entries(goldenRecords())) {
    it(`${name}: identical to the golden taken before the move`, () => {
      expect((raw as RoadmapFile).measurements.some((r) => (BLOOD_TEST_METRICS as readonly string[]).includes(r.metricType))).toBe(true);
      expect(JSON.parse(JSON.stringify(goldenOf(raw)))).toEqual(golden[name]);
    });
  }
});

describe('US-66 AC10: merge commutes with the move', () => {
  // A small deterministic generator: v2 records with blood rows, vitals,
  // corrections, reused ids (quarantined by the merge) and catalogued lab rows.
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  function randomRecord(rand: () => number, side: string): RoadmapFile {
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const days = ['2026-05-01', '2026-05-02', '2026-05-03'];
    const measurements: FileMeasurement[] = [];
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const metric = pick(['ldl', 'hba1c', 'lpa', 'weight']);
      // Shared ids across the two sides: same content (one fact) or not (quarantined).
      // Never shared between a vital and a blood test: that is the known limit (design §4).
      const id = rand() < 0.4 ? `shared${metric === 'weight' ? 'v' : 'b'}${Math.floor(rand() * 3)}` : `${side}${i}`;
      const day = pick(days);
      const row = m(id, metric, pick([3, 40, 80]), day, { createdAt: `${day}T0${Math.floor(rand() * 3)}:00:00Z` });
      measurements.push(row);
      if (rand() < 0.3 && !measurements.some((r) => r.correctsId === row.id)) {
        row.status = 'entered-in-error';
        measurements.push(m(`${row.id}-fix-${side}`, row.metricType, row.value + 1, day, { createdAt: `${day}T05:00:00Z`, correctsId: row.id }));
      }
    }
    const labValues = rand() < 0.5 ? [lab(`fer-${side}`, 'ferritin', 100, 'µg/L', pick(days))] : [];
    return record(measurements, labValues);
  }
  const normal = (file: RoadmapFile) => ({ ...file, meta: { ...file.meta, updatedAt: '' }, measurements: byId(file.measurements), labValues: byId(file.labValues) });

  it('merge(migrate(a), migrate(b)) is symmetric and equals migrate(merge_v2(a, b))', () => {
    const rand = rng(66);
    for (let run = 0; run < 200; run++) {
      const a = randomRecord(rand, 'a');
      const b = randomRecord(rand, 'b');
      const ab = mergeFiles(migrate(a), migrate(b), OPTS);
      const ba = mergeFiles(migrate(b), migrate(a), OPTS);
      expect(normal(ab)).toEqual(normal(ba));
      // merge_v2: today's merge on the old shape, before any move.
      const v2 = migrate(mergeFiles(a, b, OPTS));
      expect(normal(ab).measurements).toEqual(normal(v2).measurements);
      expect(normal(ab).labValues).toEqual(normal(v2).labValues);
    }
  });
});

describe('US-66 AC14: toOldShape is the exact inverse of the move', () => {
  it('rebuilds the old rows byte for byte and leaves folds and other lab rows', () => {
    const v2 = record(
      [m('a', 'ldl', 3, '2026-05-01'), m('w', 'weight', 80), { ...m('b', 'lpa', 100), externalId: null, note: 'x' } as FileMeasurement],
      [lab('f', 'ferritin', 100, 'µg/L'), lab('p', 'LDL', 3.2, 'mmol/L', '2026-05-02')],
    );
    const moved = migrate(v2);
    const back = toOldShape(moved);
    expect(byId(back.measurements)).toEqual(byId(v2.measurements));
    expect(byId(back.labValues).map((r) => r.id)).toEqual(['f', 'p', 'p#core']);
  });
});

// The merge of origin/main (2026-11-02): a lab limit (US-12 AC20) survives every US-66 path.
describe('US-66 AC2/AC14 with US-12 AC20: a limit survives the move', () => {
  it('a moved blood measurement keeps its comparator, its id and its #dup- id', () => {
    const a = () => record([m('X', 'ldl', 1.5, '2026-05-01', { source: 'lab_import', comparator: '<' })]);
    const b = () => record([m('X', 'ldl', 1.5, '2026-05-01', { source: 'lab_import', comparator: '>', createdAt: '2026-05-01T09:00:00Z' })]);
    const v2 = mergeFiles(a(), b(), OPTS);
    const dup = v2.measurements.find((r) => r.id.startsWith('X#dup-'))!;
    const moved = migrate(v2);
    expect(moved.measurements).toEqual([]);
    expect(byId(moved.labValues).map((r) => [r.id, r.core, r.comparator])).toEqual(byId(v2.measurements).map((r) => [r.id, true, r.comparator]));
    // The content hash reads the old form, comparator included, so a merge in either order keeps the same ids.
    for (const merged of [mergeFiles(moved, migrate(a()), OPTS), mergeFiles(migrate(b()), moved, OPTS)]) {
      expect(byId(merged.labValues).map((r) => [r.id, r.comparator])).toEqual([['X', v2.measurements.find((r) => r.id === 'X')!.comparator], [dup.id, dup.comparator]]);
    }
  });

  it('toOldShape gives back a limit as it was written', () => {
    const v2 = record([m('a', 'hdl', 1.5, '2026-05-01', { source: 'lab_import', comparator: '>' }), m('b', 'hdl', 1.2, '2026-04-01')]);
    const back = toOldShape(migrate(v2));
    expect(byId(back.measurements)).toEqual(byId(v2.measurements));
    expect('comparator' in back.measurements.find((r) => r.id === 'b')!).toBe(false);
  });

  it('an upload\'s "< 40 mg/dL" LDL is a core row with its comparator, graded by the limit rule', () => {
    const graded = (value: number) => {
      const { file, saved } = bulkAppendValues(record(), [
        { kind: 'lab', metricName: 'LDL Cholesterol', value, unit: 'mg/dL', comparator: '<', recordedAt: '2026-05-01', source: 'lab_import' },
      ], OPTS.now);
      expect(saved).toHaveLength(1);
      const [row] = file.labValues;
      expect(row).toMatchObject({ core: true, metricName: 'ldl', unit: CORE_BLOOD_UNITS.ldl, comparator: '<' });
      expect(row.value).toBeCloseTo(reportedToCanonical('ldl', value, 'mg/dL')!.valueSI, 9);
      const { inputs } = derivePlanInputs(file, new Date(OPTS.now));
      // US-12 AC20: the plan grades a limit only when the bound decides.
      const representative = limitRepresentative('ldlC', '<', row.value);
      expect(inputs.limits?.ldlC).toEqual({ comparator: '<', bound: row.value, graded: representative !== null });
      expect(inputs.ldlC).toBe(representative ?? undefined);
      return inputs.limits!.ldlC!.graded;
    };
    // One bound below every LDL cutoff decides; one between cutoffs does not.
    expect([graded(30), graded(120)]).toEqual([true, false]);
  });
});

describe('US-66 AC13: the usage counts', () => {
  it('counts moved, folded and kept-apart rows, never a value', () => {
    const before = record(
      [m('a', 'ldl', 3), m('w', 'weight', 80)],
      [lab('p', 'LDL', 3.2, 'mmol/L', '2026-05-02'), lab('c', 'Creatinine', 80, 'umol/L'), lab('g', 'HbA1c', 5, 'mmol')],
    );
    expect(bloodTableReport(before, migrate(before))).toEqual({ moved: 1, folded: 1, keptApart: 2 });
  });

  it('caps each count at 1000', () => {
    const many = Array.from({ length: 1001 }, (_, i) => m(`r${i}`, 'ldl', 3, `2020-01-01`));
    expect(bloodTableReport(record(many), migrate(record(many))).moved).toBe(1000);
  });
});

describe('US-66 AC4: one resolver, punctuation forgiven after the exact names', () => {
  it.each([
    ['LDL - Cholesterol', 'ldl'],
    ['Cholesterol, HDL', 'hdl'],
    ['HbA1c:', 'hba1c'],
    ['Lp(a)', 'lpa'],
  ])('"%s" is the core test %s', (name, key) => {
    expect(bloodTestKeyOf(name)).toBe(key);
  });

  it.each(['Non-HDL Cholesterol', 'Chol/HDL ratio', 'Cholesterol/HDL', 'TC/HDL', 'LDL/HDL', 'HDL/LDL ratio', 'Cholesterol:HDL', 'Cholesterol: HDL', 'HDL:Cholesterol', 'Cr:', 'Cr -', '(Cr)', 'Cr,', 'Weight', 'Systolic BP'])(
    '"%s" is no core blood test', (name) => {
      expect(bloodTestKeyOf(name)).toBeNull();
    },
  );

  it('files a punctuated core name as its core row', () => {
    const file = migrate(record());
    const out = appendLabValue(file, { metricName: 'LDL - Cholesterol', value: 116, unit: 'mg/dL', recordedAt: '2026-05-01', now: OPTS.now });
    expect(out.ok && out.row).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true });
  });
});
