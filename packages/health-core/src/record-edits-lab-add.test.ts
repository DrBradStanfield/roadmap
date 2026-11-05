// US-25 AC25, US-21: the one lab add both apps use (record-edits.ts addLabValue): the web's
// "+ Add a value" (AddLabTest.tsx) and the iPhone's lab page. Synthetic values.
import { describe, expect, it } from 'vitest';
import { addLabValue, bulkAppendValues } from './record-edits';
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
    for (const metricName of ['Weight', 'height', 'Systolic BP', 'Waist', 'Blood pressure', 'BP', 'blood pressure (systolic)', 'Blood Pressure - Diastolic']) {
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
