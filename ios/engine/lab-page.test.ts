// US-25 AC25: a lab test's page on the iPhone, as the web's lab value page (ValuePage.tsx): its
// history through the history door (historyJson with series "lab"), and adding and correcting a
// value through the web's own writes (bulkAppendValues, correctValue), so the record keeps its
// FHIR rules: append-only, a correction names the row it replaces and flips it to
// entered-in-error, one active row per test and day. Synthetic values.
import { describe, expect, it } from 'vitest';
import { applyEdit, newRecord } from './my-data';
import { historyJson } from './entry';
import { labHistory } from './my-data-forms';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';

const lab = (id: string, metricName: string, value: number, unit: string, day: string, extra: Partial<RoadmapFile['labValues'][number]> = {}): RoadmapFile['labValues'][number] => ({
  id, metricName, value, unit, referenceLow: 30, referenceHigh: 400, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`,
  source: 'lab_import', status: 'active', correctsId: null, ...extra,
});

function record(labValues: RoadmapFile['labValues']): RoadmapFile {
  return { ...newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), labValues };
}

const ferritin = () => record([
  lab('f1', 'ferritin', 80, 'µg/L', '2026-08-01'),
  lab('f2', 'ferritin', 95, 'µg/L', '2026-09-01', { status: 'entered-in-error' }),
  lab('f3', 'ferritin', 90, 'µg/L', '2026-09-01', { correctsId: 'f2', source: 'manual_correction', createdAt: '2026-09-02T09:00:00.000Z' }),
  lab('f4', 'Ferritin', 20, 'ng/mL', '2026-10-01', { comparator: '<' }),
  lab('s1', 'sodium', 140, 'mmol/L', '2026-10-01'),
]);

describe('the history door for a lab test (US-25 AC25)', () => {
  it('lists every row of the series newest first, the struck one under its correction, a limit with its symbol and bound', () => {
    const history = labHistory(ferritin(), 'ferritin');
    expect(history).toMatchObject({ metric: 'ferritin', label: 'Ferritin', unit: 'µg/L', excluded: false, markers: [] });
    expect(history.units).toBeUndefined();
    expect(history.rows.map((r) => [r.id, r.value, r.day, r.status, r.correction, r.current])).toEqual([
      ['f4', '< 20', '2026-10-01', 'active', false, false],
      ['f3', '90', '2026-09-01', 'active', true, false],
      ['f2', '95', '2026-09-01', 'entered-in-error', false, false],
      ['f1', '80', '2026-08-01', 'active', false, false],
    ]);
    expect(history.rows[0].bound).toBe(20);
    expect(history.rows[1].bound).toBeUndefined();
    // The web's lab rows are never graded, so no limit note there either.
    expect(history.rows.every((r) => r.note === undefined)).toBe(true);
  });

  it('a series in more than one unit carries each row\'s unit and the units, so the page draws no chart (US-21 AC3a)', () => {
    const history = labHistory(record([lab('z1', 'zinc_custom', 12, 'µmol/L', '2026-08-01'), lab('z2', 'zinc_custom', 80, 'µg/dL', '2026-09-01')]), 'zinc custom');
    expect(history.units).toEqual(['µg/dL', 'µmol/L']);
    expect(history.rows.map((r) => [r.value, r.unit])).toEqual([['80', 'µg/dL'], ['12', 'µmol/L']]);
  });

  it('answers through historyJson with series "lab", and as before without it', () => {
    const text = JSON.stringify(ferritin());
    expect(JSON.parse(historyJson(text, 'ferritin', NOW, 'phone', '{}', 'lab')).rows).toHaveLength(4);
    // Without it, as before AC25: a lab key is no core metric, and the read fails (the app then shows no history).
    expect(() => historyJson(text, 'ferritin', NOW, 'phone', '{}')).toThrow();
  });
});

describe('adding and correcting a lab value (US-25 AC25)', () => {
  const add = (file: RoadmapFile, value: number, day?: string) => applyEdit(file, { kind: 'labAdd', series: 'ferritin', value, day }, NOW);

  it('adds a value on a new day in the series\' unit, as the web\'s lab add does, and appends only', () => {
    const before = ferritin();
    const out = add(before, 110, '2026-10-10');
    if (!out.ok) throw new Error(out.message);
    const added = out.file.labValues.at(-1)!;
    expect(added).toMatchObject({ metricName: 'ferritin', value: 110, unit: 'µg/L', recordedAt: '2026-10-10T00:00:00.000Z', source: 'manual', status: 'active', correctsId: null });
    expect(out.file.labValues.slice(0, -1)).toEqual(before.labValues);
  });

  it('refuses a day that holds the test, naming the row a replace would correct (one active row per test and day)', () => {
    const out = add(ferritin(), 85, '2026-08-01');
    expect(out).toMatchObject({ ok: false, reason: 'slot-occupied', existingId: 'f1', message: 'That test already has 80 µg/L for that date.' });
  });

  it('refuses a future day, a negative number and a test the record does not hold', () => {
    expect(add(ferritin(), 85, '2026-10-30')).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(add(ferritin(), -1, '2026-10-10')).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(ferritin(), { kind: 'labAdd', series: 'b12', value: 300, day: '2026-10-10' }, NOW)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('corrects a lab value as the web does: a new row names the old, which turns entered-in-error; the day holds one active row', () => {
    const out = applyEdit(ferritin(), { kind: 'correct', id: 'f1', value: 85 }, NOW);
    if (!out.ok) throw new Error(out.message);
    const old = out.file.labValues.find((r) => r.id === 'f1')!;
    const fresh = out.file.labValues.at(-1)!;
    expect(old.status).toBe('entered-in-error');
    expect(fresh).toMatchObject({ metricName: 'ferritin', value: 85, unit: 'µg/L', recordedAt: '2026-08-01T00:00:00.000Z', correctsId: 'f1', status: 'active', source: 'manual_correction' });
    expect(out.file.labValues.filter((r) => r.recordedAt.startsWith('2026-08-01') && r.status === 'active')).toHaveLength(1);
    // A correction is exact: correcting the limit "< 20" leaves the symbol behind.
    const limit = applyEdit(ferritin(), { kind: 'correct', id: 'f4', value: 15 }, NOW);
    if (!limit.ok) throw new Error(limit.message);
    expect(limit.file.labValues.at(-1)!.comparator).toBeUndefined();
  });

  it('refuses to correct a row already entered in error', () => {
    expect(applyEdit(ferritin(), { kind: 'correct', id: 'f2', value: 99 }, NOW)).toMatchObject({ ok: false, reason: 'not-active' });
  });
});
