import { useCallback, useEffect, useRef } from 'react';
import { saveMedication, saveScreening, saveSupplement, deleteSupplementApi } from '../lib/roadmap-data';
import { debounceSave, cancelListSave, flushListSaves, type ListSaves } from '../lib/list-saves';
import type { useRecordState } from './useRecordState';

type RecordPatches = Pick<ReturnType<typeof useRecordState>, 'patchMedication' | 'patchScreening' | 'patchSupplement' | 'stopSupplement'>;

/**
 * The medication, screening and supplement saves (US-06 AC13, US-16 AC2a).
 *
 * Each row (one medication, screening or supplement key) is in one of two
 * states:
 * - idle: nothing waits;
 * - waiting: a change is on its 300 ms timer, carrying the erase the page
 *   showed when the change was made. A newer change to the same row restarts
 *   it.
 * A change is shown at once (the record copy is patched ahead of its save).
 * A waiting save then fires on its timer, or now when the page goes away
 * (`flushAll`), or is dropped: by an erase (`dropAll`), by the page
 * unmounting, or by the supplement's own stop. A save the store refuses goes
 * to `afterListSave`, or `writeRefused` for a supplement.
 */
export function useListSaves(record: RecordPatches, afterListSave: (saved: boolean) => Promise<void> | void, writeRefused: () => void) {
  const { patchMedication, patchScreening, patchSupplement, stopSupplement } = record;
  const medSaves = useRef<ListSaves>(new Map());
  const screeningSaves = useRef<ListSaves>(new Map());
  const supplementSaves = useRef<ListSaves>(new Map());
  const all = () => [medSaves.current, screeningSaves.current, supplementSaves.current];

  /** Drop every waiting save without running it. */
  const dropAll = useCallback(() => {
    for (const saves of all()) {
      for (const { timer } of saves.values()) clearTimeout(timer);
      saves.clear();
    }
  }, []);
  /** Run every waiting save now, as the page goes away. */
  const flushAll = useCallback(() => flushListSaves(all()), []);
  // Unmounting drops what waits: a save after the page is gone would be stale.
  useEffect(() => () => {
    for (const saves of all()) for (const { timer } of saves.values()) clearTimeout(timer);
  }, []);
  /** A medication's save still waits (the chat's Undo reads it, US-16). */
  const medicationWaiting = useCallback((key: string) => medSaves.current.has(key), []);

  const handleMedicationChange = useCallback((
    medicationKey: string,
    drugName: string,
    doseValue: number | null,
    doseUnit: string | null,
  ) => {
    // Shown at once, ahead of the save.
    patchMedication(medicationKey, old => ({
      id: old?.id ?? '',
      medicationKey,
      drugName,
      doseValue,
      doseUnit,
      updatedAt: new Date().toISOString(),
    }));
    debounceSave(medSaves.current, medicationKey,
      (erase) => void saveMedication(medicationKey, drugName, doseValue, doseUnit, erase).then(afterListSave));
  }, [afterListSave, patchMedication]);

  // `erase`: a caller that asked before now, such as an upload (US-16 AC2a).
  const handleScreeningChange = useCallback((screeningKey: string, value: string, erase?: string) => {
    patchScreening(screeningKey, old => ({
      id: old?.id ?? '',
      screeningKey,
      value,
      updatedAt: new Date().toISOString(),
    }));
    debounceSave(screeningSaves.current, screeningKey,
      (stamp) => void saveScreening(screeningKey, value, stamp).then(afterListSave), erase);
  }, [afterListSave, patchScreening]);

  const handleSupplementChange = useCallback((
    supplementKey: string,
    supplementName: string,
    doseValue: number | null,
    doseUnit: string | null,
    status: string = 'active',
    startedAt?: string,
  ) => {
    patchSupplement(supplementKey, old => ({
      id: old?.id ?? '',
      supplementKey,
      supplementName,
      doseValue,
      doseUnit,
      status,
      startedAt: startedAt ?? old?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    debounceSave(supplementSaves.current, supplementKey,
      (erase) => void saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt, erase).then(saved => { if (!saved) writeRefused(); }));
  }, [writeRefused, patchSupplement]);

  const handleSupplementDelete = useCallback((supplementKey: string) => {
    // A dose save still waiting would land after the stop and restart the row.
    cancelListSave(supplementSaves.current, supplementKey);
    stopSupplement(supplementKey);
    void deleteSupplementApi(supplementKey).then(saved => { if (!saved) writeRefused(); });
  }, [writeRefused, stopSupplement]);

  return {
    handleMedicationChange, handleScreeningChange, handleSupplementChange, handleSupplementDelete,
    flushAll, dropAll, medicationWaiting,
  };
}
