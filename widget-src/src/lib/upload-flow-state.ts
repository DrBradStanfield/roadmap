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
const savedSoFar = (o: SaveOutcome): SaveOutcome => ({ ...NO_OUTCOME, values: o.values, labValues: o.labValues, documents: o.documents });

/** One attempt added to the session: saved counts add up, documents by key
 *  once; skips, unstored and refusals are the attempt's own. */
const withAttempt = (o: SaveOutcome, attempt: SaveOutcome): SaveOutcome => ({
  ...attempt,
  values: o.values + attempt.values,
  labValues: o.labValues + attempt.labValues,
  documents: [...new Set([...o.documents, ...attempt.documents])],
});

export type Progress = { current: number; total: number; fileName: string };
/** A run's own counts for its `upload_outcome` (US-12 AC10): `picked` every file
 *  seen, a ZIP by its members once listed; `docx` the picked .docx, oversize too. */
export type RunCounts = { picked: number; docx: number };

/**
 * The upload flow, one named phase at a time, each carrying its own data (US-12).
 *
 * - picking: the dropzone. `notices`: the pick's own when it started no read
 *   (oversize files, and the files left out past MAX_FILES).
 *   `cancelledRead`: the counts and notices of a read Cancel stopped, for its
 *   one `upload_outcome` (US-12 AC10); a new pick or a reset drops it.
 * - reading: the files are being read. `counts` start as the pick's; `listed`
 *   sets `picked` once ZIP members are known. Cancel returns to picking; a refusal
 *   or failure goes to readFailed; a finished read goes to reviewing.
 * - readFailed: the dropzone again, with the read's message. A new pick reads again.
 * - reviewing: the review table. Save goes to saving.
 * - saving: the save is writing. It ends in done, or in saveFailed.
 * - saveFailed: the review stays open, with the save's message. Save retries.
 * - done: everything saved. `results` stays for the "Not saved" list.
 *
 * `run` names one read: its progress, result or failure lands only on its own
 * run, and a Cancel only on the run it was shown beside, even once that read
 * has finished. Discard returns any phase but saving to picking. Close does
 * so only from picking, readFailed and done; elsewhere it only hides the work.
 */
type PhaseState =
  | { phase: 'picking'; notices: FileNotice[]; cancelledRead?: { counts: RunCounts; notices: FileNotice[] } }
  | { phase: 'reading'; run: number; files: File[]; notices: FileNotice[]; counts: RunCounts; progress: Progress }
  | { phase: 'readFailed'; run: number; files: File[]; notices: FileNotice[]; message: string }
  | { phase: 'reviewing'; run: number; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome }
  | { phase: 'saving'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome }
  | { phase: 'saveFailed'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome; message: string }
  | { phase: 'done'; results: FileResult[]; notices: FileNotice[]; outcome: SaveOutcome };
/** `skipArchive`: the connect-first gate was skipped (US-12 AC4). View state
 *  beside the phase: a cancel keeps it; a close or discard that resets clears it. */
export type UploadState = PhaseState & { skipArchive: boolean };
export type UploadPhase = UploadState['phase'];

export type UploadEvent =
  | { type: 'picked'; run: number; files: File[]; notices: FileNotice[]; counts: RunCounts }
  | { type: 'listed'; run: number; picked: number }
  | { type: 'progress'; run: number; progress: Progress }
  | { type: 'readFailed'; run: number; message: string; notices: FileNotice[] }
  | { type: 'read'; run: number; results: FileResult[]; notices: FileNotice[] }
  | { type: 'cancel'; run: number }
  | { type: 'close' }
  | { type: 'discard' }
  | { type: 'skipConnect' }
  | { type: 'saveStarted' }
  | { type: 'saved'; attempt: SaveOutcome }
  | { type: 'saveFailed'; message: string; attempt?: SaveOutcome };

export const INITIAL_UPLOAD: UploadState = { phase: 'picking', notices: [], skipArchive: false };
const PREPARING: Progress = { current: 0, total: 100, fileName: 'Preparing upload...' };

/** The only way the flow changes. An event a phase does not take returns the
 *  same object, so React skips the render. */
export function transition(state: UploadState, event: UploadEvent): UploadState {
  const { skipArchive } = state;
  const ownRun = 'run' in state && 'run' in event && state.run === event.run;
  switch (event.type) {
    case 'picked':
      if (state.phase !== 'picking' && state.phase !== 'readFailed') return state;
      return event.files.length > 0
        ? { phase: 'reading', run: event.run, files: event.files, notices: event.notices, counts: event.counts, progress: PREPARING, skipArchive }
        : { phase: 'picking', notices: event.notices, skipArchive };
    case 'listed':
      return state.phase === 'reading' && ownRun ? { ...state, counts: { ...state.counts, picked: event.picked } } : state;
    case 'progress':
      return state.phase === 'reading' && ownRun ? { ...state, progress: event.progress } : state;
    case 'readFailed':
      return state.phase === 'reading' && ownRun
        ? { phase: 'readFailed', run: state.run, files: state.files, notices: event.notices, message: event.message, skipArchive }
        : state;
    case 'read':
      return state.phase === 'reading' && ownRun
        ? { phase: 'reviewing', run: state.run, results: event.results, notices: event.notices, outcome: NO_OUTCOME, skipArchive }
        : state;
    case 'cancel':
      if (!ownRun) return state;
      if (state.phase === 'reading') return { phase: 'picking', notices: [], cancelledRead: { counts: state.counts, notices: state.notices }, skipArchive };
      return state.phase === 'readFailed' || state.phase === 'reviewing' ? { ...INITIAL_UPLOAD, skipArchive } : state;
    case 'close':
      return state.phase === 'picking' || state.phase === 'readFailed' || state.phase === 'done' ? INITIAL_UPLOAD : state;
    case 'discard':
      return state.phase === 'saving' ? state : INITIAL_UPLOAD;
    case 'skipConnect':
      return skipArchive ? state : { ...state, skipArchive: true };
    case 'saveStarted':
      return state.phase === 'reviewing' || state.phase === 'saveFailed'
        ? { phase: 'saving', results: state.results, notices: state.notices, outcome: savedSoFar(state.outcome), skipArchive }
        : state;
    case 'saved':
      return state.phase === 'saving'
        ? { phase: 'done', results: state.results, notices: state.notices, outcome: withAttempt(state.outcome, event.attempt), skipArchive }
        : state;
    case 'saveFailed':
      return state.phase === 'saving'
        ? { ...state, phase: 'saveFailed', message: event.message, outcome: event.attempt ? withAttempt(state.outcome, event.attempt) : state.outcome }
        : state;
  }
}
