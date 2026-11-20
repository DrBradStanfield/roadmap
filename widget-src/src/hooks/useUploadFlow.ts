import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { checkLabImportQuota } from '../lib/upload-api';
import { initialUpload, inFlight, transition, type RunRefusal, type UploadEvent, type UploadFile, type UploadState } from '@roadmap/health-core/upload-flow';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import { uploadReview, type ScreeningProfile } from '@roadmap/health-core/upload-review';
import { uploadView } from '@roadmap/health-core/upload-view';
import { uploadUsageCounts } from '@roadmap/health-core/upload-usage';
import { UNDATED_PREVIOUS, uploadLimitSignal } from '@roadmap/health-core/lab-extraction';
import type { UnitSystem } from '@roadmap/health-core/units';
import { UPLOAD_OUTCOME_KEYS, UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import { getDocumentArchiveMode, uploadRecord } from '../lib/roadmap-data';
import { trackProductEvent, type ProductEventMetadata } from '../lib/server-api';
import type { LabImportResult, UploadHistory } from '../lib/api-types';
import { UploadError, hasValues, readResult, type FileNotice, type FileResult } from '../lib/upload-pipeline';
import { createUploadBundleLoader } from '../lib/upload-bundle';
import { Sentry } from '../lib/sentry';
import { recordFailure, WritesStoppedError } from '../lib/error-diagnostics';
import { isDocx, isZip } from '../lib/file-kinds';
import { runEffect, type UploadPort } from '../lib/upload-effects';
import { emptyHeld, fileNameOf, hasResults, MAX_FILES, NO_FILES_TEXT, phaseOf, pickedFiles, pickNotices, progressOf, readErrorOf, readOutcome, refusedForKey, type Held } from '../lib/upload-read';
import { saveAttempt } from '../lib/upload-save';
import { useStable } from '../lib/use-stable';
import { noticeText } from '../components/UploadNotices';
// Type only: a value import would pull the lazy upload bundle into the main one.
import type { HealthUploadAPI } from '../upload-entry';

/**
 * The upload flow (US-12): the shared upload state (health-core upload-flow.ts, one named state for
 * the web and the iPhone, US-12 AC26), changed only through its pure `transition`. This hook is the
 * web's adapter: it sends events, runs the effects the state asks for (lib/upload-effects.ts) and
 * the save (lib/upload-save.ts), and hands the modal the screen as health-core draws it (`uploadView`)
 * while files are still read. Every review choice is the state's (`chose`); no mode lives here: the
 * refs hold the state read synchronously, the web's bytes by file id, reads in flight to abort, one
 * run's preparation, and two once-per-run claims.
 */
export type { UploadPhase } from '../lib/upload-read';
export { MAX_FILES };

/** US-12 AC10: one run's counts, integers only. Never a name, unit or value.
 *  `docx` is how many of the picked files were .docx (AC13); `values` holds
 *  value counts: `undatedPrevious` from an undated previous column (AC14),
 *  `unitsGuessed` (AC16), `unitsRefused` (AC15), and the read files' limits
 *  (`uploadLimitSignal`, AC20): `valuesLimit`, `valuesLimitUngraded`, and the
 *  closed-list keys of the ungraded tests, the one non-count; `cancelled` a
 *  read Cancel stopped; `known`, `failedFinal` and `firstReadSeconds` from the
 *  shared state (upload-usage.ts, AC30). A zero is never sent, except a first
 *  read under a second (`firstReadSeconds: 0`, a real time): every key is
 *  optional, so a server a deploy behind meets a new key only once it counts something. */
function trackUploadOutcome(picked: number, withValues: number, docx: number, notices: FileNotice[], values: Partial<Record<UploadOutcomeKey, number>> = {}, limitUngradedTests: string[] = []): void {
  const counts: Partial<Record<UploadOutcomeKey, number>> = { picked, withValues, docx, ...values };
  for (const n of notices) counts[n.reason] = (counts[n.reason] ?? 0) + (n.count ?? 1);
  const sent = (k: UploadOutcomeKey) => counts[k] !== undefined && (counts[k]! > 0 || k === 'firstReadSeconds');
  trackProductEvent('upload_outcome', {
    ...Object.fromEntries(UPLOAD_OUTCOME_KEYS.filter(sent).map(k => [k, Math.min(counts[k]!, UPLOAD_OUTCOME_MAX)])),
    ...(limitUngradedTests.length ? { limitUngradedTests } : null),
  });
}

/** A run's counts once its reading ends (US-12 AC10). */
function countRun(s: UploadState, held: Held, results: FileResult[], notices: FileNotice[]): void {
  const read = results.filter(r => !r.error);
  const values = {
    undatedPrevious: read.reduce((n, r) => n + [...r.values, ...r.additionalValues].filter(v => v.recordedAt === UNDATED_PREVIOUS).length, 0),
    unitsGuessed: read.reduce((n, r) => n + r.values.filter(v => v.unitGuessed).length, 0),
    unitsRefused: read.reduce((n, r) => n + (r.refusedValues?.length ?? 0), 0),
  };
  const { limitUngradedTests, ...limits } = uploadLimitSignal(read);
  const picked = (s.phase === 'choosing' ? 0 : s.files.length) + held.leftOut;
  trackUploadOutcome(picked, read.filter(hasValues).length, held.docx, notices, { ...values, ...limits, ...uploadUsageCounts(s) }, limitUngradedTests);
}

/** A read file as the review's matrix takes it, built once per extraction, so its identity holds while other files are read. */
const RESULTS = new WeakMap<object, FileResult>();
function resultOf(f: UploadFile): FileResult | null {
  if (f.status.s !== 'read') return null;
  const x = f.status.extraction;
  let r = RESULTS.get(x);
  if (!r) RESULTS.set(x, r = readResult(fileNameOf(f), x as unknown as LabImportResult).result);
  return r;
}

export interface UploadFlowOptions {
  unitSystem: UnitSystem;
  /** The page's record as last shown: a re-read changes it, and the review is judged again. */
  history: UploadHistory;
  /** The page's re-read, after a Save lands (US-12 AC6). */
  onComplete: () => void | Promise<void>;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** The plan's age and sex: whom a letter's screening update is judged for (US-06 AC5). */
  screening: ScreeningProfile;
  /** The review's `upload_review` counts as they stand, read when a Save lands (US-13 AC13). */
  reviewCounts?: () => ProductEventMetadata;
}

export function useUploadFlow({ unitSystem, history, onComplete, onStart, onClose, screening, reviewCounts }: UploadFlowOptions) {
  const [upload, setUpload] = useState<UploadState>(() => initialUpload('web'));
  // The state read synchronously: a second pick or Save in the same render sees the first.
  const live = useRef(upload);
  // What the web holds beside the state: bytes, pages and the server's words, by file id; one per pick.
  const held = useRef<Held>(emptyHeld());
  // The run's quota check, draft flush and upload bundle: one promise per run, shared by its effects.
  const prepared = useRef<{ run: number; ready: Promise<HealthUploadAPI | null> } | null>(null);
  // The run whose review sent its `upload_review` (US-13 AC13), and the run whose reading was counted
  // (US-12 AC10): synchronous once-per-run claims, so a Try again never counts a run twice.
  const reviewEnded = useRef<number | null>(null);
  const runCounted = useRef<number | null>(null);
  /** Sends the review's counts once: on a finished Save, or on Cancel or close. */
  const endReview = useRef((counts: ProductEventMetadata | undefined) => {
    const s = live.current;
    if (!counts || reviewEnded.current === s.run || !hasResults(s)) return;
    reviewEnded.current = s.run;
    trackProductEvent('upload_review', counts);
  });
  // The connect-first gate was skipped (US-12 AC4): view state, kept by a cancel.
  const [skipArchive, setSkipArchive] = useState(false);
  const [loadUploadBundle] = useState(createUploadBundleLoader);
  const props = useRef({ unitSystem, onComplete, onStart, screening, reviewCounts });
  props.current = { unitSystem, onComplete, onStart, screening, reviewCounts };

  // The adapter: built once, it reads only refs, so a late effect never sees an old render.
  const port = useRef<UploadPort | null>(null);
  if (!port.current) {
    const send = (event: UploadEvent) => {
      const before = live.current;
      const step = transition(before, event);
      if (step.state === before) return;
      live.current = step.state;
      setUpload(step.state);
      const after = step.state;
      // A run's reading ended, or a pick of only files too large started none: counted once (US-12 AC10).
      if ((after.phase === 'open' || after.phase === 'failed') && inFlight(after) === 0 && (before.phase === 'choosing' || inFlight(before) > 0)) readEnded(after);
      for (const effect of step.effects) runEffect(port.current!, effect);
    };
    /** Counts the run; a run no file could open is reported, as before (US-12 AC3). */
    const readEnded = (s: UploadState) => {
      const h = held.current;
      if (refusedForKey(s) || runCounted.current === s.run) return; // the Pages build's missing key names and counts nothing
      runCounted.current = s.run;
      const { results, notices } = readOutcome(s, h);
      countRun(s, h, results, notices);
      if (readErrorOf(s) === NO_FILES_TEXT) {
        Sentry.captureException(recordFailure(new UploadError(NO_FILES_TEXT, 'no_files'), 'Upload processing failed'), { tags: { feature: 'upload', uploadErrorCode: 'no_files' } });
        trackProductEvent('upload_extract_failed');
      }
    };
    /** Ends a run before any read; the state names its files and says why (US-12 AC9, AC10). */
    const refuse = (run: number, reason: RunRefusal) => send({ type: 'runRefused', run, reason });
    /** Before a run reads anything: the daily quota, the page's draft flush, the upload bundle (US-12 AC5). */
    const begin = async (run: number): Promise<HealthUploadAPI | null> => {
      const current = () => live.current.run === run && live.current.phase === 'open';
      try {
        const quota = await checkLabImportQuota();
        if (!current()) return null;
        if (!quota.allowed) {
          // Only the daily limit names and counts the files; no key says its message alone.
          refuse(run, quota.reason === 'quota' ? 'dailyLimit' : 'noKey');
          return null;
        }
        await props.current.onStart?.();
        if (!current()) return null;
        const s = live.current;
        trackProductEvent('upload_started', { count: s.phase === 'open' ? s.files.filter(f => f.status.s !== 'refused').length : 0 });
        const bundle = await loadUploadBundle();
        return current() ? bundle : null;
      } catch (err) {
        if (current()) {
          console.error('Upload processing failed:', 'unknown');
          Sentry.captureException(recordFailure(err, 'Upload processing failed'), { tags: { feature: 'upload', uploadErrorCode: 'unknown' } });
          trackProductEvent('upload_extract_failed');
          refuse(run, 'server');
        }
        return null;
      }
    };
    /** The page reads back what the Save wrote; a re-read that fails is only reported: what saved stays saved. */
    const reread = () => {
      const report = (err: unknown) => { if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } }); };
      try { void Promise.resolve(props.current.onComplete()).catch(report); } catch (err) { report(err); }
    };
    port.current = {
      live: () => live.current,
      held: () => held.current,
      send,
      prepare: (run) => {
        if (prepared.current?.run !== run) prepared.current = { run, ready: begin(run) };
        return prepared.current.ready;
      },
      reads: new Map(),
      get unitSystem() { return props.current.unitSystem; },
      save: (run, attempt) => {
        const s = live.current;
        if (s.phase !== 'saving' || s.run !== run) return;
        void saveAttempt(s, held.current, getDocumentArchiveMode() === 'cloud', props.current.screening).then((answer) => {
          if ('message' in answer) return send({ type: 'saveFailed', run, attempt, message: answer.message });
          // One per review: a finished Save, never a failed one (US-13 AC13).
          // The review's counts as they stand when the Save lands (US-13 AC13).
          const counts = props.current.reviewCounts?.();
          endReview.current(counts && { ...counts, saved: 1 });
          send({ type: 'saved', run, attempt, outcome: answer.outcome });
          reread();
        });
      },
    };
  }
  const { send } = port.current;

  useEffect(() => () => { send({ type: 'discard' }); }, [send]);

  // A finished save, counted once, while the page still shows it (US-12 AC6, AC10): each done state is a new object.
  const done = upload.phase === 'done' ? upload : null;
  useEffect(() => {
    if (done) trackProductEvent('upload_saved', { count: done.outcome.values + done.outcome.documents });
  }, [done]);

  // The screen as health-core draws it, from the state and the record as the page last read it; null
  // before a pick opens. Results show as each file is read (US-12 AC26). `history` stands for the record:
  // a re-read changes it, and the review is judged again.
  const cloud = getDocumentArchiveMode() === 'cloud';
  const { age, sex } = screening;
  const shown = useMemo(() => {
    if (upload.phase === 'choosing' || upload.phase === 'consent' || upload.phase === 'failed') return null;
    const record = uploadRecord();
    const now = new Date().toISOString();
    const review = uploadReview(upload, record, now, { age, sex });
    return { review, view: uploadView(upload, record, now, review, cloud) };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `history` is the record's version as the page shows it
  }, [upload, history, age, sex, cloud]);

  // The read lab reports in the review's order (its `labFiles`), as the matrix takes them; the same
  // array while they are the same files, so a file read elsewhere never rebuilds the table.
  const files = upload.phase === 'choosing' ? [] : upload.files;
  const labs = useStable((shown?.review.labFiles ?? []).map(l => resultOf(files.find(f => f.id === l.fileId)!)!));

  // The files a run did not fully read (US-12 AC9).
  const pickHeld = held.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `files` and the pick's held data are what change them
  const notices = useMemo(() => readOutcome(upload, pickHeld).notices, [files, pickHeld]);
  // A failed file's own words, by file id, when the web has them (a .docx of pictures, a legacy .doc; US-12 AC9).
  const failedFiles = files.filter(f => f.status.s === 'failed');
  const failedNames = new Set(failedFiles.map(fileNameOf));
  const failedLine = (id: string) => {
    const f = failedFiles.find(x => x.id === id);
    const notice = f && notices.find(n => n.name === fileNameOf(f));
    return notice && notice.reason !== 'valuesDropped' ? noticeText({ ...notice, reason: notice.reason }) : null;
  };
  const phase = phaseOf(upload);

  // Cancel stops every read in flight and drops the run (US-12 AC28); a read it stopped is counted once (AC10).
  const cancel = useCallback(() => {
    const s = live.current;
    if (s.phase === 'open' && inFlight(s) > 0) {
      runCounted.current = s.run;
      trackUploadOutcome(s.files.length + held.current.leftOut, 0, held.current.docx, pickNotices(s, held.current), { cancelled: 1, ...uploadUsageCounts(s) });
    }
    send({ type: 'discard' });
  }, [send]);

  // Close hides the modal. A screen with nothing to lose resets; elsewhere the work goes on, hidden.
  const close = useCallback(() => {
    const shownPhase = phaseOf(live.current);
    if (shownPhase === 'picking' || shownPhase === 'readFailed' || shownPhase === 'done') {
      send({ type: 'close' });
      setSkipArchive(false);
    }
    onClose();
  }, [onClose, send]);

  const discard = useCallback(() => {
    if (live.current.phase === 'saving') return;
    send({ type: 'discard' });
    setSkipArchive(false);
    onClose();
  }, [onClose, send]);

  /** Files from the picker or a drop: a new run, on a screen that takes a pick. */
  const pick = (selectedFiles: FileList | null) => {
    const shownPhase = phaseOf(live.current);
    if (!selectedFiles?.length || (shownPhase !== 'picking' && shownPhase !== 'readFailed')) return;
    const fileArray = Array.from(selectedFiles).slice(0, MAX_FILES);
    send({ type: 'close' }); // a read-failed or too-large screen gives way to the new run
    held.current = { ...emptyHeld(live.current.run + 1), leftOut: selectedFiles.length - fileArray.length, docx: fileArray.filter(isDocx).length };
    fileArray.forEach((file, i) => held.current.files.set(`f${i}`, { file }));
    send({
      type: 'picked', needsConsent: false, now: new Date().toISOString(),
      // A .docx is itself a ZIP, and some browsers say so: it is read as a .docx.
      files: fileArray.map((f, i) => ({ id: `f${i}`, name: f.name, bytes: f.size, kind: !isDocx(f) && isZip(f) ? 'zip' : 'file' })),
    });
  };

  /** Stop (AC28): every read in flight aborted, nothing more sent, what was read stays in the review. */
  const stop = useCallback(() => send({ type: 'stop' }), [send]);
  /** Try again for one failed file, or every one a retry can mend (AC26). */
  const retry = useCallback((id: string | 'all') => send({ type: 'retry', id }), [send]);
  /** One review choice, kept by the state on its file (US-13 AC13). */
  const chose = useCallback((id: string, change: ChoiceChange) => send({ type: 'chose', id, change, now: new Date().toISOString() }), [send]);
  /** Save: the shared state starts it, and its effect runs it (lib/upload-save.ts). */
  const save = useCallback(() => send({ type: 'saveStarted' }), [send]);

  return {
    phase, state: upload, view: shown?.view ?? null, review: shown?.review ?? null, results: labs as FileResult[],
    files: phase === 'readFailed' ? pickedFiles(upload) : [], notices,
    // In the review a failed file is said once, in its own section, with Try again (US-12 AC26).
    reviewNotices: notices.filter(n => !failedNames.has(n.name)), failedLine, progress: progressOf(upload),
    readError: readErrorOf(upload),
    skipArchive, skipConnect: () => setSkipArchive(true),
    pick, cancel, close, discard, stop, retry, chose, save, endReview: endReview.current,
  };
}

export type UploadFlow = ReturnType<typeof useUploadFlow>;
