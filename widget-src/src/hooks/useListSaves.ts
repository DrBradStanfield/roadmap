import { useCallback, useEffect, useRef } from 'react';
import { saveMedication, saveScreening, saveSupplement, deleteSupplementApi, loadLatestMeasurements } from '../lib/roadmap-data';
import { patchMirror } from '../lib/storage';
import * as listSaves from '../lib/list-saves';
import type { ListSaves } from '../lib/list-saves';
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
 * (`flushListSaves`), or is dropped unsaved: by an erase (`dropListSaves`),
 * by the page unmounting, or by the supplement's own stop.
 *
 * After every medication or screening save, refused or not, the chat copy
 * takes the lists the store holds (US-15 AC10); a refusal is also reported
 * (`writeRefused`). A supplement's save or stop that the store refuses is
 * reported; the chat copy holds no supplements.
 */

/** The lists the store holds, for the chat copy (US-15 AC10). Never the
 *  form's: a failed save would leave a row the record lacks, and a re-read
 *  inside the debounce would put the old list back with nothing to undo it. */
async function mirrorSavedLists(): Promise<void> {
  const result = await loadLatestMeasurements();
  if (result) patchMirror({ medications: result.medications, screenings: result.screenings });
}
export function useListSaves(record: RecordPatches, writeRefused: () => void) {
  const { patchMedication, patchScreening, patchSupplement, stopSupplement } = record;
  const medSaves = useRef<ListSaves>(new Map());
  const screeningSaves = useRef<ListSaves>(new Map());
  const supplementSaves = useRef<ListSaves>(new Map());
  const all = () => [medSaves.current, screeningSaves.current, supplementSaves.current];

  const afterListSave = useCallback((saved: boolean) => {
    if (!saved) writeRefused();
    return mirrorSavedLists();
  }, [writeRefused]);
  const dropListSaves = useCallback(() => listSaves.dropListSaves(all()), []);
  const flushListSaves = useCallback(() => listSaves.flushListSaves(all()), []);
  // Unmounting drops what waits: a save after the page is gone would be stale.
  useEffect(() => () => listSaves.dropListSaves(all()), []);
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
    listSaves.debounceSave(medSaves.current, medicationKey,
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
    listSaves.debounceSave(screeningSaves.current, screeningKey,
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
    listSaves.debounceSave(supplementSaves.current, supplementKey,
      (erase) => void saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt, erase).then(saved => { if (!saved) writeRefused(); }));
  }, [writeRefused, patchSupplement]);

  const handleSupplementDelete = useCallback((supplementKey: string) => {
    // A dose save still waiting would land after the stop and restart the row.
    listSaves.cancelListSave(supplementSaves.current, supplementKey);
    stopSupplement(supplementKey);
    void deleteSupplementApi(supplementKey).then(saved => { if (!saved) writeRefused(); });
  }, [writeRefused, stopSupplement]);

  return {
    handleMedicationChange, handleScreeningChange, handleSupplementChange, handleSupplementDelete,
    flushListSaves, dropListSaves, medicationWaiting,
  };
}
