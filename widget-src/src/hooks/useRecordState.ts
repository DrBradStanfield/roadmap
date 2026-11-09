// The screen's copy of the record (untangle W1-4): the plan's latest values,
// every measurement, the lab rows, the documents and the three lists. The
// store is authoritative. This copy changes only four ways:
//   a re-read replaces it (applyLists, and the setters reloadValues uses);
//   an erase empties it (clearForErase);
//   a list change patches one row ahead of its save (patchRow, stopSupplement),
//     which the next re-read confirms or replaces;
//   a deleted document leaves the list (setDocumentHistory).
import { useCallback, useMemo, useState } from 'react';
import { BLOOD_TEST_METRICS, VITAL_METRICS, type ApiMeasurement, type ApiMedication, type ApiScreening } from '@roadmap/health-core/mappings';
import type { ApiDocument, ApiLabValue, ApiSupplement } from '../lib/api-types';
import { loadAllHistorySync, loadLabValuesSync } from '../lib/roadmap-data';

const sameRows = (a: ApiMeasurement[], b: ApiMeasurement[]) =>
  a.length === b.length && a.every((r, i) => r.id === b[i].id && r.value === b[i].value && r.recordedAt === b[i].recordedAt);

/** What a re-read hands back for the lists. */
export interface RecordLists {
  medications: ApiMedication[];
  screenings: ApiScreening[];
  supplements?: ApiSupplement[];
  documents: ApiDocument[];
}

/** The row under `key`, rebuilt from the one it replaces (if any), or added at the end. */
function upsert<T>(rows: T[], match: (r: T) => boolean, build: (old: T | undefined) => T): T[] {
  const i = rows.findIndex(match);
  return i >= 0 ? [...rows.slice(0, i), build(rows[i]), ...rows.slice(i + 1)] : [...rows, build(undefined)];
}

export function useRecordState(initialPrevious: () => ApiMeasurement[]) {
  const [previousMeasurements, setPreviousMeasurementsRaw] = useState<ApiMeasurement[]>(initialPrevious);
  const setPreviousMeasurements = useCallback((next: ApiMeasurement[]) => setPreviousMeasurementsRaw(prev => (sameRows(prev, next) ? prev : next)), []);
  // Every active measurement, re-read after each save. The blood-test matrix
  // and the vitals matrix (StartingInfoVitals) each read their own metrics.
  // Read at mount too, with the record, so the phone's rows never show Add
  // for a saved value while the first load runs (US-62 AC8).
  const [history, setHistory] = useState<ApiMeasurement[]>(loadAllHistorySync);
  const bloodTestHistory = useMemo(() => history.filter(r => BLOOD_TEST_METRICS.includes(r.metricType)), [history]);
  const vitalsHistory = useMemo(() => history.filter(r => VITAL_METRICS.includes(r.metricType)), [history]);
  const [documentHistory, setDocumentHistory] = useState<ApiDocument[]>([]);
  const [labValueHistory, setLabValueHistory] = useState<ApiLabValue[]>(() => loadLabValuesSync() ?? []);
  const [medications, setMedications] = useState<ApiMedication[]>([]);
  const [screenings, setScreenings] = useState<ApiScreening[]>([]);
  const [supplements, setSupplements] = useState<ApiSupplement[]>([]);

  const applyLists = useCallback((r: RecordLists) => {
    setMedications(r.medications);
    setScreenings(r.screenings);
    if (r.supplements) setSupplements(r.supplements);
    setDocumentHistory(r.documents);
  }, []);
  const clearForErase = useCallback(() => {
    setPreviousMeasurements([]);
    setHistory([]);
    setLabValueHistory([]);
    setDocumentHistory([]);
    setMedications([]);
    setScreenings([]);
    setSupplements([]);
  }, [setPreviousMeasurements]);
  const patchMedication = useCallback((key: string, build: (old?: ApiMedication) => ApiMedication) =>
    setMedications(prev => upsert(prev, m => m.medicationKey === key, build)), []);
  const patchScreening = useCallback((key: string, build: (old?: ApiScreening) => ApiScreening) =>
    setScreenings(prev => upsert(prev, s => s.screeningKey === key, build)), []);
  const patchSupplement = useCallback((key: string, build: (old?: ApiSupplement) => ApiSupplement) =>
    setSupplements(prev => upsert(prev, s => s.supplementKey === key, build)), []);
  // A stopped key stays reserved for later additions, as it is after a reload.
  const stopSupplement = useCallback((key: string) =>
    setSupplements(prev => prev.map(s => s.supplementKey === key ? { ...s, status: 'stopped', updatedAt: new Date().toISOString() } : s)), []);

  return {
    previousMeasurements, history, bloodTestHistory, vitalsHistory, documentHistory, labValueHistory, medications, screenings, supplements,
    setPreviousMeasurements, setHistory, setLabValueHistory, setDocumentHistory,
    applyLists, clearForErase, patchMedication, patchScreening, patchSupplement, stopSupplement,
  };
}
