// US-25 AC4/AC5: what the app's My data tab reads and writes, through
// health-core's own write functions. The app runs this same code in
// JavaScriptCore; these tests run it in Node.
import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord, readNumber, readRecord } from './my-data';
import { metricHistory } from './my-data-forms';
import { readUnitChoices } from './unit-choices';
import { healthWritesJson, planJson } from './entry';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { supplementSchema } from '../../packages/health-core/src/validation';
import { stampProfile, upsertSupplement } from '../../packages/health-core/src/state-edits';
import { mergeFiles } from '../../packages/health-core/src/merge';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';

function edited(file: RoadmapFile, ...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((current, edit) => {
    const outcome = applyEdit(current, edit, NOW);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  }, file);
}

describe('newRecord (AC4)', () => {
  it('is health-core\'s empty record, with units from the phone\'s region', () => {
    const us = newRecord(NOW, 'phone', 'en-US', 'America/New_York');
    expect(us.measurements).toEqual([]);
    expect(us.profile.unitSystem).toBe('conventional');
    expect(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland').profile.unitSystem).toBe('si');
  });
});

describe('myData (AC5)', () => {
  it('carries the record\'s erase count, so every phone sees an erase (US-54 AC7)', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(myData(file).eraseEpoch).toBe(0);
    expect(myData({ ...file, meta: { ...file.meta, eraseEpoch: 3 } }).eraseEpoch).toBe(3);
  });

  it('lists the web\'s vitals and blood tests, PSA left to screening', () => {
    const data = myData(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'));
    expect(data.vitals.map((row) => row.metric)).toEqual(['weight', 'waist', 'blood_pressure']);
    expect(data.bloodTests.map((row) => row.metric)).toEqual(['hba1c', 'creatinine', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa']);
    expect(data.bloodTests.find((row) => row.metric === 'ldl')).toMatchObject({ label: 'LDL Cholesterol', unit: 'mmol/L', latest: null });
  });

  it('shows the plan\'s current value, in the user\'s units', () => {
    let file = newRecord(NOW, 'phone', 'en-US', 'America/New_York');
    file = edited(file, { kind: 'add', metric: 'ldl', value: 100, day: '2026-09-01' }, { kind: 'add', metric: 'ldl', value: 130, day: '2026-10-01' });
    const ldl = myData(file).bloodTests.find((row) => row.metric === 'ldl');
    expect(ldl).toMatchObject({ unit: 'mg/dL', latest: { value: '130', day: '2026-10-01' } });
  });

  it('gives each row its trend: one active value a day, oldest first, in the user\'s units (US-25 AC17d)', () => {
    let file = newRecord(NOW, 'phone', 'en-US', 'America/New_York');
    file = edited(file,
      { kind: 'add', metric: 'ldl', value: 130, day: '2026-10-01' },
      { kind: 'add', metric: 'ldl', value: 100, day: '2026-09-01' },
      { kind: 'bloodPressure', systolic: 128, diastolic: 82, day: '2026-09-02', replace: false },
      { kind: 'bloodPressure', systolic: 121, diastolic: 78, day: '2026-10-02', replace: false });
    const wrong = file.measurements.find((row) => row.metricType === 'ldl' && row.recordedAt.startsWith('2026-10-01'))!;
    file = edited(file, { kind: 'correct', id: wrong.id, value: 120 });
    const data = myData(file);
    // The corrected 130 is gone, its correction in its place.
    expect(data.bloodTests.find((row) => row.metric === 'ldl')!.trend.map(Math.round)).toEqual([100, 120]);
    expect(data.vitals.find((row) => row.metric === 'blood_pressure')!.trend).toEqual([128, 121]);
    expect(data.vitals.find((row) => row.metric === 'waist')!.trend).toEqual([]);
    // Metric units for the same record: mmol/L.
    const si = edited(file, { kind: 'units', unitSystem: 'si' });
    expect(myData(si).bloodTests.find((row) => row.metric === 'ldl')!.trend[0]).toBeCloseTo(2.59, 2);
  });

  it('shows the last 30 days in a row\'s trend, today and the 29 days before (US-25 AC17f)', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    // NOW is 2026-10-21: 2026-09-22 is the 30-day window's first day.
    const days = ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-21', '2026-09-22', '2026-10-05', '2026-10-21'];
    file = edited(file, ...days.map((day, i) => ({ kind: 'add' as const, metric: 'weight', value: 60 + i, day })));
    expect(myData(file, NOW).vitals.find((row) => row.metric === 'weight')!.trend).toEqual([64, 65, 66]);
  });

  it('falls back to the last seven readings, however old, with fewer than two in 30 days (US-25 AC17f)', () => {
    let file = newRecord(NOW, 'phone', 'en-US', 'America/New_York');
    const years = Array.from({ length: 9 }, (_, i) => `${2017 + i}-03-01`);
    file = edited(file, ...years.map((day, i) => ({ kind: 'add' as const, metric: 'ldl', value: 100 + i, day })));
    const ldl = () => myData(file, NOW).bloodTests.find((row) => row.metric === 'ldl')!.trend.map(Math.round);
    expect(ldl()).toEqual([102, 103, 104, 105, 106, 107, 108]);
    // One reading in the last 30 days is still fewer than two: the last seven, ending on it.
    file = edited(file, { kind: 'add', metric: 'ldl', value: 90, day: '2026-10-20' });
    expect(ldl()).toEqual([103, 104, 105, 106, 107, 108, 90]);
    // A second recent reading: only the last 30 days.
    file = edited(file, { kind: 'add', metric: 'ldl', value: 95, day: '2026-09-30' });
    expect(ldl()).toEqual([95, 90]);
  });

  it('shows and takes a test in its own units, the rest in the record\'s (US-25 AC17e)', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const ldlInUs = { ldl: 'conventional' as const };
    // Typed in mg/dL because LDL is switched to US; the record keeps SI.
    file = edited(file, { kind: 'add', metric: 'weight', value: 80, day: '2026-09-01' });
    const typed = applyEdit(file, { kind: 'add', metric: 'ldl', value: 116, day: '2026-09-01' }, NOW, ldlInUs);
    if (!typed.ok) throw new Error(typed.message);
    file = typed.file;
    expect(file.measurements.find((row) => row.metricType === 'ldl')!.value).toBeCloseTo(3.0, 1);
    const data = myData(file, NOW, ldlInUs);
    expect(data.bloodTests.find((row) => row.metric === 'ldl')).toMatchObject({ unit: 'mg/dL', latest: { value: '116' }, switchable: true });
    expect(data.vitals.find((row) => row.metric === 'weight')).toMatchObject({ unit: 'kg', switchable: true });
    expect(data.vitals.find((row) => row.metric === 'blood_pressure')).toMatchObject({ switchable: false });
    expect(data.bloodTests.find((row) => row.metric === 'lpa')).toMatchObject({ switchable: false });
    expect(data.psa).toMatchObject({ switchable: false });
    expect(metricHistory(file, 'ldl', NOW, ldlInUs).unit).toBe('mg/dL');
    // A correction is read in the row's units too.
    const ldlRow = file.measurements.find((row) => row.metricType === 'ldl')!;
    const corrected = applyEdit(file, { kind: 'correct', id: ldlRow.id, value: 120 }, NOW, ldlInUs);
    if (!corrected.ok) throw new Error(corrected.message);
    expect(corrected.file.measurements.find((row) => row.correctsId === ldlRow.id)!.value).toBeCloseTo(3.1, 1);
  });

  it('keeps only real choices for switchable tests (US-25 AC17e)', () => {
    expect(readUnitChoices('{"ldl":"conventional","lpa":"conventional","weight":"imperial","x":"si"}')).toEqual({ ldl: 'conventional' });
    expect(readUnitChoices('not json')).toEqual({});
    expect(readUnitChoices(undefined)).toEqual({});
    expect(readUnitChoices('[1]')).toEqual({});
  });

  it('gives the plan the per-test units, and nothing changes without them (US-25 AC17e)', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
      { kind: 'profile', sex: 'male', birthYear: 1970, height: 180 }, { kind: 'add', metric: 'weight', value: 80, day: '2026-09-01' },
      { kind: 'add', metric: 'ldl', value: 3.5, day: '2026-09-01' });
    const record = JSON.stringify(file);
    const plain = JSON.parse(planJson(record, NOW, 'phone'));
    expect(JSON.parse(planJson(record, NOW, 'phone', '{}'))).toEqual(plain);
    const switched = JSON.stringify(JSON.parse(planJson(record, NOW, 'phone', '{"ldl":"conventional"}')).results.suggestions);
    expect(JSON.stringify(plain.results.suggestions)).toContain('mmol/L');
    expect(switched).toContain('mg/dL');
  });

  it('shows the profile, height in the user\'s units', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'profile', sex: 'female', birthYear: 1970, birthMonth: 4, height: 165 });
    expect(myData(file).profile).toEqual({ sex: 'female', birthYear: 1970, birthMonth: 4, height: '165', heightUnit: 'cm', feetInches: null, alcohol: null });
  });
});

