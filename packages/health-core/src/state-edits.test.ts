/**
 * The current-state writes in the engine (US-06, D4b): the keyed row with its
 * sync clock, an append-only history row per real change, the input file
 * untouched, and the file clock moved forward (rule 6). The widget's store
 * tests pin the same writes through RoadmapStore.
 */
import { describe, expect, it } from 'vitest';
import { setReminderOptIn, setScreening, stampProfile, upsertMedication, upsertSupplement, type SupplementSave } from './state-edits';
import { mergeFiles } from './merge';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-21T10:00:00.000Z';
const T2 = '2026-10-21T11:00:00.000Z';
const empty = (): RoadmapFile => createEmptyFile({ deviceId: 'd', now: T0 });
const statin = (drugName: string, doseValue: number | null = null, doseUnit: string | null = null) =>
  ({ medicationKey: 'statin', drugName, doseValue, doseUnit });

describe('upsertMedication (US-06)', () => {
  it('creates the keyed row at lamport 0 with a started history row, and leaves the input file alone', () => {
    const before = empty();
    const snapshot = structuredClone(before);
    const { file, changeType } = upsertMedication(before, statin('atorvastatin', 10, 'mg'), T1);
    expect(before).toEqual(snapshot);
    expect(changeType).toBe('started');
    expect(file.medications).toEqual([
      { id: expect.any(String), medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg', updatedAt: T1, lamport: 0 },
    ]);
    expect(file.medicationHistory).toEqual([
      { id: expect.any(String), medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg', changeType: 'started', updatedAt: T1 },
    ]);
    expect(file.medicationHistory[0].id).not.toBe(file.medications[0].id);
    expect(file.meta.updatedAt).toBe(T1);
  });

  it('edits the row in place by key, keeping its id, lamport + 1, and records the change', () => {
    const first = upsertMedication(empty(), statin('atorvastatin', 10, 'mg'), T1).file;
    const { file, changeType } = upsertMedication(first, statin('atorvastatin', 20, 'mg'), T2);
    expect(changeType).toBe('dose_changed');
    expect(file.medications).toHaveLength(1);
    expect(file.medications[0]).toMatchObject({ id: first.medications[0].id, doseValue: 20, updatedAt: T2, lamport: 1 });
    expect(file.medicationHistory.map((h) => h.changeType)).toEqual(['started', 'dose_changed']);
    // The earlier file's row is not touched.
    expect(first.medications[0].doseValue).toBe(10);
  });

  it('writes no history for an identical re-save, a not-taking flip, or an escalation answer (US-06 AC11)', () => {
    const taking = upsertMedication(empty(), statin('atorvastatin', 10, 'mg'), T1).file;
    expect(upsertMedication(taking, statin('atorvastatin', 10, 'mg'), T2)).toMatchObject({ changeType: null });
    const notYet = upsertMedication(empty(), statin('not_yet'), T1);
    expect(notYet.changeType).toBeNull();
    expect(upsertMedication(notYet.file, statin('none'), T2).file.medicationHistory).toEqual([]);
    const answer = upsertMedication(empty(), { medicationKey: 'statin_escalation', drugName: 'yes', doseValue: null, doseUnit: null }, T1);
    expect(answer.changeType).toBeNull();
    expect(answer.file.medicationHistory).toEqual([]);
  });

  it('classifies stopped and switched', () => {
    const taking = upsertMedication(empty(), statin('atorvastatin', 10, 'mg'), T1).file;
    expect(upsertMedication(taking, statin('rosuvastatin', 5, 'mg'), T2).changeType).toBe('switched');
    expect(upsertMedication(taking, statin('none'), T2).changeType).toBe('stopped');
  });

  it("wins the merge against another device's older edit of the same row", () => {
    const shared = upsertMedication(empty(), statin('atorvastatin', 10, 'mg'), T1).file;
    const here = upsertMedication(shared, statin('atorvastatin', 40, 'mg'), T2).file;
    const merged = mergeFiles(here, shared, { deviceId: 'd', now: T2 });
    expect(merged.medications.map((m) => m.doseValue)).toEqual([40]);
    // The merge orders history rows by id, and ids are random.
    expect(merged.medicationHistory.map((h) => h.changeType).sort()).toEqual(['dose_changed', 'started']);
  });
});

const omega = (over: Partial<SupplementSave> = {}): SupplementSave =>
  ({ supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g', status: 'active', ...over });

describe('upsertSupplement (US-06)', () => {
  it('creates the keyed row started now (or when given), with a started history row', () => {
    const before = empty();
    const snapshot = structuredClone(before);
    const { file, changeType } = upsertSupplement(before, omega(), T1);
    expect(before).toEqual(snapshot);
    expect(changeType).toBe('started');
    expect(file.supplements).toEqual([{
      id: expect.any(String), supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g',
      status: 'active', startedAt: T1, updatedAt: T1, lamport: 0,
    }]);
    expect(file.supplementHistory).toEqual([{
      id: expect.any(String), supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g',
      status: 'active', startedAt: T1, changeType: 'started', updatedAt: T1,
    }]);
    expect(file.meta.updatedAt).toBe(T1);
    expect(upsertSupplement(empty(), omega({ startedAt: T0 }), T1).file.supplements[0].startedAt).toBe(T0);
  });

  it('a soft stop keeps the row, its id and its startedAt, lamport + 1, and records stopped; a second stop records nothing', () => {
    const first = upsertSupplement(empty(), omega({ startedAt: T0 }), T1).file;
    const stopped = upsertSupplement(first, omega({ status: 'stopped' }), T2);
    expect(stopped.changeType).toBe('stopped');
    expect(stopped.file.supplements).toEqual([expect.objectContaining({
      id: first.supplements[0].id, status: 'stopped', startedAt: T0, updatedAt: T2, lamport: 1,
    })]);
    // The history row carries the row's own start, not the stop's.
    expect(stopped.file.supplementHistory[1]).toMatchObject({ changeType: 'stopped', startedAt: T0 });
    const again = upsertSupplement(stopped.file, omega({ status: 'stopped' }), T2);
    expect(again.changeType).toBeNull();
    expect(again.file.supplementHistory).toHaveLength(2);
  });

  it('classifies a restart, a switch and a dose change; an identical re-save writes none', () => {
    const active = upsertSupplement(empty(), omega(), T1).file;
    const stopped = upsertSupplement(active, omega({ status: 'stopped' }), T2).file;
    expect(upsertSupplement(stopped, omega(), T2).changeType).toBe('started');
    expect(upsertSupplement(active, omega({ supplementName: 'Fish oil' }), T2).changeType).toBe('switched');
    expect(upsertSupplement(active, omega({ doseValue: 2 }), T2).changeType).toBe('dose_changed');
    expect(upsertSupplement(active, omega(), T2).changeType).toBeNull();
  });

  it("wins the merge against another device's older edit of the same row", () => {
    const shared = upsertSupplement(empty(), omega(), T1).file;
    const here = upsertSupplement(shared, omega({ status: 'stopped' }), T2).file;
    const merged = mergeFiles(shared, here, { deviceId: 'd', now: T2 });
    expect(merged.supplements.map((x) => x.status)).toEqual(['stopped']);
  });
});

describe('stampProfile, setScreening, setReminderOptIn (US-10 AC6, US-17)', () => {
  it('stamps only the profile fields changed, and the file clock', () => {
    const before = empty();
    const snapshot = structuredClone(before);
    const file = stampProfile(before, { sex: 'female', heightCm: 165 }, T1);
    expect(before).toEqual(snapshot);
    expect(file.profile).toMatchObject({ sex: 'female', heightCm: 165 });
    expect(Object.keys(file.profile.fieldStamps ?? {}).sort()).toEqual(['heightCm', 'sex']);
    expect(file.meta.updatedAt).toBe(T1);
    // A concurrent edit of another field elsewhere survives the merge.
    const other = stampProfile(before, { birthYear: 1970 }, T2);
    const merged = mergeFiles(file, other, { deviceId: 'd', now: T2 });
    expect(merged.profile).toMatchObject({ sex: 'female', heightCm: 165, birthYear: 1970 });
  });

  it('stores a screening answer as text, a number answer as a number, and a blank number as null', () => {
    const before = empty();
    const text = setScreening(before, 'colorectal_method', 'colonoscopy_10yr', T1);
    expect(before.screenings).toEqual(empty().screenings);
    expect(text.screenings).toMatchObject({ colorectalMethod: 'colonoscopy_10yr' });
    expect(text.meta.updatedAt).toBe(T1);
    expect(setScreening(text, 'prostate_psa_value', '1,5', T2).screenings).toMatchObject({ prostatePsaValue: 1.5 });
    expect(setScreening(text, 'prostate_psa_value', '', T2).screenings).toMatchObject({ prostatePsaValue: null });
    expect(Object.keys(setScreening(text, 'prostate_psa_value', '2', T2).screenings.fieldStamps ?? {}).sort()).toEqual(['colorectalMethod', 'prostatePsaValue']);
  });

  // US-02 AC7: a refused number never clears what is stored. "1,234" PSA
  // (0-10000), "abc", and pack-years "150,500" (only the decimal reading fits,
  // which is never chosen) leave the file as it was. So does a number outside
  // the answer's range, grouped thousands included (Codex R2: "1,234,567"
  // pack-years was stored).
  it('refuses an unreadable, ambiguous or out-of-range number answer and keeps the stored one (US-02 AC7)', () => {
    const held = setScreening(empty(), 'prostate_psa_value', '2', T1);
    for (const value of ['1,234', 'abc', '1,2,3', '10001', '-1']) {
      expect(setScreening(held, 'prostate_psa_value', value, T2)).toBe(held);
    }
    for (const value of ['150,500', '1,234,567', '201']) {
      expect(setScreening(held, 'lung_pack_years', value, T2)).toBe(held);
    }
    expect(setScreening(held, 'prostate_psa_value', '4,5', T2).screenings).toMatchObject({ prostatePsaValue: 4.5 });
    expect(setScreening(held, 'lung_pack_years', '200', T2).screenings).toMatchObject({ lungPackYears: 200 });
  });

  it('replaces the reminders opt-in with lamport one past the last, and the file clock', () => {
    const fields = { status: 'active' as const, token: 't', email: 'a@b.c', provider: 'dropbox' as const };
    const first = setReminderOptIn(empty(), fields, T1);
    expect(first.reminderOptIn).toEqual({ ...fields, updatedAt: T1, lamport: 1 });
    expect(first.meta.updatedAt).toBe(T1);
    const cancelled = setReminderOptIn(first, { ...fields, status: 'cancelled' }, T2);
    expect(cancelled.reminderOptIn).toMatchObject({ status: 'cancelled', updatedAt: T2, lamport: 2 });
    expect(first.reminderOptIn?.status).toBe('active');
  });
});
