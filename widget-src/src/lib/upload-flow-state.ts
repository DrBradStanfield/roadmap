import type { LabUnitRefusal, MeasurementRefusal } from '@roadmap/health-core/record-edits';
import type { FileNotice, FileResult } from './upload-pipeline';

/** One session's save outcome (US-12 AC6c). The saved counts add up across a
 *  retry, which finishes what the first Save began; the rest are the last
 *  attempt's. Documents count by content, else name: a retry may refile one. `unstored`: originals the cloud would not store behind details it
 *  already holds (US-14 AC4). The refusals are lab rows in a unit the record
 *  does not know for that test, and core values it refused: each is named, as
 *  a dropped value must never be silent (US-21 phase 3, US-35 AC17). */
export interface SaveOutcome {
  values: number; labValues: number; documents: string[];
  skippedValues: number; skippedLabValues: number; unstored: number;
  refusedLabUnits: LabUnitRefusal[]; refusedMeasurements: MeasurementRefusal[];
}
export const NO_OUTCOME: SaveOutcome = { values: 0, labValues: 0, documents: [], skippedValues: 0, skippedLabValues: 0, unstored: 0, refusedLabUnits: [], refusedMeasurements: [] };

/** What earlier attempts saved. The last attempt's skips, errors and refusals
 *  belong to it: never beside a new error. */
export const savedSoFar = (o: SaveOutcome): SaveOutcome => ({ ...NO_OUTCOME, values: o.values, labValues: o.labValues, documents: o.documents });

export type Progress = { current: number; total: number; fileName: string };

/**
 * The upload flow, one named phase at a time, each carrying its own data (US-12).
 *
 * - picking: the dropzone. `notices`: an oversize-only pick's tooLarge list.
 * - reading: the files are being read. Cancel returns to picking; a refusal
 *   or failure goes to readFailed; a finished read goes to reviewing.
 * - readFailed: the dropzone again, with the read's message. A new pick reads again.
 * - reviewing: the review table. Save goes to saving.
 * - saving: the save is writing. It ends in done, or in saveFailed.
 * - saveFailed: the review stays open, with the save's message. Save retries.
 * - done: everything saved. `results` stays for the "Not saved" list.
 *
 * Discard returns any phase but saving to picking. Close does so only from
 * picking, readFailed and done; elsewhere it only hides the work.
 */
export type UploadState =
  | { phase: 'picking'; notices: FileNotice[] }
  | { phase: 'reading'; files: File[]; notices: FileNotice[]; progress: Progress }
  | { phase: 'readFailed'; files: File[]; notices: FileNotice[]; message: string }
  | { phase: 'reviewing'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome }
  | { phase: 'saving'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome }
  | { phase: 'saveFailed'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome; message: string }
  | { phase: 'done'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome };
export type UploadPhase = UploadState['phase'];

export type UploadEvent =
  | { type: 'picked'; files: File[]; notices: FileNotice[] }
  | { type: 'progress'; progress: Progress }
  | { type: 'readFailed'; message: string; notices: FileNotice[] }
  | { type: 'read'; results: FileResult[]; notices: FileNotice[] }
  | { type: 'cancel' }
  | { type: 'close' }
  | { type: 'discard' }
  | { type: 'saveStarted' }
  | { type: 'saveWritten'; outcome: SaveOutcome }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string };

export const INITIAL_UPLOAD: UploadState = { phase: 'picking', notices: [] };

/** The only way the flow changes. An event a phase does not take returns the
 *  same object, so React skips the render. */
export function transition(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case 'picked':
      if (state.phase !== 'picking' && state.phase !== 'readFailed') return state;
      return event.files.length > 0
        ? { phase: 'reading', files: event.files, notices: event.notices, progress: { current: 0, total: 100, fileName: 'Preparing upload...' } }
        : { phase: 'picking', notices: event.notices };
    case 'progress':
      return state.phase === 'reading' ? { ...state, progress: event.progress } : state;
    case 'readFailed':
      return state.phase === 'reading' ? { phase: 'readFailed', files: state.files, notices: event.notices, message: event.message } : state;
    case 'read':
      return state.phase === 'reading' ? { phase: 'reviewing', results: event.results, notices: event.notices, outcome: NO_OUTCOME } : state;
    case 'cancel':
      return state.phase === 'reading' ? INITIAL_UPLOAD : state;
    case 'close':
      return state.phase === 'picking' || state.phase === 'readFailed' || state.phase === 'done' ? INITIAL_UPLOAD : state;
    case 'discard':
      return state.phase === 'saving' ? state : INITIAL_UPLOAD;
    case 'saveStarted':
      return state.phase === 'reviewing' || state.phase === 'saveFailed'
        ? { phase: 'saving', results: state.results, notices: state.notices, outcome: savedSoFar(state.outcome) }
        : state;
    case 'saveWritten':
      return state.phase === 'saving' ? { ...state, outcome: event.outcome } : state;
    case 'saved':
      return state.phase === 'saving' ? { phase: 'done', results: state.results, notices: state.notices, outcome: state.outcome } : state;
    case 'saveFailed':
      return state.phase === 'saving' ? { ...state, phase: 'saveFailed', message: event.message } : state;
  }
}
