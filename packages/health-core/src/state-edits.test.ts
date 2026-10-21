/**
 * The current-state writes in the engine (US-06, D4b): the keyed row with its
 * sync clock, an append-only history row per real change, the input file
 * untouched, and the file clock moved forward (rule 6). The widget's store
 * tests pin the same writes through RoadmapStore.
 */
import { describe, expect, it } from 'vitest';
import { upsertMedication } from './state-edits';
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
