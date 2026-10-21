// US-25 AC17: blood pressure as one reading on the phone, and height in feet
// and inches. Both through health-core's own writes and conversions.
import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord } from './my-data';
import { metricHistory } from './my-data-forms';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';

function edited(file: RoadmapFile, now: string, ...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((current, edit) => {
    const outcome = applyEdit(current, edit, now);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  }, file);
}

const nz = () => newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
const us = () => newRecord(NOW, 'phone', 'en-US', 'America/New_York');

describe('blood pressure, one reading (US-25 AC17)', () => {
  it('My data shows one row, the newest day\'s pair', () => {
    const file = edited(nz(), NOW,
      { kind: 'bloodPressure', systolic: 130, diastolic: 85, day: '2026-09-01' },
      { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    const vitals = myData(file).vitals;
    expect(vitals.map((row) => row.metric)).toEqual(['weight', 'waist', 'blood_pressure']);
    expect(vitals[2]).toMatchObject({ label: 'Blood pressure', unit: 'mmHg', latest: { value: '120/80', day: '2026-10-20' } });
  });

  it('writes both halves on the same day, as the web pairs them', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    expect(file.measurements).toEqual([
      expect.objectContaining({ metricType: 'systolic_bp', value: 120, recordedAt: '2026-10-20', status: 'active' }),
      expect.objectContaining({ metricType: 'diastolic_bp', value: 80, recordedAt: '2026-10-20', status: 'active' }),
    ]);
  });

  it('writes neither half when one is refused', () => {
    const file = nz();
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 120, diastolic: 300, day: '2026-10-20' }, NOW)).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 400, diastolic: 80, day: '2026-10-20' }, NOW)).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2099-01-01' }, NOW)).toMatchObject({ ok: false, reason: 'future-date' });
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 120, day: '2026-10-20' } as never, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(file.measurements).toEqual([]);
  });

  it('asks before replacing a day that holds either half, and writes nothing until asked', () => {
    // A day holding only a diastolic (another writer): the free systolic is not written alone.
    const half = edited(nz(), NOW, { kind: 'add', metric: 'diastolic_bp', value: 80, day: '2026-10-20' });
    const outcome = applyEdit(half, { kind: 'bloodPressure', systolic: 120, diastolic: 82, day: '2026-10-20' }, LATER);
    expect(outcome).toMatchObject({ ok: false, reason: 'slot-occupied', existingId: half.measurements[0].id });
  });

  it('replacing corrects only the half that changed: a correctsId row, the old one entered-in-error', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    const [sys, dia] = file.measurements;
    const fixed = edited(file, LATER, { kind: 'bloodPressure', systolic: 125, diastolic: 80, day: '2026-10-20', replace: true });
    expect(fixed.measurements).toHaveLength(3);
    expect(fixed.measurements[0]).toMatchObject({ id: sys.id, status: 'entered-in-error', value: 120 });
    expect(fixed.measurements[1]).toEqual(dia);
    expect(fixed.measurements[2]).toMatchObject({ metricType: 'systolic_bp', value: 125, correctsId: sys.id, status: 'active', recordedAt: '2026-10-20' });
    // The same pair again changes nothing.
    expect(applyEdit(fixed, { kind: 'bloodPressure', systolic: 125, diastolic: 80, day: '2026-10-20', replace: true }, LATER)).toEqual({ ok: true, file: fixed });
  });

  it('a replacement with one half out of range corrects neither', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 125, diastolic: 20, day: '2026-10-20', replace: true }, LATER)).toMatchObject({ ok: false });
  });

  it('history lists each day\'s pair newest first, a replaced pair struck, the plan\'s current marked', () => {
    let file = edited(nz(), NOW,
      { kind: 'bloodPressure', systolic: 130, diastolic: 85, day: '2026-09-01' },
      { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    file = edited(file, LATER, { kind: 'bloodPressure', systolic: 118, diastolic: 78, day: '2026-10-20', replace: true });
    const history = metricHistory(file, 'blood_pressure', LATER);
    expect(history).toMatchObject({ metric: 'blood_pressure', label: 'Blood pressure', unit: 'mmHg', excluded: false });
    expect(history.rows.map((row) => [row.day, row.value, row.status, row.current, row.correction])).toEqual([
      ['2026-10-20', '118/78', 'active', true, true],
      ['2026-10-20', '120/80', 'entered-in-error', false, false],
      ['2026-09-01', '130/85', 'active', false, false],
    ]);
    expect(history.rows[0]).toMatchObject({ systolic: '118', diastolic: '78' });
  });

  it('a day missing a half shows a dash for it', () => {
    const file = edited(nz(), NOW, { kind: 'add', metric: 'systolic_bp', value: 120, day: '2026-10-20' });
    expect(myData(file).vitals[2].latest).toMatchObject({ value: '120/–', day: '2026-10-20' });
    expect(metricHistory(file, 'blood_pressure', NOW).rows[0]).toMatchObject({ value: '120/–', systolic: '120', diastolic: null });
  });
});

describe('height in feet and inches (US-25 AC17)', () => {
  it('shows a US height as feet and inches by the web\'s rule, 11.5 in rounding up to the next foot', () => {
    const file = edited(us(), NOW, { kind: 'profile', heightFeet: 5, heightInches: 10 });
    expect(file.profile.heightCm).toBeCloseTo(177.8, 5);
    expect(myData(file).profile.feetInches).toEqual({ feet: 5, inches: 10 });
    const tall = { ...file, profile: { ...file.profile, heightCm: 71.5 * 2.54 } };
    expect(myData(tall).profile.feetInches).toEqual({ feet: 6, inches: 0 });
  });

  it('shows no feet and inches in metric, or with no height', () => {
    expect(myData(us()).profile.feetInches).toBeNull();
    const metric = edited(nz(), NOW, { kind: 'profile', height: 178 });
    expect(myData(metric).profile.feetInches).toBeNull();
  });

  it('feet and inches mean the same height in either unit system', () => {
    const file = edited(nz(), NOW, { kind: 'profile', heightFeet: 6, heightInches: 0 });
    expect(file.profile.heightCm).toBeCloseTo(182.88, 5);
  });

  it('refuses inches that are not a whole number from 0 to 11, and a height outside the web\'s range', () => {
    const file = us();
    for (const [heightFeet, heightInches] of [[5, 12], [5, -1], [5, 2.5], [5.5, 0]]) {
      expect(applyEdit(file, { kind: 'profile', heightFeet, heightInches }, NOW), `${heightFeet} ft ${heightInches} in`).toMatchObject({ ok: false, reason: 'invalid-value' });
    }
    expect(applyEdit(file, { kind: 'profile', heightFeet: 1, heightInches: 0 }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/50 cm/) });
    expect(applyEdit(file, { kind: 'profile', heightFeet: 9, heightInches: 0 }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/250 cm/) });
  });
});
