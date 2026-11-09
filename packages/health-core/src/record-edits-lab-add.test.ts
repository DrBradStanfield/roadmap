// US-25 AC25, US-21: the one lab add both apps use (record-edits.ts addLabValue): the web's
// "+ Add a value" (AddLabTest.tsx) and the iPhone's lab page. Synthetic values.
import { describe, expect, it } from 'vitest';
import { addLabValue, appendLabValue, bulkAppendValues, correctValue } from './record-edits';
import { LAB_CATALOG, LAB_PLAUSIBLE_RANGES } from './lab-catalog';
import { groupLabValues, labUnitRefusalLine } from './lab-series';
import { createEmptyFile, type FileLabValue, type RoadmapFile } from './roadmap-file';
import { createCoreRow } from './blood-tests';
import { reportedToCanonical } from './units';

const NOW = '2026-10-21T08:00:00.000Z';
const held = (id: string, metricName: string, value: number, unit: string, day: string): FileLabValue => ({
  id, metricName, value, unit, referenceLow: null, referenceHigh: null, recordedAt: `${day}T00:00:00.000Z`, createdAt: NOW,
  source: 'lab_import', status: 'active', correctsId: null,
});
const record = (labValues: FileLabValue[]): RoadmapFile => ({ ...createEmptyFile({ deviceId: 'd', now: NOW }), labValues });

describe('addLabValue (US-25 AC25)', () => {
  it('files a catalogued test in its catalogue unit under the catalogue key; any other under the name and unit given', () => {
    const exact = addLabValue(record([]), { metricName: 'Ferritin', unit: 'ng/mL', value: 90, day: '2026-10-01' }, NOW);
    if (!exact.ok) throw new Error(exact.message);
    expect(exact.row).toMatchObject({ metricName: 'ferritin', unit: 'µg/L', value: 90, source: 'manual', status: 'active', correctsId: null });
    const converted = addLabValue(record([]), { metricName: 'Vitamin D', unit: 'ng/mL', value: 32, day: '2026-10-01' }, NOW);
    if (!converted.ok) throw new Error(converted.message);
    expect(converted.row).toMatchObject({ metricName: 'Vitamin D', unit: 'nmol/L' });
    const custom = addLabValue(record([]), { metricName: 'Zinc custom', unit: 'µg/dL', value: 80, day: '2026-10-01' }, NOW);
    if (!custom.ok) throw new Error(custom.message);
    expect(custom.row).toMatchObject({ metricName: 'Zinc custom', unit: 'µg/dL' });
  });

  it('refuses a taken day, offering the held row only when it is another number in the same unit (sameLabQuantity)', () => {
    const file = record([held('f1', 'ferritin', 80, 'µg/L', '2026-10-01')]);
    expect(addLabValue(file, { metricName: 'ferritin', unit: 'µg/L', value: 85, day: '2026-10-01' }, NOW))
      .toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/L for that date.', existingId: 'f1' });
    expect(addLabValue(file, { metricName: 'ferritin', unit: 'µg/L', value: 80, day: '2026-10-01' }, NOW))
      .toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/L for that date.' });
  });

  it('refuses a negative number, a future day, no name and a unit the catalogue does not take', () => {
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'µg/L', value: -1, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'µg/L', value: 1, day: '2026-10-30' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(addLabValue(record([]), { metricName: ' ', unit: 'µg/L', value: 1, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'mg/dL', value: 1, day: '2026-10-01' }, NOW))
      .toMatchObject({ ok: false, reason: 'unknown-unit', message: expect.stringMatching(/^Ferritin: unit not recognised \(mg\/dL\)/) });
  });
});

