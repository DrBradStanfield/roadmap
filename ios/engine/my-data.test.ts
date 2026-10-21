// US-25 AC4/AC5: what the app's My data tab reads and writes, through
// health-core's own write functions. The app runs this same code in
// JavaScriptCore; these tests run it in Node.
import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord, readNumber, readRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

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
  it('lists the web\'s vitals and blood tests, PSA left to screening', () => {
    const data = myData(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'));
    expect(data.vitals.map((row) => row.metric)).toEqual(['weight', 'waist', 'systolic_bp', 'diastolic_bp']);
    expect(data.bloodTests.map((row) => row.metric)).toEqual(['hba1c', 'creatinine', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa']);
    expect(data.bloodTests.find((row) => row.metric === 'ldl')).toMatchObject({ label: 'LDL Cholesterol', unit: 'mmol/L', latest: null });
  });

  it('shows the plan\'s current value, in the user\'s units', () => {
    let file = newRecord(NOW, 'phone', 'en-US', 'America/New_York');
    file = edited(file, { kind: 'add', metric: 'ldl', value: 100, day: '2026-09-01' }, { kind: 'add', metric: 'ldl', value: 130, day: '2026-10-01' });
    const ldl = myData(file).bloodTests.find((row) => row.metric === 'ldl');
    expect(ldl).toMatchObject({ unit: 'mg/dL', latest: { value: '130', day: '2026-10-01' } });
  });

  it('shows the profile, height in the user\'s units', () => {
    const file = edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'profile', sex: 'female', birthYear: 1970, birthMonth: 4, height: 165 });
    expect(myData(file).profile).toEqual({ sex: 'female', birthYear: 1970, birthMonth: 4, height: '165', heightUnit: 'cm' });
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
});

describe('readRecord (AC4, adversary R4)', () => {
  it('refuses a file that is JSON but not a record, so the app never writes over it', () => {
    for (const raw of ['null', '[]', '"text"', '42']) {
      expect(() => readRecord(raw, NOW, 'phone'), raw).toThrow();
    }
  });

  it('reads a record', () => {
    expect(readRecord(JSON.stringify(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland')), NOW, 'phone').measurements).toEqual([]);
  });
});
