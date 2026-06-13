/**
 * Pure change-classifiers for the v2 medication/supplement history logs.
 *
 * Given the record's previous state (undefined when the key has never been
 * saved) and the state being saved, return the `HistoryChangeType` the save
 * represents — or null when no history row is warranted. The store appends one
 * `medicationHistory`/`supplementHistory` row per non-null result, so:
 *
 *  - re-saving an identical record is a no-op (no duplicate rows), and
 *  - flipping between non-taking statuses (none ↔ not_yet ↔ not_tolerated) is
 *    a form-state correction, not a clinical event — no row.
 *
 * Mirrors v1's server-side `recordMedicationChange`/`recordSupplementChange`
 * (pre-teardown app/lib/supabase.server.ts) with one refinement: the first
 * save of a non-taking status records nothing (v1 logged it as 'initial').
 */
import type { FileMedication, FileSupplement, HistoryChangeType } from './roadmap-file';

/**
 * Status placeholders stored in `drugName` that mean "not currently taking"
 * (see the FHIR MedicationStatement table in CLAUDE.md). Anything else —
 * including the legacy boolean-ish 'yes' some keys use — is an actual drug.
 */
const NON_TAKING_DRUG_NAMES = new Set(['none', 'no', 'not_yet', 'not_tolerated']);

/** Is this `drugName` an actually-taken drug (vs a not-taking status)? */
export function isTakingDrug(drugName: string | null | undefined): boolean {
  return !!drugName && !NON_TAKING_DRUG_NAMES.has(drugName);
}

/** Classify a medication save against the current record. Null = no history row. */
export function classifyMedicationChange(
  prev: Pick<FileMedication, 'drugName' | 'doseValue' | 'doseUnit'> | undefined,
  next: Pick<FileMedication, 'drugName' | 'doseValue' | 'doseUnit'>,
): HistoryChangeType | null {
  const wasTaking = prev !== undefined && isTakingDrug(prev.drugName);
  const nowTaking = isTakingDrug(next.drugName);
  if (!wasTaking && !nowTaking) return null; // none ↔ not_yet ↔ not_tolerated: no event
  if (!wasTaking) return 'started';
  if (!nowTaking) return 'stopped';
  if (prev.drugName !== next.drugName) return 'switched';
  if (prev.doseValue !== next.doseValue || prev.doseUnit !== next.doseUnit) return 'dose_changed';
  return null; // identical re-save
}

/** Classify a supplement save against the current record. Null = no history row. */
export function classifySupplementChange(
  prev: Pick<FileSupplement, 'supplementName' | 'doseValue' | 'doseUnit' | 'status'> | undefined,
  next: Pick<FileSupplement, 'supplementName' | 'doseValue' | 'doseUnit' | 'status'>,
): HistoryChangeType | null {
  const wasActive = prev !== undefined && prev.status === 'active';
  const nowActive = next.status === 'active';
  if (!wasActive && !nowActive) return null; // already stopped (or saved as stopped): no event
  if (!wasActive) return 'started'; // new, or restart of a stopped one
  if (!nowActive) return 'stopped'; // soft-delete
  if (prev.supplementName !== next.supplementName) return 'switched';
  if (prev.doseValue !== next.doseValue || prev.doseUnit !== next.doseUnit) return 'dose_changed';
  return null; // identical re-save
}