// US-73 AC8 (with US-66 AC6): a vital is no lab test, and a test nothing names needs the unit it was
// reported in, as appendLabValue refuses both (record-edits.test.ts, the MCP tools).
describe('addLabValue — a vital\'s name or no unit (US-73 AC8)', () => {
  it('refuses a vital\'s name: weight, height, blood pressure, waist', () => {
    // Blood pressure by its own name too, which names no one core metric (review round 3).
    for (const metricName of ['Weight', 'height', 'Systolic BP', 'Waist', 'Blood pressure', 'BP', 'blood pressure (systolic)', 'Blood Pressure - Diastolic', 'BP systolic', 'bp diastolic']) {
      expect(addLabValue(record([]), { metricName, unit: 'kg', value: 80, day: '2026-10-01' }, NOW), metricName)
        .toEqual({ ok: false, reason: 'core-metric', message: `"${metricName}" is not a lab test: add it from its own row.` });
    }
  });

  it('a kept-apart lab series named like a vital takes no add by name, only its own page\'s "+" (US-25 AC25)', () => {
    const file = record([held('w1', 'Weight', 70, 'kg', '2026-09-01')]);
    expect(addLabValue(file, { metricName: 'Weight', unit: 'kg', value: 71, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'core-metric' });
    const out = addLabValue(file, { metricName: 'Weight', unit: 'kg', value: 71, day: '2026-10-01', existingSeries: true }, NOW);
    if (!out.ok) throw new Error(out.message);
    expect(out.row).toMatchObject({ metricName: 'Weight', unit: 'kg', value: 71 });
  });

  it('a series saved with no unit (a lab import\'s INR) takes its page\'s "+", never an add by name (US-25 AC25)', () => {
    const saved = bulkAppendValues(record([]), [{ kind: 'lab', metricName: 'INR', value: 1.1, unit: '', recordedAt: '2026-09-01T00:00:00.000Z', source: 'lab_import' }], NOW);
    expect(saved.saved).toHaveLength(1);
    const out = addLabValue(saved.file, { metricName: 'INR', unit: '', value: 1.2, day: '2026-10-01', existingSeries: true }, NOW);
    if (!out.ok) throw new Error(out.message);
    expect(out.row).toMatchObject({ metricName: 'INR', unit: '', value: 1.2, source: 'manual' });
    expect(addLabValue(record([]), { metricName: 'INR', unit: '', value: 1.2, day: '2026-10-01' }, NOW))
      .toEqual({ ok: false, reason: 'invalid-value', message: 'A lab value needs the unit the lab reported it in' });
  });

  it('existingSeries adds only to a series the record holds: an active, non-core row of that test (US-25 AC25)', () => {
    const none = { ok: false, reason: 'not-found', message: 'There is no such lab test in your record.' };
    const add = (file: RoadmapFile, metricName: string, unit: string) => addLabValue(file, { metricName, unit, value: 1.2, day: '2026-10-01', existingSeries: true }, NOW);
    // Never a new vital-named or unit-less series.
    expect(add(record([]), 'Weight', 'kg')).toEqual(none);
    expect(add(record([]), 'INR', '')).toEqual(none);
    expect(add(record([held('f1', 'ferritin', 80, 'µg/L', '2026-09-01')]), 'INR', '')).toEqual(none);
    // A withdrawn row or a core row holds no lab series.
    expect(add(record([{ ...held('i1', 'INR', 1.1, '', '2026-09-01'), status: 'entered-in-error' }]), 'INR', '')).toEqual(none);
    const core = createCoreRow({ id: 'c1', metric: 'ldl', value: 3, recordedAt: '2026-09-01T00:00:00.000Z', createdAt: NOW, source: 'manual' });
    expect(add(record([core]), 'ldl', 'mmol/L')).toEqual(none);
    // Any spelling of the held test, and a legacy row with no status, holds it.
    expect(add(record([held('i1', 'INR', 1.1, '', '2026-09-01')]), 'inr', '')).toMatchObject({ ok: true });
    const { status: _status, ...legacy } = held('z1', 'Zinc custom', 80, 'µg/dL', '2026-09-01');
    expect(add(record([legacy as FileLabValue]), 'Zinc custom', 'µg/dL')).toMatchObject({ ok: true });
  });

  it('refuses a test nothing names with no unit, in appendLabValue\'s words', () => {
    for (const unit of ['', '  ']) {
      expect(addLabValue(record([]), { metricName: 'Zinc custom', unit, value: 80, day: '2026-10-01' }, NOW))
        .toEqual({ ok: false, reason: 'invalid-value', message: 'A lab value needs the unit the lab reported it in' });
    }
  });
});

// US-66 AC6 (with US-21 AC13): a core test's name writes its core row, so a held day names the core
// value in the unit typed and offers it for replacing, and a number out of range says so: never
// "already has a value" for a day that holds nothing.
describe('addLabValue — a core test by name (US-66 AC6)', () => {
  const si = reportedToCanonical('ldl', 116, 'mg/dL')!.valueSI;
  const core = createCoreRow({ id: 'c1', metric: 'ldl', value: si, recordedAt: '2026-10-01T00:00:00.000Z', createdAt: NOW, source: 'manual' });
  const ldl = (value: number, file = record([core])) => addLabValue(file, { metricName: 'LDL-C', unit: 'mg/dL', value, day: '2026-10-01' }, NOW);

  it('names the held core value in the unit typed, and offers it when the number differs', () => {
    expect(ldl(131)).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 116 mg/dL for that date.', existingId: 'c1' });
    expect(ldl(116)).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 116 mg/dL for that date.' });
  });

  it('a number out of range is refused as one, naming the end it missed', () => {
    expect(ldl(99999, record([]))).toMatchObject({ ok: false, reason: 'invalid-value', bound: 'above' });
  });

  it('a free day writes the core row in its canonical unit', () => {
    const added = ldl(131, record([]));
    if (!added.ok) throw new Error(added.message);
    expect(added.row).toMatchObject({ metricName: 'ldl', unit: 'mmol/L', core: true, source: 'manual' });
  });
});

// US-21 AC26 (Brad 2026-11-06): a typed catalogue value past its test's plausible range, in the
// stored SI unit after conversion, is a typing or unit mistake and is refused. A break-test typed
// glucose 5.5, picked mg/dL and saved 0.31 mmol/L with no warning. Synthetic values.
describe('addLabValue — plausible range (US-21 AC26)', () => {
  const add = (metricName: string, unit: string, value: number, file = record([]), existingSeries?: true) =>
    addLabValue(file, { metricName, unit, value, day: '2026-10-01', ...(existingSeries ? { existingSeries } : null) }, NOW);

  it('refuses glucose 5.5 mg/dL (0.31 mmol/L), saying what it converted to', () => {
    const out = add('Glucose', 'mg/dL', 5.5);
    expect(out).toEqual({
      ok: false, reason: 'invalid-value',
      message: '5.5 mg/dL is 0.31 mmol/L. Glucose below 0.5 mmol/L is almost certainly a typing or unit mistake: check the number and its unit.',
    });
  });

  it('refuses it from the test\'s own page too (the iPhone\'s and web\'s "+ Add a value")', () => {
    const file = record([held('g1', 'glucose', 5.2, 'mmol/L', '2026-09-01')]);
    expect(add('glucose', 'mg/dL', 5.5, file, true)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('refuses a value past either end in the canonical unit, with no conversion clause', () => {
    expect(add('glucose', 'mmol/L', 151)).toEqual({
      ok: false, reason: 'invalid-value',
      message: 'Glucose above 150 mmol/L is almost certainly a typing or unit mistake: check the number and its unit.',
    });
    expect(add('Haemoglobin', 'g/dL', 140)).toMatchObject({ ok: false, reason: 'invalid-value', message: expect.stringMatching(/^140 g\/dL is 1,400 g\/L\. Haemoglobin above 300 g\/L/) });
  });

  it('formats both numbers alike, thousands separated, at the matrix\'s precision (review round 1)', () => {
    expect(add('glucose', 'mg/dL', 2800)).toMatchObject({
      message: '2,800 mg/dL is 155.43 mmol/L. Glucose above 150 mmol/L is almost certainly a typing or unit mistake: check the number and its unit.',
    });
  });

  it('names a same-scale alias it was typed in, as a conversion (review round 1)', () => {
    expect(add('TSH', 'µIU/mL', 2500)).toMatchObject({
      message: '2,500 µIU/mL is 2,500 mIU/L. TSH above 2,000 mIU/L is almost certainly a typing or unit mistake: check the number and its unit.',
    });
  });

  it('accepts documented survived extremes: HHS glucose 2,656 mg/dL, TSH 1,099 mIU/L (review round 1)', () => {
    expect(add('glucose', 'mg/dL', 2656).ok).toBe(true);
    expect(add('TSH', 'mIU/L', 1099).ok).toBe(true);
  });

  it('accepts both edges, and a converted value just inside', () => {
    for (const value of [0.5, 150]) expect(add('glucose', 'mmol/L', value).ok).toBe(true);
    expect(add('glucose', 'mg/dL', 90).ok).toBe(true);
    expect(add('Glucose (random)', 'mg/dL', 1800).ok).toBe(true);
  });

  it('checks every bound in the table at its edges, in the canonical unit', () => {
    for (const [key, range] of Object.entries(LAB_PLAUSIBLE_RANGES)) {
      const entry = LAB_CATALOG.find((e) => e.key === key);
      expect(entry, key).toBeDefined();
      expect(range.min, key).toBeLessThan(range.max);
      expect(add(key, entry!.unit, range.min).ok, `${key} min`).toBe(true);
      expect(add(key, entry!.unit, range.max).ok, `${key} max`).toBe(true);
      expect(add(key, entry!.unit, range.max * 1.01 + 0.01), `${key} above`).toMatchObject({ ok: false, reason: 'invalid-value' });
      if (range.min > 0) expect(add(key, entry!.unit, range.min * 0.99), `${key} below`).toMatchObject({ ok: false, reason: 'invalid-value' });
    }
  });

  it('leaves a test without a bound, and a test off the catalogue, unchecked', () => {
    expect(add('GGT', 'U/L', 999999).ok).toBe(true);
    expect(add('Zinc custom', 'µg/dL', 999999).ok).toBe(true);
  });

  it('a stored row already past its bound still shows and still takes a new value on another day', () => {
    const file = record([held('g0', 'glucose', 0.3, 'mmol/L', '2026-09-01')]);
    const [series] = groupLabValues(file.labValues).flatMap((group) => group.series);
    expect(series.points).toMatchObject([{ id: 'g0', value: 0.3, unit: 'mmol/L' }]);
    expect(add('glucose', 'mmol/L', 5.4, file).ok).toBe(true);
  });

  it('the agent doors refuse it too, in the same words without the full stop (Brad 2026-11-09)', () => {
    expect(appendLabValue(record([]), { metricName: 'glucose', value: 5.5, unit: 'mg/dL', recordedAt: '2026-10-01', now: NOW })).toEqual({
      ok: false, reason: 'invalid-value', fault: 'implausible', bound: 'below',
      message: '5.5 mg/dL is 0.31 mmol/L. Glucose below 0.5 mmol/L is almost certainly a typing or unit mistake: check the number and its unit',
    });
    expect(appendLabValue(record([]), { metricName: 'glucose', value: 99, unit: 'mg/dL', recordedAt: '2026-10-01', now: NOW }).ok).toBe(true);
  });

  it('an upload through bulkAppendValues refuses the row, saves the rest, and names the bound (Brad 2026-11-09)', () => {
    const result = bulkAppendValues(record([]), [
      { kind: 'lab', metricName: 'Glucose', value: 3000, unit: 'mg/dL', recordedAt: '2026-10-01', source: 'lab_import' },
      { kind: 'lab', metricName: 'Ferritin', value: 90, unit: 'µg/L', recordedAt: '2026-10-01', source: 'lab_import' },
    ], NOW);
    expect(result.saved.map((row) => (row as FileLabValue).metricName)).toEqual(['Ferritin']);
    expect(result.refused).toEqual([{ key: 'glucose', unit: 'mg/dL', fault: 'implausible', bound: 'above', message: expect.stringMatching(/^3,000 mg\/dL is [\d.]+ mmol\/L\. Glucose above 150 mmol\/L/) }]);
    expect(labUnitRefusalLine('glucose', 'mg/dL', 'implausible', 'above'))
      .toBe('Glucose: a value above 150 mmol/L is almost certainly a misread number or unit, so it was not saved. Check the report.');
    expect(labUnitRefusalLine('haemoglobin', 'g/dL', 'implausible', 'below'))
      .toBe('Haemoglobin: a value below 5 g/L is almost certainly a misread number or unit, so it was not saved. Check the report.');
  });
});

// US-21 AC26 (review round 1): a correction is typed too, so the web's value page and matrix, the
// iPhone's correct edit and MCP correct_value refuse what the add refuses. Synthetic values.
describe('correctValue — plausible range (US-21 AC26)', () => {
  const file = () => record([held('g1', 'glucose', 5.2, 'mmol/L', '2026-09-01')]);
  const correct = (newValue: number, unit?: string) => correctValue(file(), { id: 'g1', newValue, ...(unit ? { unit } : null), now: NOW });

  it('refuses a corrected catalogue value past its bound, in the unit typed or the row\'s own', () => {
    expect(correct(5.5, 'mg/dL')).toEqual({
      ok: false, reason: 'invalid-value',
      message: '5.5 mg/dL is 0.31 mmol/L. Glucose below 0.5 mmol/L is almost certainly a typing or unit mistake: check the number and its unit.',
    });
    expect(correct(151)).toMatchObject({ ok: false, reason: 'invalid-value', message: expect.stringMatching(/^Glucose above 150 mmol\/L/) });
  });

  it('still corrects a value inside its bounds, and a test without one', () => {
    expect(correct(99, 'mg/dL').ok).toBe(true);
    expect(correct(5.5).ok).toBe(true);
    const ggt = record([held('t1', 'ggt', 30, 'U/L', '2026-09-01')]);
    expect(correctValue(ggt, { id: 't1', newValue: 999999, now: NOW }).ok).toBe(true);
  });
});