describe('applyEdit (AC4/AC5)', () => {
  it('stores a value typed in US units as SI, the web\'s rule', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-US', 'America/New_York'), { kind: 'add', metric: 'weight', value: 220, day: '2026-10-20' });
    expect(file.measurements).toHaveLength(1);
    expect(file.measurements[0]).toMatchObject({ metricType: 'weight', status: 'active', recordedAt: '2026-10-20' });
    expect(file.measurements[0].value).toBeCloseTo(99.79, 2);
  });

  it('refuses an out-of-range value in the engine\'s words and changes nothing', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const outcome = applyEdit(file, { kind: 'add', metric: 'systolic_bp', value: 400, day: '2026-10-20' }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(file.measurements).toEqual([]);
  });

  it('refuses a future day', () => {
    const outcome = applyEdit(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2099-01-01' }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: 'future-date' });
  });

  it('names the row that holds the day, so the app can ask before replacing it', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2026-10-20' });
    const outcome = applyEdit(file, { kind: 'add', metric: 'weight', value: 82, day: '2026-10-20' }, LATER);
    expect(outcome).toMatchObject({ ok: false, reason: 'slot-occupied', existingId: file.measurements[0].id });
  });

  it('replaces a value as a FHIR correction: a new row, the old one entered-in-error', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-US', 'America/New_York'), { kind: 'add', metric: 'weight', value: 220, day: '2026-10-20' });
    const old = file.measurements[0];
    file = edited(file, { kind: 'correct', id: old.id, value: 200 });
    expect(file.measurements).toHaveLength(2);
    expect(file.measurements[0]).toMatchObject({ id: old.id, status: 'entered-in-error', value: old.value });
    expect(file.measurements[1]).toMatchObject({ correctsId: old.id, status: 'active', source: 'manual_correction' });
    expect(file.measurements[1].value).toBeCloseTo(90.72, 2);
    expect(myData(file).vitals[0].latest).toMatchObject({ id: file.measurements[1].id, value: '200' });
  });

  it('takes height in the user\'s units and refuses one the app\'s form could not take', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-US', 'America/New_York'), { kind: 'profile', height: 70 });
    expect(file.profile.heightCm).toBeCloseTo(177.8, 1);
    const outcome = applyEdit(file, { kind: 'profile', height: 10 }, NOW);
    expect(outcome).toMatchObject({ ok: false });
  });

  it('changes units with a field stamp, and the shown values follow', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2026-10-20' });
    file = edited(file, { kind: 'units', unitSystem: 'conventional' });
    expect(file.profile.unitSystem).toBe('conventional');
    expect(file.profile.fieldStamps?.unitSystem).toBeDefined();
    expect(myData(file).vitals[0]).toMatchObject({ unit: 'lbs', latest: { value: '176' } });
  });

  it('never edits the record it was given', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const before = JSON.stringify(file);
    applyEdit(file, { kind: 'add', metric: 'weight', value: 80, day: '2026-10-20' }, NOW);
    applyEdit(file, { kind: 'profile', sex: 'male' }, NOW);
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe('readNumber (AC5, adversary R2)', () => {
  it('reads either decimal mark, as the web does, and refuses what it cannot read whole', () => {
    expect(readNumber('3.4')).toBe(3.4);
    expect(readNumber('3,4')).toBe(3.4);
    expect(readNumber(' 80 ')).toBe(80);
    expect(readNumber('3.4.5')).toBeUndefined();
    expect(readNumber('80kg')).toBeUndefined();
    expect(readNumber('')).toBeUndefined();
  });

  it('reads the digits an Arabic or Persian keypad types (adversary re-check F2)', () => {
    expect(readNumber('٣٫٤')).toBe(3.4);
    expect(readNumber('۸۰')).toBe(80);
    expect(readNumber('٣.٤')).toBe(3.4);
  });

  // US-02 AC7: the phone's sheets have no range, so "1,234" (1234 or 1.234)
  // reads as neither, and the sheet asks. Grouped thousands read whole.
  // US-02 AC7: the input ranges a typed "1,234" is read against, by unit, so the
  // phone picks the one reading in range as the web does. Input bounds, not targets.
  it('My data carries each metric\'s input range by unit, Lp(a) in its own three (US-02 AC7)', () => {
    const { inputRanges } = myData(newRecord(NOW, 'd', 'en-NZ', 'Pacific/Auckland'), NOW);
    // 45, not 44: 44 lbs is 19.96 kg, under the record's 20 kg floor (US-05 AC2b).
    expect(inputRanges.weight).toEqual({ si: { min: 20, max: 300 }, conventional: { min: 45, max: 661 } });
    expect(inputRanges.height.si).toEqual({ min: 50, max: 250 });
    expect(inputRanges.triglycerides.conventional).toEqual({ min: 0, max: 2000, minExclusive: true }); // US-03 AC7: above 0, the record refuses 0
    expect(Object.keys(inputRanges.lpa).sort()).toEqual(['conventional', 'mg/L', 'mg/dL', 'nmol/L', 'si']);
    expect(inputRanges.lpa['mg/L']).toEqual({ min: 0, max: 3000 });
  });

  it('reads "1,234" as neither 1234 nor 1.234, and "1,234,567" as nothing without a range (US-02 AC7)', () => {
    expect(readNumber('1,234')).toBeUndefined();
    expect(readNumber('١,٢٣٤')).toBeUndefined();
    expect(readNumber('0,123')).toBe(0.123);
    expect(readNumber('1,234,567')).toBeUndefined();
  });
});

describe('readRecord (AC4, adversary R4)', () => {
  it('refuses a file that is JSON but not a record, so the app never writes over it', () => {
    for (const raw of ['null', '[]', '"text"', '42']) {
      expect(() => readRecord(raw, NOW, 'phone'), raw).toThrow();
    }
  });

  it('refuses a record whose parts are broken, as every other writer does (Codex R2)', () => {
    const record = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    for (const broken of [{}, { hello: 1 }, { ...record, measurements: 'not a list' }, { ...record, schemaVersion: undefined }]) {
      expect(() => readRecord(JSON.stringify(broken), NOW, 'phone')).toThrow();
    }
  });

  it('reads a record', () => {
    expect(readRecord(JSON.stringify(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland')), NOW, 'phone').measurements).toEqual([]);
  });
});

describe('medications and supplements (US-06, D4b)', () => {
  it('saves a medication by the web rule: the keyed row and a started history row; a dose change adds one more', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    file = edited(file, { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg' });
    expect(file.medications).toEqual([expect.objectContaining({ medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg', lamport: 0 })]);
    expect(file.medicationHistory.map((h) => h.changeType)).toEqual(['started']);
    file = edited(file, { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' });
    expect(file.medications).toEqual([expect.objectContaining({ doseValue: 20, lamport: 1 })]);
    expect(file.medicationHistory.map((h) => h.changeType)).toEqual(['started', 'dose_changed']);
  });

  it('refuses a medication key or dose the API would refuse, and writes nothing', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(applyEdit(file, { kind: 'medication', medicationKey: 'aspirin', drugName: 'aspirin' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(file, { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: -5 }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('words a refused dose as before zod 4 (zod 3 texts, shown on the phone)', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const supplement = { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', status: 'active' } as const;
    expect(applyEdit(file, { ...supplement, doseValue: 0, doseUnit: 'g' }, NOW))
      .toEqual({ ok: false, reason: 'invalid-value', message: 'Number must be greater than 0' });
    expect(applyEdit(file, { ...supplement, doseValue: 1, doseUnit: 'x'.repeat(21) }, NOW))
      .toEqual({ ok: false, reason: 'invalid-value', message: 'String must contain at most 20 character(s)' });
    expect(applyEdit(file, { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: -5 }, NOW))
      .toEqual({ ok: false, reason: 'invalid-value', message: 'Number must be greater than 0' });
  });

  it('saves and soft-stops a supplement, keeping its start', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    file = edited(file, { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g', status: 'active' });
    const startedAt = file.supplements[0].startedAt;
    const stopped = applyEdit(file, { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g', status: 'stopped' }, LATER);
    if (!stopped.ok) throw new Error(stopped.message);
    expect(stopped.file.supplements).toEqual([expect.objectContaining({ status: 'stopped', startedAt, lamport: 1 })]);
    expect(stopped.file.supplementHistory.map((h) => h.changeType)).toEqual(['started', 'stopped']);
  });

  it('refuses a start that is not a real day, or has not happened yet, and writes nothing', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const save = { kind: 'supplement' as const, supplementKey: 'omega3', supplementName: 'Omega-3', status: 'active' as const };
    for (const startedAt of ['yesterday', '2026-02-30', '2099-01-01', '2026-10-20Tnonsense']) {
      expect(applyEdit(file, { ...save, startedAt }, NOW), startedAt).toMatchObject({ ok: false, reason: 'invalid-date' });
    }
    for (const startedAt of ['2026-10-01', '2026-10-01T09:30:00.000Z']) {
      const saved = applyEdit(file, { ...save, startedAt }, NOW);
      if (!saved.ok) throw new Error(saved.message);
      expect(saved.file.supplements[0].startedAt).toBe(startedAt);
    }
  });

  it('refuses to stop a supplement the record does not hold', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(applyEdit(file, { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', status: 'stopped' }, NOW))
      .toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('refuses a supplement with a bad key or no status', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(applyEdit(file, { kind: 'supplement', supplementKey: 'Omega 3!', supplementName: 'Omega-3', status: 'active' }, NOW)).toMatchObject({ ok: false });
    expect(applyEdit(file, { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3' } as never, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });
});

// US-25 AC13/AC14 (ios/architecture.md D6): Apple Health in and out, through
// health-core's device-import and device-export (their rules are tested there).
describe('Apple Health (AC13, AC14)', () => {
  const reading = { externalId: 'hk-1', metricType: 'weight', value: 80, measuredAt: '2026-10-21T08:30:00+13:00' };

  it('takes readings in as apple_health rows, shown in My data', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'appleHealth', samples: [reading] });
    expect(file.measurements[0]).toMatchObject({ source: 'apple_health', externalId: 'hk-1', value: 80 });
    expect(myData(file).vitals[0].latest).toMatchObject({ value: '80.0', day: '2026-10-21' });
  });

  it('hands back the record it was given when nothing is new, so the app writes nothing', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'appleHealth', samples: [reading] });
    const again = applyEdit(file, { kind: 'appleHealth', samples: [reading] }, LATER);
    expect(again).toEqual({ ok: true, file });
  });

  it('refuses a batch that is not a list', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(applyEdit(file, { kind: 'appleHealth', samples: 'nope' } as never, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('lists a typed weight as a write to Apple Health, and an imported one not', () => {
    const typed = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2026-10-20' }, { kind: 'appleHealth', samples: [reading] });
    expect(JSON.parse(healthWritesJson(JSON.stringify(typed), NOW, 'phone'))).toEqual([{ syncId: typed.measurements[0].id, version: 1, day: '2026-10-20', values: { weight: 80 } }]);
  });
});

// US-25 AC8: the medication, screening and supplement questions, health-core's
// input-form, answered through the web's own writes.
describe('forms (AC8)', () => {
  /** A 60-year-old man, 180 cm, NZ units, with an ApoB over target. */
  function man60(...extra: Parameters<typeof applyEdit>[1][]): RoadmapFile {
    return edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
      { kind: 'profile', sex: 'male', birthYear: 1966, birthMonth: 1, height: 180 },
      { kind: 'add', metric: 'apob', value: 1.3, day: '2026-10-01' }, ...extra);
  }

  it('shows no screening questions, and says why, until About you is complete', () => {
    const data = myData(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), NOW);
    expect(data.screenings).toEqual([]);
    expect(data.screeningNote).toMatch(/sex, birth year and height/);
    expect(data.medications).toEqual([]);
  });

  it('asks the web\'s questions for the plan\'s age and sex, and the cascade\'s first step', () => {
    const data = myData(man60(), NOW);
    expect(data.screenings[0].groups.map((g) => g.id)).toEqual(['colorectal', 'lung', 'prostate']);
    expect(data.medications.map((s) => s.id)).toEqual(['lipid-medications']);
    expect(data.medications[0].groups[0].fields[0]).toMatchObject({ key: 'statin', label: 'Statin' });
    expect(data.months.past.at(-1)).toBe('2026-10');
  });

  it('a medication answer writes the web\'s rows: a statin with its first dose', () => {
    const file = man60({ kind: 'medicationField', field: 'statin', value: 'atorvastatin' });
    expect(file.medications).toEqual([expect.objectContaining({ medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg' })]);
    expect(myData(file, NOW).medications[0].groups.map((g) => g.id)).toEqual(['statin', 'ezetimibe']);
  });

  it('refuses a medication question the form does not show, or an answer it does not offer', () => {
    const file = man60();
    expect(applyEdit(file, { kind: 'medicationField', field: 'pcsk9i', value: 'yes' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(file, { kind: 'medicationField', field: 'statin', value: 'aspirin' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(file, { kind: 'medicationField', field: 'statin_dose', value: '10' }, NOW)).toMatchObject({ ok: false });
  });

  it('a screening answer is setScreening, and "not yet started" clears what it closes', () => {
    let file = man60({ kind: 'screening', key: 'colorectal_method', value: 'fit_annual' }, { kind: 'screening', key: 'colorectal_last_date', value: '2025-03' });
    expect(file.screenings).toMatchObject({ colorectalMethod: 'fit_annual', colorectalLastDate: '2025-03' });
    file = edited(file, { kind: 'screening', key: 'colorectal_method', value: 'not_yet_started' });
    expect(file.screenings.colorectalMethod).toBe('not_yet_started');
    expect(file.screenings.colorectalLastDate ?? '').toBe('');
  });

  it('refuses an unknown key, a hidden question, a month out of range and a bad pack-years', () => {
    const file = man60({ kind: 'screening', key: 'lung_smoking_history', value: 'former_smoker' });
    const refused = (key: string, value: string) => expect(applyEdit(file, { kind: 'screening', key, value }, NOW), `${key}=${value}`).toMatchObject({ ok: false });
    refused('colon_vibes', 'yes');
    refused('breast_frequency', 'annual');
    refused('colorectal_method', 'tea_leaves');
    refused('lung_pack_years', '-3');
    refused('lung_pack_years', '2.5');
    expect(edited(file, { kind: 'screening', key: 'lung_pack_years', value: '30' }).screenings.lungPackYears).toBe(30);
    const dated = man60({ kind: 'screening', key: 'colorectal_method', value: 'fit_annual' });
    expect(applyEdit(dated, { kind: 'screening', key: 'colorectal_last_date', value: '2027-01' }, NOW)).toMatchObject({ ok: false });
    expect(applyEdit(dated, { kind: 'screening', key: 'colorectal_last_date', value: '2026-13' }, NOW)).toMatchObject({ ok: false });
  });

  it('shows PSA as a row once a man will screen; it saves as a measurement', () => {
    const file = man60({ kind: 'screening', key: 'prostate_discussion', value: 'will_screen' }, { kind: 'add', metric: 'psa', value: 1.2, day: '2026-10-02' });
    const data = myData(file, NOW);
    expect(data.screenings[0].groups.find((g) => g.id === 'prostate')!.fields[1]).toMatchObject({ kind: 'measurement', metric: 'psa' });
    expect(data.psa.latest).toMatchObject({ value: '1.2', day: '2026-10-02' });
  });

  // US-06 AC1a: accepted names must produce keys accepted by the real native writer.
  it.each([93, 100])('saves long native names and collisions without losing identity (%i characters)', length => {
    const name = 'a'.repeat(length);
    const other = length === 93 ? name + '+' : 'a'.repeat(99) + 'b';
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'customSupplement', name });
    const original = file.supplements[0];
    const history = [...file.supplementHistory];
    const added = applyEdit(file, { kind: 'customSupplement', name: other }, LATER);
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) throw new Error(added.message);
    file = added.file;
    expect(file.supplements).toHaveLength(2);
    expect(file.supplements[0]).toEqual(original);
    expect(file.supplementHistory.slice(0, history.length)).toEqual(history);
    expect(new Set(file.supplements.map(s => s.supplementKey)).size).toBe(2);
    for (const row of file.supplements) {
      expect(row.supplementKey.length).toBeLessThanOrEqual(100);
      expect(supplementSchema.shape.supplementKey.safeParse(row.supplementKey).success).toBe(true);
    }
    const second = file.supplements[1];
    file = edited(readRecord(JSON.stringify(file), LATER, 'phone'), {
      kind: 'supplement', supplementKey: second.supplementKey, supplementName: second.supplementName,
      doseValue: 2, doseUnit: 'g', status: 'active',
    });
    expect(file.supplements[0]).toEqual(original);
    expect(file.supplements[1]).toMatchObject({ id: second.id, supplementKey: second.supplementKey, doseValue: 2 });
    expect(file.supplementHistory.at(-1)).toMatchObject({ supplementKey: second.supplementKey, changeType: 'dose_changed' });
    const readded = edited(file, { kind: 'customSupplement', name: name.toUpperCase() });
    expect(readded.supplements).toHaveLength(2);
    expect(readded.supplements[0]).toMatchObject({ id: original.id, supplementKey: original.supplementKey, startedAt: original.startedAt });
    expect(readded.supplements[1]).toEqual(file.supplements[1]);
    expect(readded.supplementHistory.slice(0, file.supplementHistory.length)).toEqual(file.supplementHistory);
  });

  it('reuses the stored 100-character name at a truncation boundary (US-06 AC1a)', () => {
    const name = 'Taurine' + ' '.repeat(93) + 'x';
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'customSupplement', name });
    const original = file.supplements[0];
    file = edited(file, { kind: 'customSupplement', name: name.toUpperCase() });
    expect(file.supplements).toHaveLength(1);
    expect(file.supplements[0]).toMatchObject({ id: original.id, supplementKey: original.supplementKey, startedAt: original.startedAt });
  });

  // US-06 AC1a / US-25 AC8: the actual typed-name command must preserve identities.
  it('keeps normalized collisions distinct through native form add, stop, reload and restart', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
      { kind: 'customSupplement', name: 'alanine+' });
    file = edited(file, { kind: 'supplement', supplementKey: 'custom_alanine', supplementName: 'alanine+', doseValue: 3, doseUnit: 'g', status: 'active' });
    const original = file.supplements[0];
    file = edited(file, { kind: 'customSupplement', name: 'alanine' });
    expect(file.supplements).toHaveLength(2);
    expect(file.supplements[0]).toEqual(original);
    expect(file.supplements[1]).toMatchObject({ supplementKey: 'custom_alanine_2', supplementName: 'alanine' });
    file = edited(file, { kind: 'supplement', supplementKey: original.supplementKey, supplementName: original.supplementName, doseValue: 3, doseUnit: 'g', status: 'stopped' });
    const history = file.supplementHistory;
    // A fresh engine invocation receives the serialized record, not a helper fixture.
    file = edited(JSON.parse(JSON.stringify(file)) as RoadmapFile, { kind: 'customSupplement', name: '  ALANINE+  ' });
    expect(file.supplements).toHaveLength(2);
    expect(file.supplements[0]).toMatchObject({ id: original.id, supplementKey: original.supplementKey, startedAt: original.startedAt, status: 'active' });
    expect(file.supplementHistory.slice(0, history.length)).toEqual(history);
    expect(file.supplementHistory.at(-1)).toMatchObject({ supplementKey: original.supplementKey, changeType: 'started' });
    const count = file.supplementHistory.length;
    file = edited(file, { kind: 'customSupplement', name: 'ALANINE+' });
    expect(file.supplements).toHaveLength(2);
    expect(file.supplementHistory).toHaveLength(count);
    expect(myData(file, NOW).supplements.active.map(s => s.key)).toEqual(['custom_alanine', 'custom_alanine_2']);
  });

  // US-06 AC1a: an older browser record can hold a custom key over 100 characters.
  it('restarts a legacy overlong custom key through the native add, and still refuses a new one', () => {
    const key = 'custom_' + 'a'.repeat(100);
    const row = { supplementKey: key, supplementName: 'A'.repeat(100), doseValue: 1, doseUnit: 'g' };
    let legacy = upsertSupplement(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { ...row, status: 'active' }, NOW).file;
    legacy = upsertSupplement(legacy, { ...row, status: 'stopped' }, NOW).file;
    const file = readRecord(JSON.stringify(legacy), LATER, 'phone');
    const restarted = applyEdit(file, { kind: 'customSupplement', name: 'a'.repeat(100) }, LATER);
    if (!restarted.ok) throw new Error(restarted.message);
    expect(restarted.file.supplements).toEqual([expect.objectContaining({ id: legacy.supplements[0].id, supplementKey: key, status: 'active' })]);
    expect(restarted.file.supplementHistory.at(-1)).toMatchObject({ supplementKey: key, changeType: 'started' });
    expect(applyEdit(restarted.file, { kind: 'supplement', ...row, doseValue: 2, status: 'active' }, LATER)).toMatchObject({ ok: true });
    expect(applyEdit(file, { kind: 'supplement', ...row, supplementKey: 'custom_' + 'b'.repeat(100), status: 'active' }, LATER))
      .toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  // US-06 AC1a: a restart keeps the row's stored spelling.
  it('restarts a stopped row under its stored name, spaces and case kept', () => {
    const row = { supplementKey: 'custom_taurine', supplementName: 'Taurine ', doseValue: 1, doseUnit: 'g' };
    let file = upsertSupplement(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { ...row, status: 'active' }, NOW).file;
    file = upsertSupplement(file, { ...row, status: 'stopped' }, NOW).file;
    file = edited(readRecord(JSON.stringify(file), LATER, 'phone'), { kind: 'customSupplement', name: 'TAURINE' });
    expect(file.supplements).toEqual([expect.objectContaining({ supplementKey: 'custom_taurine', supplementName: 'Taurine ', status: 'active' })]);
    expect(file.supplementHistory.at(-1)).toMatchObject({ supplementName: 'Taurine ', changeType: 'started' });
  });

  // US-06 AC1a: re-adding a name already taken keeps its dose and writes no history.
  it('keeps the dose when an active name is added again', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'customSupplement', name: 'Taurine' });
    file = edited(file, { kind: 'supplement', supplementKey: 'custom_taurine', supplementName: 'Taurine', doseValue: 2, doseUnit: 'g', status: 'active' });
    const again = edited(file, { kind: 'customSupplement', name: ' taurine ' });
    expect(again.supplements).toEqual(file.supplements);
    expect(again.supplementHistory).toEqual(file.supplementHistory);
  });

  it('lists supplements: quick-add first, a typed one keyed by the web\'s rule, a stopped one kept', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(myData(file, NOW).supplements.choices.slice(0, 2)).toEqual([
      { key: 'microvitamin', name: 'Micronutrient base', featured: true, dose: 1, unit: 'serving' },
      { key: 'creatine', name: 'Creatine', featured: true, dose: 5, unit: 'g' },
    ]);
    file = edited(file, { kind: 'customSupplement', name: '  Lion\'s Mane ' });
    expect(file.supplements[0]).toMatchObject({ supplementKey: 'custom_lion_s_mane', supplementName: 'Lion\'s Mane', status: 'active' });
    file = edited(file, { kind: 'supplement', supplementKey: 'custom_lion_s_mane', supplementName: 'Lion\'s Mane', status: 'stopped' });
    const view = myData(file, NOW).supplements;
    expect(view.active).toEqual([]);
    expect(view.stopped.map((s) => s.key)).toEqual(['custom_lion_s_mane']);
  });
});

// US-25 AC9: a metric's history, corrections included, never a removal.
describe('metricHistory (AC9)', () => {
  it('lists every value newest first, the corrected one entered-in-error, the plan\'s current marked', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
      { kind: 'add', metric: 'weight', value: 80, day: '2026-09-01' }, { kind: 'add', metric: 'weight', value: 82, day: '2026-10-01' });
    file = edited(file, { kind: 'correct', id: file.measurements[1].id, value: 81 });
    const history = metricHistory(file, 'weight');
    expect(history).toMatchObject({ label: 'Weight', unit: 'kg' });
    expect(history.rows.map((r) => [r.value, r.day, r.status, r.current, r.correction])).toEqual([
      ['81.0', '2026-10-01', 'active', true, true],
      ['82.0', '2026-10-01', 'entered-in-error', false, false],
      ['80.0', '2026-09-01', 'active', false, false],
    ]);
  });
});

// US-25 AC8/AC9, adversary R2/R3: rows the record keeps in odd shapes (no
// updatedAt or createdAt, a name that is not text, a dose that is not a
// number, correctsId absent) must not lock the tab or blank the history.
describe('odd rows the migration keeps (adversary R2, R3)', () => {
  it('lists supplements without throwing, skipping a nameless row and reading a bad dose as none', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const odd = {
      ...file,
      supplements: [
        { id: 'a', supplementKey: 'zinc', supplementName: 'Zinc', doseValue: 'lots', doseUnit: 'mg', status: 'stopped', startedAt: '2026-01-01' },
        { id: 'b', supplementKey: 'iron', supplementName: 'Iron', doseValue: 10, doseUnit: 'mg', status: 'stopped', startedAt: '2026-01-01', updatedAt: NOW },
        { id: 'c', supplementKey: 'odd', supplementName: 42, doseValue: null, doseUnit: null, status: 'active', startedAt: '2026-01-01', updatedAt: NOW },
      ],
    } as unknown as RoadmapFile;
    const view = myData(odd, NOW).supplements;
    expect(view.active).toEqual([]);
    expect(view.stopped.map((s) => [s.key, s.dose])).toEqual([['iron', 10], ['zinc', null]]);
  });

  it('reads a history row with no createdAt or correctsId, never calling it a correction', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2026-09-01' });
    const { createdAt: _c, correctsId: _k, ...bare } = file.measurements[0];
    const odd = { ...file, measurements: [...file.measurements, { ...bare, id: 'legacy', recordedAt: '2026-08-01' }] } as unknown as RoadmapFile;
    const rows = metricHistory(odd, 'weight').rows;
    expect(rows.map((r) => [r.id === 'legacy', r.correction])).toEqual([[false, false], [true, false]]);
  });
});

// US-25 AC9, Codex R2: a value the plan excludes (out of its accepted range)
// is never labelled as the one the plan uses.
describe('metricHistory and the plan\'s exclusions (Codex R2)', () => {
  it('says the plan does not use an excluded current value', () => {
    let file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'profile', sex: 'male', birthYear: 1966, height: 180 }, { kind: 'add', metric: 'systolic_bp', value: 120, day: '2026-09-01' });
    expect(metricHistory(file, 'systolic_bp', NOW).excluded).toBe(false);
    const row = file.measurements[0];
    file = { ...file, measurements: [{ ...row, value: 400 }] };
    const history = metricHistory(file, 'systolic_bp', NOW);
    expect(history.excluded).toBe(true);
    expect(history.rows[0].current).toBe(true);
  });
});

// US-25 AC20: Lp(a)'s three units on the phone, the web's control (US-05 AC2): the
// record's `profile.lpaUnit`, read and written through health-core as the web does.
describe('Lp(a) unit (US-05 AC2, US-25 AC20)', () => {
  const lpaRow = (file: RoadmapFile) => myData(file).bloodTests.find((row) => row.metric === 'lpa')!;
  const withLpa = (locale: string, zone: string) =>
    edited(newRecord(NOW, 'phone', locale, zone), { kind: 'add', metric: 'lpa', value: 124, day: '2026-09-01' });
  const inUnit = (file: RoadmapFile, unit: 'nmol/L' | 'mg/dL' | 'mg/L') => edited(file, { kind: 'lpaUnit', unit });

  it('with none chosen, US units give mg/dL and any other nmol/L', () => {
    expect(myData(withLpa('en-US', 'America/New_York'))).toMatchObject({ lpaUnit: 'mg/dL' });
    // Typed 124 in mg/dL, stored 310 nmol/L, shown back at mg/dL's one place.
    expect(lpaRow(withLpa('en-US', 'America/New_York'))).toMatchObject({ unit: 'mg/dL', latest: { value: '124.0' } });
    expect(myData(withLpa('en-NZ', 'Pacific/Auckland'))).toMatchObject({ lpaUnit: 'nmol/L' });
    // A hand edit can hold anything: an unknown unit reads as none.
    const odd = withLpa('en-NZ', 'Pacific/Auckland');
    expect(myData({ ...odd, profile: { ...odd.profile, lpaUnit: 'g/L' as never } }).lpaUnit).toBe('nmol/L');
  });

  it('shows the row, its history and its trend in the chosen unit, at the web\'s step', () => {
    const file = withLpa('en-NZ', 'Pacific/Auckland');
    for (const [unit, value] of [['nmol/L', '124'], ['mg/dL', '49.6'], ['mg/L', '496']] as const) {
      const chosen = inUnit(file, unit);
      expect(lpaRow(chosen)).toMatchObject({ unit, latest: { value } });
      expect(metricHistory(chosen, 'lpa', NOW)).toMatchObject({ unit, rows: [{ value }] });
      expect(lpaRow(chosen).trend[0]).toBeCloseTo(Number(value), 6);
    }
    // Every other test keeps the record's units.
    expect(myData(inUnit(file, 'mg/dL')).bloodTests.find((row) => row.metric === 'ldl')!.unit).toBe('mmol/L');
  });

  it('reads a typed value in the chosen unit, and a correction too', () => {
    const base = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const stored = (file: RoadmapFile) => file.measurements.find((row) => row.metricType === 'lpa' && row.status === 'active')!.value;
    // US-05 AC1's pairs: 156 mg/dL is 390 nmol/L; 93 mg/L is 23.25.
    expect(stored(edited(inUnit(base, 'mg/dL'), { kind: 'add', metric: 'lpa', value: 156, day: '2026-09-01' }))).toBeCloseTo(390, 9);
    expect(stored(edited(inUnit(base, 'mg/L'), { kind: 'add', metric: 'lpa', value: 93, day: '2026-09-01' }))).toBeCloseTo(23.25, 9);
    expect(stored(edited(base, { kind: 'add', metric: 'lpa', value: 75, day: '2026-09-01' }))).toBe(75);
    const file = inUnit(withLpa('en-NZ', 'Pacific/Auckland'), 'mg/dL');
    const row = file.measurements.find((r) => r.metricType === 'lpa')!;
    // 50 mg/dL over a shown 49.6 corrects it to 125 (US-05 AC2).
    const corrected = edited(file, { kind: 'correct', id: row.id, value: 50 });
    expect(corrected.measurements.find((r) => r.correctsId === row.id)!.value).toBeCloseTo(125, 9);
    // Over the range, said in the unit typed in, as the web's cellRange says it (review R2).
    expect(applyEdit(file, { kind: 'add', metric: 'lpa', value: 301, day: '2026-09-02' }, NOW))
      .toMatchObject({ ok: false, reason: 'out-of-range', message: 'Lp(a) must be at most 300 mg/dL (got 301)' });
    expect(applyEdit(inUnit(file, 'mg/L'), { kind: 'correct', id: row.id, value: 3001 }, NOW))
      .toMatchObject({ ok: false, reason: 'out-of-range', message: 'Lp(a) must be at most 3000 mg/L (got 3001)' });
    expect(applyEdit(inUnit(file, 'nmol/L'), { kind: 'add', metric: 'lpa', value: 751, day: '2026-09-02' }, NOW))
      .toMatchObject({ message: 'Lp(a) must be at most 750 nmol/L (got 751)' });
    // 3000 mg/L is the bound itself: saved, as 750 nmol/L.
    expect(applyEdit(inUnit(file, 'mg/L'), { kind: 'add', metric: 'lpa', value: 3000, day: '2026-09-02' }, NOW).ok).toBe(true);
  });

  it('writes profile.lpaUnit field-stamped, as the web\'s store does, and merges like it', () => {
    const file = withLpa('en-NZ', 'Pacific/Auckland');
    const chosen = applyEdit(file, { kind: 'lpaUnit', unit: 'mg/L' }, LATER);
    if (!chosen.ok) throw new Error(chosen.message);
    // The web's own write (roadmap-store.ts setLpaUnit).
    expect(chosen.file).toEqual(stampProfile(file, { lpaUnit: 'mg/L' }, LATER));
    expect(chosen.file.profile.fieldStamps?.lpaUnit).toBeDefined();
    // The stored unit again writes nothing; a unit outside the three is refused.
    expect(applyEdit(chosen.file, { kind: 'lpaUnit', unit: 'mg/L' }, LATER)).toEqual({ ok: true, file: chosen.file });
    expect(applyEdit(file, { kind: 'lpaUnit', unit: 'g/L' as never }, LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
    // The web, from the same copy, changes the units meanwhile: both choices survive the merge.
    const web = stampProfile(file, { unitSystem: 'conventional' }, LATER);
    const merged = mergeFiles(chosen.file, web, { deviceId: 'phone', now: LATER });
    expect(merged.profile).toMatchObject({ lpaUnit: 'mg/L', unitSystem: 'conventional' });
    expect(mergeFiles(web, chosen.file, { deviceId: 'web', now: LATER }).profile).toMatchObject({ lpaUnit: 'mg/L', unitSystem: 'conventional' });
    // The web's later choice wins over the phone's (per-field last write).
    const webLater = stampProfile(chosen.file, { lpaUnit: 'mg/dL' }, '2026-10-21T10:00:00.000Z');
    expect(mergeFiles(chosen.file, webLater, { deviceId: 'phone', now: LATER }).profile.lpaUnit).toBe('mg/dL');
  });

  it('leaves the plan\'s Lp(a) text in nmol/L, as the web\'s plan prints it (US-05 AC2 out of scope)', () => {
    const file = edited(withLpa('en-NZ', 'Pacific/Auckland'), { kind: 'profile', sex: 'male', birthYear: 1970, height: 180 },
      { kind: 'add', metric: 'weight', value: 80, day: '2026-09-01' });
    const text = (f: RoadmapFile) => JSON.stringify(JSON.parse(planJson(JSON.stringify(f), NOW, 'phone')).results.suggestions);
    expect(text(file)).toContain('Lp(a): 124 nmol/L');
    expect(text(inUnit(file, 'mg/dL'))).toEqual(text(file));
  });
});

// US-60: "Do you drink alcohol?", asked from the reduce-alcohol card and in About you.
// The phone writes the answer to profile.alcohol; the engine alone drops the card.
describe('alcohol (US-60)', () => {
  const base = () => edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'profile', sex: 'male', birthYear: 1970, height: 175 });
  const answer = (file: RoadmapFile, alcohol: 'none' | 'drinks' | null, at = LATER) => {
    const outcome = applyEdit(file, { kind: 'alcohol', alcohol }, at);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  };

  it('saves the answer field-stamped, shows it in My data, and writes nothing for the same answer', () => {
    const file = base();
    expect(myData(file).profile.alcohol).toBeNull();
    const none = answer(file, 'none');
    expect(none.profile.alcohol).toBe('none');
    expect(none.profile.fieldStamps?.alcohol).toBeDefined();
    expect(myData(none).profile.alcohol).toBe('none');
    expect(myData(answer(none, 'drinks')).profile.alcohol).toBe('drinks');
    expect(applyEdit(none, { kind: 'alcohol', alcohol: 'none' }, LATER)).toEqual({ ok: true, file: none });
    expect(applyEdit(file, { kind: 'alcohol', alcohol: null }, LATER)).toEqual({ ok: true, file });
    expect(applyEdit(file, { kind: 'alcohol', alcohol: 'sometimes' as never }, LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('"Not answered" clears it with null, which survives the file and merges as a write (M2)', () => {
    const none = answer(base(), 'none');
    const cleared = answer(none, null, '2026-10-21T10:00:00.000Z');
    expect(cleared.profile.alcohol).toBeNull();
    const reread = readRecord(JSON.stringify(cleared), LATER, 'phone');
    expect(reread.profile.alcohol).toBeNull();
    expect(myData(reread).profile.alcohol).toBeNull();
    // The clear is newer than the answer on the other copy, in either order.
    expect(mergeFiles(none, cleared, { deviceId: 'web', now: LATER }).profile.alcohol ?? null).toBeNull();
    expect(mergeFiles(cleared, none, { deviceId: 'phone', now: LATER }).profile.alcohol ?? null).toBeNull();
    // And an answer given after the clear wins over it.
    const again = answer(cleared, 'drinks', '2026-10-21T11:00:00.000Z');
    expect(mergeFiles(cleared, again, { deviceId: 'web', now: LATER }).profile.alcohol).toBe('drinks');
  });

  it('shows a value it does not know as not answered, and every other profile write keeps the answer', () => {
    const odd = base();
    expect(myData({ ...odd, profile: { ...odd.profile, alcohol: 'sometimes' as never } }).profile.alcohol).toBeNull();
    const none = answer(base(), 'none');
    const later = edited(none, { kind: 'profile', birthMonth: 6 }, { kind: 'units', unitSystem: 'conventional' }, { kind: 'lpaUnit', unit: 'mg/L' },
      { kind: 'profile', heightFeet: 5, heightInches: 10 });
    expect(later.profile.alcohol).toBe('none');
    expect(readRecord(JSON.stringify(later), LATER, 'phone').profile.alcohol).toBe('none');
  });

  it('the engine drops the reduce-alcohol card for "I don\'t drink" and keeps it for "I drink"', () => {
    const heavy = edited(base(), { kind: 'add', metric: 'weight', value: 100, day: '2026-10-01' });
    const ids = (f: RoadmapFile) => (JSON.parse(planJson(JSON.stringify(f), NOW, 'phone')).results.suggestions as { id: string }[]).map((s) => s.id);
    expect(ids(heavy)).toContain('reduce-alcohol');
    expect(ids(answer(heavy, 'drinks'))).toContain('reduce-alcohol');
    expect(ids(answer(heavy, 'none'))).not.toContain('reduce-alcohol');
    expect(ids(answer(answer(heavy, 'none'), null, '2026-10-21T10:00:00.000Z'))).toContain('reduce-alcohol');
  });
});
