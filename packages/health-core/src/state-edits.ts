/**
 * Writing the record's last-write-wins current state: medications and
 * supplements, each a row keyed by its key, with an append-only history row
 * per real change (US-06, ios/architecture.md D4b). The web widget's store
 * and the iPhone app make these writes through the same functions, inside
 * `RecordSession.edit`, so both follow one set of rules.
 *
 * The rules, as `record-edits.ts` states them for clinical values:
 *  - the file passed in is never mutated; a new one comes back;
 *  - a current-state row carries the sync clock the merge reads: `updatedAt`
 *    is the write clock and `lamport` goes up by one on every edit (a new row
 *    starts at 0), so the last write wins on every device;
 *  - a history row is appended, never edited, and only when the change
 *    classifies (history-change.ts): an identical re-save writes none;
 *  - `meta.updatedAt` moves forward to the write clock (rule 6), or
 *    `migrate.ts` would rewind the row just written.
 * No DOM and no Node: engine-portability.test.ts checks. Row ids come from
 * `crypto.randomUUID()`, as in record-edits.ts; the iPhone app's engine
 * supplies it from the phone's own UUID (HealthEngine.swift).
 */
import { classifyMedicationChange, classifySupplementChange } from './history-change';
import { newId, stampUpdatedAt } from './record-edits';
import type { FileMedication, FileSupplement, HistoryChangeType, RoadmapFile } from './roadmap-file';

export interface StateEditResult {
  /** A new file. The one passed in is untouched. */
  file: RoadmapFile;
  /** The history row's change, or null when the save changed nothing that counts. */
  changeType: HistoryChangeType | null;
}

/** The current-state row for `key`, edited or created, with its sync clock. */
function upsert<T extends { id: string; updatedAt: string; lamport?: number }>(
  rows: T[],
  matches: (row: T) => boolean,
  make: () => Omit<T, 'updatedAt' | 'lamport'>,
  update: (row: T) => Partial<T>,
  now: string,
): T[] {
  const index = rows.findIndex(matches);
  if (index === -1) return [...rows, { ...(make() as T), updatedAt: now, lamport: 0 }];
  const row = rows[index];
  const next = { ...row, ...update(row), updatedAt: now, lamport: (row.lamport ?? 0) + 1 };
  return rows.map((r, i) => (i === index ? next : r));
}

export interface MedicationSave {
  medicationKey: string;
  drugName: string;
  doseValue: number | null;
  doseUnit: string | null;
}

/**
 * Save one medication's current state (US-06): the row keyed by
 * `medicationKey`, and a history row when the change classifies (started,
 * stopped, switched, dose changed). An escalation key's answer writes no
 * history (US-06 AC11).
 */
export function upsertMedication(file: RoadmapFile, save: MedicationSave, now: string): StateEditResult {
  const { medicationKey, drugName, doseValue, doseUnit } = save;
  // Classified against the record BEFORE the upsert changes it.
  const prev = file.medications.find((m) => m.medicationKey === medicationKey);
  const changeType = classifyMedicationChange(prev, save);
  const medications = upsert<FileMedication>(
    file.medications,
    (m) => m.medicationKey === medicationKey,
    () => ({ id: newId(), medicationKey, drugName, doseValue, doseUnit }),
    () => ({ drugName, doseValue, doseUnit }),
    now,
  );
  const medicationHistory = changeType
    ? [...file.medicationHistory, { id: newId(), medicationKey, drugName, doseValue, doseUnit, changeType, updatedAt: now }]
    : file.medicationHistory;
  return { file: stampUpdatedAt({ ...file, medications, medicationHistory }, now), changeType };
}

export interface SupplementSave {
  supplementKey: string;
  supplementName: string;
  doseValue: number | null;
  doseUnit: string | null;
  status: FileSupplement['status'];
  /** When it was started; a new row without one starts now. An edit keeps its own. */
  startedAt?: string;
}

/**
 * Save one supplement's current state (US-06): the row keyed by
 * `supplementKey`, and a history row when the change classifies (started,
 * restarted, stopped, switched, dose changed). Stopping is a save with
 * `status: 'stopped'` (a soft stop the merge carries), never a removal.
 */
export function upsertSupplement(file: RoadmapFile, save: SupplementSave, now: string): StateEditResult {
  const { supplementKey, supplementName, doseValue, doseUnit, status, startedAt } = save;
  const prev = file.supplements.find((s) => s.supplementKey === supplementKey);
  const changeType = classifySupplementChange(prev, save);
  const supplements = upsert<FileSupplement>(
    file.supplements,
    (s) => s.supplementKey === supplementKey,
    () => ({ id: newId(), supplementKey, supplementName, doseValue, doseUnit, status, startedAt: startedAt ?? now }),
    () => ({ supplementName, doseValue, doseUnit, status }),
    now,
  );
  const supplementHistory = changeType
    ? [...file.supplementHistory, {
        id: newId(), supplementKey, supplementName, doseValue, doseUnit, status,
        startedAt: prev?.startedAt ?? startedAt ?? now, changeType, updatedAt: now,
      }]
    : file.supplementHistory;
  return { file: stampUpdatedAt({ ...file, supplements, supplementHistory }, now), changeType };
}
