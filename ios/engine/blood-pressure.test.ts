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
/** A moment `ms` milliseconds after `at`, as the web stamps each half with its own `new Date()`. */
const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
/** The ids of the day's active halves: what the screen showed the user. */
const seen = (file: RoadmapFile, day = '2026-10-20') => file.measurements
  .filter((row) => row.status === 'active' && row.recordedAt.slice(0, 10) === day && row.metricType.endsWith('_bp'))
  .map((row) => row.id);
/** A pair as the web writes it: each half its own row, 1 ms apart. */
const webPair = (systolic: number, diastolic: number) => edited(edited(nz(), NOW, { kind: 'add', metric: 'systolic_bp', value: systolic, day: '2026-10-20' }), plus(NOW, 1),
  { kind: 'add', metric: 'diastolic_bp', value: diastolic, day: '2026-10-20' });
const history = (file: RoadmapFile) => metricHistory(file, 'blood_pressure', LATER).rows.map((row) => [row.day, row.value, row.status]);

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

  it('replacing corrects only the half that changed, so merge never re-asserts the other (review, 2026-10-22)', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    const [sys, dia] = file.measurements;
    const fixed = edited(file, LATER, { kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true, seenIds: seen(file) });
    expect(fixed.measurements).toHaveLength(3);
    expect(fixed.measurements[0]).toMatchObject({ id: sys.id, status: 'entered-in-error', value: 120 });
    expect(fixed.measurements[1]).toEqual(dia);
    expect(fixed.measurements[2]).toMatchObject({ metricType: 'systolic_bp', value: 130, correctsId: sys.id, status: 'active', recordedAt: '2026-10-20' });
    // The struck pair is rebuilt from the chain: the diastolic active before the revision.
    expect(history(fixed)).toEqual([['2026-10-20', '130/80', 'active'], ['2026-10-20', '120/80', 'entered-in-error']]);
    // The exact same pair again writes nothing.
    expect(applyEdit(fixed, { kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true, seenIds: seen(fixed) }, LATER)).toEqual({ ok: true, file: fixed });
  });

  it('replacing a day that holds one half corrects it and adds the other', () => {
    const half = edited(nz(), NOW, { kind: 'add', metric: 'diastolic_bp', value: 80, day: '2026-10-20' });
    const fixed = edited(half, LATER, { kind: 'bloodPressure', systolic: 120, diastolic: 82, day: '2026-10-20', replace: true, seenIds: seen(half) });
    expect(fixed.measurements.map((row) => [row.metricType, row.value, row.status, row.correctsId ?? null])).toEqual([
      ['diastolic_bp', 80, 'entered-in-error', null],
      ['systolic_bp', 120, 'active', null],
      ['diastolic_bp', 82, 'active', half.measurements[0].id],
    ]);
  });

  it('refuses a replacement when the day\'s rows changed under the user (Codex R1, adversary R3)', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    const shown = seen(file);
    // Another device corrects the diastolic before Save.
    const dia = file.measurements[1];
    const moved = edited(file, LATER, { kind: 'correct', id: dia.id, value: 78 });
    const outcome = applyEdit(moved, { kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true, seenIds: shown }, LATER);
    expect(outcome).toMatchObject({ ok: false, reason: 'record-changed', message: expect.stringMatching(/^Your record changed while this was open/) });
    // A replacement must say what it saw.
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true }, LATER)).toMatchObject({ ok: false, reason: 'record-changed' });
  });

  it('a replacement with one half out of range corrects neither', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    expect(applyEdit(file, { kind: 'bloodPressure', systolic: 125, diastolic: 20, day: '2026-10-20', replace: true, seenIds: seen(file) }, LATER)).toMatchObject({ ok: false });
  });

  it('history lists each day\'s pair newest first, a replaced pair struck, the plan\'s current marked', () => {
    let file = edited(nz(), NOW,
      { kind: 'bloodPressure', systolic: 130, diastolic: 85, day: '2026-09-01' },
      { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    file = edited(file, LATER, { kind: 'bloodPressure', systolic: 118, diastolic: 78, day: '2026-10-20', replace: true, seenIds: seen(file) });
    const history = metricHistory(file, 'blood_pressure', LATER);
    expect(history).toMatchObject({ metric: 'blood_pressure', label: 'Blood pressure', unit: 'mmHg', excluded: false });
    expect(history.rows.map((row) => [row.day, row.value, row.status, row.current, row.correction])).toEqual([
      ['2026-10-20', '118/78', 'active', true, true],
      ['2026-10-20', '120/80', 'entered-in-error', false, false],
      ['2026-09-01', '130/85', 'active', false, false],
    ]);
    expect(history.rows[0]).toMatchObject({ systolic: '118', diastolic: '78' });
  });

  it('pairs web-style halves written 1 ms apart, then a phone replace, as one struck pair', () => {
    const web = webPair(120, 80);
    const fixed = edited(web, LATER, { kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true, seenIds: seen(web) });
    expect(history(fixed)).toEqual([['2026-10-20', '130/80', 'active'], ['2026-10-20', '120/80', 'entered-in-error']]);
  });

  it('a web-style correction of both halves 1 ms apart is one revision, one struck pair', () => {
    const file = webPair(120, 80);
    const [sys, dia] = file.measurements;
    const fixed = edited(edited(file, LATER, { kind: 'correct', id: sys.id, value: 125 }), plus(LATER, 1), { kind: 'correct', id: dia.id, value: 82 });
    expect(history(fixed)).toEqual([['2026-10-20', '125/82', 'active'], ['2026-10-20', '120/80', 'entered-in-error']]);
  });

  it('two revisions a day apart are two struck pairs, newest first', () => {
    const file = webPair(120, 80);
    const once = edited(file, LATER, { kind: 'bloodPressure', systolic: 125, diastolic: 80, day: '2026-10-20', replace: true, seenIds: seen(file) });
    const twice = edited(once, plus(LATER, 86_400_000), { kind: 'bloodPressure', systolic: 125, diastolic: 75, day: '2026-10-20', replace: true, seenIds: seen(once) });
    expect(history(twice)).toEqual([
      ['2026-10-20', '125/75', 'active'],
      ['2026-10-20', '125/80', 'entered-in-error'],
      ['2026-10-20', '120/80', 'entered-in-error'],
    ]);
  });

  it('a correction stamped the same instant as its original still strikes the original (found by MyDataLayoutTests: "–/–")', () => {
    const file = edited(nz(), NOW, { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' });
    const fixed = edited(file, NOW, { kind: 'bloodPressure', systolic: 125, diastolic: 80, day: '2026-10-20', replace: true, seenIds: seen(file) });
    expect(history(fixed)).toEqual([['2026-10-20', '125/80', 'active'], ['2026-10-20', '120/80', 'entered-in-error']]);
  });

  it('a half that never had a partner shows a dash, struck or not', () => {
    const lone = edited(nz(), NOW, { kind: 'add', metric: 'systolic_bp', value: 120, day: '2026-10-20' });
    const fixed = edited(lone, LATER, { kind: 'correct', id: lone.measurements[0].id, value: 125 });
    expect(history(fixed)).toEqual([['2026-10-20', '125/–', 'active'], ['2026-10-20', '120/–', 'entered-in-error']]);
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

  it('Save without a change writes nothing, so 178 cm is never rounded to 177.8 (adversary R4)', () => {
    const file = edited(us(), NOW, { kind: 'profile', height: 178 / 2.54 });
    expect(myData(file).profile.feetInches).toEqual({ feet: 5, inches: 10 });
    expect(applyEdit(file, { kind: 'profile', heightFeet: 5, heightInches: 10 }, LATER)).toEqual({ ok: true, file });
    // A real change still writes.
    const changed = applyEdit(file, { kind: 'profile', heightFeet: 5, heightInches: 11 }, LATER);
    expect(changed.ok && changed.file.profile.heightCm).toBeCloseTo(180.34, 5);
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
