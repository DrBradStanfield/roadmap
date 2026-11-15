// The store's app-facing result shapes: moved from roadmap-store.ts unchanged, so that file does
// not grow (file budget); roadmap-store.ts re-exports them, so importers are unchanged.
import type { MoveRejection } from '@roadmap/health-core/record-edits';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import type { SaveOutcome } from '@roadmap/health-core/upload-flow';

/** How a correction ended. `changed`: the value named is not there any
 *  more, or another row has replaced it (another device, a connector).
 *  `invalid`: the record does not take that number (outside the metric's
 *  range). `refused`: a lab value past its plausible range, in the engine's
 *  words, which the page shows as the iPhone and MCP do (US-21 AC26).
 *  `error`: no record is open. */
export type CorrectStatus = 'ok' | 'changed' | 'invalid' | 'error' | { refused: string };
/** How a blood test move ended (US-04 AC5), as a correction does. `changed`:
 *  the test on that day is not what the page showed. `invalid` carries the
 *  record's refusal, for the page to say. */
export type MoveOutcome = { status: Exclude<Extract<CorrectStatus, string>, 'invalid'> } | { status: 'invalid'; refusal: MoveRejection };
/** A birth month in the future that a save refused (US-54 AC5b): the pair judged. */
export interface BirthRefusal { birthYear: number; birthMonth: number | undefined }
/** A profile save: refused by the erase, or saved with any birth month it refused. */
/** A profile value outside its range, by field, with why (US-02 AC5): never written. */
export type ProfileRangeRefusal = Partial<Record<keyof HealthInputs, string>>;
/** `added`: the rows the save inserted as new, never a correction or a refused number (US-07 AC11's usage signal). */
export type ProfileSave = { ok: false } | { ok: true; birthRefused: BirthRefusal | null; added: ApiMeasurement[]; refused?: ProfileRangeRefusal };
/** One reviewed upload row. `correctsId` is set only when the reviewer ticked
 *  "Replace" on a slot another writer (a connector, another device) already
 *  holds — it turns the write into a FHIR correction instead of a skip. */
/** `comparator`: a result printed as a limit, saved as printed (US-12 AC20). */
export interface BulkMeasurementInput {
  metricType: string; value: number; recordedAt: string; source: MeasurementSource; correctsId?: string; comparator?: Comparator;
}
export interface BulkLabValueInput {
  metricName: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; source?: string; correctsId?: string; comparator?: Comparator;
}

/** One upload Save: what it wrote, or `message` (the review's words; null when the erase refused it). */
export type UploadStoreSave = { ok: true; outcome: Required<SaveOutcome>; added: ApiMeasurement[] } | { ok: false; message: string | null };
