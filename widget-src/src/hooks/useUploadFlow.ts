import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { checkLabImportQuota } from '../lib/upload-api';
import { initialUpload, inFlight, transition, type RunRefusal, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import type { ReviewedValue } from '@roadmap/health-core/upload-review';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { uploadUsageCounts } from '@roadmap/health-core/upload-usage';
import { UNDATED_PREVIOUS, uploadLimitSignal } from '@roadmap/health-core/lab-extraction';
import type { UnitSystem } from '@roadmap/health-core/units';
import type { UploadReader } from '@roadmap/health-core/upload-rules';
import { UPLOAD_OUTCOME_KEYS, UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { trackProductEvent, type ProductEventMetadata } from '../lib/server-api';
import { UploadError, hasValues, type FileNotice, type FileResult } from '../lib/upload-pipeline';
import { createUploadBundleLoader } from '../lib/upload-bundle';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';
import { isDocx, isZip } from '../lib/file-kinds';
import { runEffect, type UploadPort } from '../lib/upload-effects';
import { emptyHeld, hasResults, heldNotices, MAX_FILES, NO_FILES_TEXT, phaseOf, pickedFiles, pickNotices, progressOf, readErrorOf, readOutcome, refusedForKey, type Held } from '../lib/upload-read';
import { sharedSave } from '../lib/upload-shared-save';
import { getShownErase } from '../lib/roadmap-data';
import { SAVE_FAILED, type UploadEngine } from '../storage/upload-save-store';
// Type only: a value import would pull the lazy upload bundle into the main one.
import type { HealthUploadAPI } from '../upload-entry';

/**
 * The upload flow (US-12): the shared upload state (health-core upload-flow.ts, one named state for
 * the web and the iPhone, US-12 AC26), changed only through its pure `transition`. This hook is the
 * web's adapter: it sends events, runs the effects the state asks for (lib/upload-effects.ts) and
 * the shared Save (lib/upload-shared-save.ts), and reads the picking screens from the state
 * (lib/upload-read.ts); the list draws the rest from the engine (UploadReviewList.tsx). No mode
 * lives here: the refs hold the state read synchronously, the web's bytes by file id, reads in
 * flight to abort, one run's preparation, and the counts the pending Save sends once it lands.
 */
export type { UploadPhase } from '../lib/upload-read';
export { MAX_FILES };

const NO_READ = { results: [] as FileResult[], notices: [] as FileNotice[] };

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

export interface UploadFlowOptions {
  unitSystem: UnitSystem;
  /** The page's re-read, run after a Save's commit landed: the commit wrote any screening date (US-13 AC6). */
  onComplete: () => void | Promise<void>;
  onStart?: () => Promise<void>;
  onClose: () => void;
  /** The plan's age and sex, for a letter's screening box (US-13 AC6): the list's page and the Save read the same. */
  person?: ScreeningPerson;
}

export function useUploadFlow({ unitSystem, onComplete, onStart, onClose, person }: UploadFlowOptions) {
  // The Shopify build's files are read by our server; the Pages build's by the person's own key (US-12 AC9).
  const reader: UploadReader = SHOPIFY_SURFACE ? 'server' : 'ownKey';
  const [upload, setUpload] = useState<UploadState>(() => initialUpload('web', reader));
  // The state read synchronously: a second pick or Save in the same render sees the first.
  const live = useRef(upload);
  // What the web holds beside the state: bytes, pages and the server's words, by file id; one per pick.
  const held = useRef<Held>(emptyHeld());
  // The run's quota check, draft flush and upload bundle: one promise per run, shared by its effects.
  const prepared = useRef<{ run: number; ready: Promise<HealthUploadAPI | null> } | null>(null);
  // The `upload_review` counts the pending Save sends once its commit lands (US-13 AC13).
  const reviewCounts = useRef<ProductEventMetadata | undefined>(undefined);
  // The run whose review sent its `upload_review` (US-13 AC13): one per review, a synchronous claim.
  const reviewEnded = useRef<number | null>(null);
  // The run that sent its `upload_outcome` (US-12 AC10): one per run, a synchronous claim. True when this call claims it.
  const outcomeSent = useRef<number | null>(null);
  const claimOutcome = (run: number) => {
    if (outcomeSent.current === run) return false;
    outcomeSent.current = run;
    return true;
  };
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
  // The shared engine once the upload bundle loaded: the list's review and the Save run the same code (owner ruling 4).
  const [engine, setEngine] = useState<UploadEngine | null>(() => window.HealthUpload ?? null);
  const props = useRef({ unitSystem, onComplete, onStart, person });
  props.current = { unitSystem, onComplete, onStart, person };

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
      if (refusedForKey(s)) return; // the Pages build's missing key names and counts nothing
      // One per run, at its first settlement (AC10: "when it reaches review or fails"): Try again keeps the run's number.
      if (!claimOutcome(s.run)) return;
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
        setEngine(bundle);
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
        if (s.phase !== 'saving' || s.run !== run || s.attempt !== attempt) return;
        const { onComplete: complete, person: shown } = props.current;
        const counts = reviewCounts.current;
        const failed = { type: 'saveFailed' as const, run, attempt, message: SAVE_FAILED };
        // The web's Save always carries the erase read at its press (`save` below): one without is refused, never
        // written under another erase (US-16 AC2a).
        void loadUploadBundle()
          .then((upload) => (s.erase === undefined ? failed : sharedSave(upload, { ...s, erase: s.erase }, held.current, shown, complete)), () => failed)
          .then((event) => {
            // One per review: a finished Save, never a failed one (US-13 AC13).
            if (event.type === 'saved') endReview.current(counts);
            send(event);
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

  // The picking screens' notices, read from the state; the list draws the rest from the engine.
  const files = upload.phase === 'choosing' ? null : upload.files;
  const pickHeld = held.current;
  // Nothing shows them while files are read, so they are built once reading ends. The pick's held
  // data changes only together with `files` (each effect sends its event after writing it).
  const reading = inFlight(upload) > 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `files` and the pick's held data are what change them
  const { notices } = useMemo(() => (reading ? NO_READ : readOutcome(upload, pickHeld)), [files, pickHeld, reading]);
  const phase = phaseOf(upload);

  // Cancel stops every read in flight and drops the run (US-12 AC28); a read it stopped is counted once (AC10).
  const cancel = useCallback(() => {
    const s = live.current;
    if (s.phase === 'open' && inFlight(s) > 0 && claimOutcome(s.run)) {
      trackUploadOutcome(s.files.length + held.current.leftOut, 0, held.current.docx, pickNotices(s, held.current), { cancelled: 1, ...uploadUsageCounts(s) });
    }
    send({ type: 'discard' });
  }, [send]);

  // Close hides the modal. A screen with nothing to lose resets; elsewhere the work goes on, hidden.
  const close = useCallback(() => {
    const shown = phaseOf(live.current);
    if (shown === 'picking' || shown === 'readFailed' || shown === 'done') {
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
    const shown = phaseOf(live.current);
    if (!selectedFiles?.length || (shown !== 'picking' && shown !== 'readFailed')) return;
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

  /** Save: what the page the person reviewed would write (`reviewedWrites`), and the `upload_review` counts it sends once its commit lands. */
  const save = useCallback((reviewed: ReviewedValue[], counts: ProductEventMetadata) => {
    const s = live.current;
    if (s.phase !== 'open' && s.phase !== 'saveFailed') return;
    reviewCounts.current = counts;
    // The erase the page shows at this press: the Save writes under it, whatever lands while it runs (US-16 AC2a).
    send({ type: 'saveStarted', reviewed, erase: getShownErase() });
  }, [send]);

  return {
    phase, files: phase === 'readFailed' ? pickedFiles(upload) : [], notices, progress: progressOf(upload),
    // What only the web knows of the pick, said beside the list: the shared state never saw it (US-12 AC9, AC13).
    heldNotices: heldNotices(upload, pickHeld),
    readError: readErrorOf(upload), reader,
    skipArchive, skipConnect: () => setSkipArchive(true),
    pick, cancel, close, discard, save, endReview: endReview.current,
    // The list's adapter: `send` sets `live.current` before it returns, so a read right after a choice holds it.
    upload, send, live, engine,
  };
}
