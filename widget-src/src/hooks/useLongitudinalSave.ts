// The longitudinal save (US-03, US-06 AC15): what the first-time vitals
// fields and the PSA hold, and what a matrix passes, saved by the one routing
// rule (matrix-save.ts), one save after another, then the record re-read.
// The fields save 500 ms after they are left (scheduleLongitudinalSave), or at
// once (flushLongitudinalSave); a departure stages the waiting save at once
// (stagePendingSave). HealthTool owns the form; this owns the queue.
import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import { METRIC_TO_FIELD, type ApiMeasurement } from '@roadmap/health-core/mappings';
import { inputRangeFault } from '@roadmap/health-core/validation';
import { localDay } from '@roadmap/health-core/merge';
import type { UnitSystem } from '@roadmap/health-core/units';
import { activeRowIndex, routeTasksToSaves, slotOf, type Refused, type SaveTask } from '../lib/matrix-save';
import { addMeasurement, correctValue, getBackendKind, getShownErase, loadAllHistorySync } from '../lib/roadmap-data';
import { healthWritesAllowed } from '../lib/storage';
import { trackABConversion, trackProductEvent } from '../lib/server-api';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { useDebouncedSave } from '../lib/useDebouncedSave';

/** A correction the store answered; a success is counted (name only). */
export const countedCorrection = async (id: string, newValue: number, erase?: string) => {
  const status = await correctValue(id, newValue, erase);
  if (status === 'ok') trackProductEvent('correction_made');
  return status;
};

interface LongitudinalSaveDeps {
  inputs: Partial<HealthInputs>;
  setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>;
  history: ApiMeasurement[];
  unitOverrides: Record<string, UnitSystem>;
  unitSystem: UnitSystem;
  reread: () => Promise<unknown>;
  flushPendingProfileSave: (erase?: string) => Promise<boolean>;
  /** The unit each first-time weight or waist was typed in (US-03 AC3). */
  typedIn: MutableRefObject<Partial<Record<keyof HealthInputs, { value: unknown; unit: UnitSystem }>>>;
  /** The record held no measurement as the page loaded: read once (US-01 AC7). */
  firstSave: boolean;
}

export function useLongitudinalSave({
  inputs, setInputs, history, unitOverrides, unitSystem, reread,
  flushPendingProfileSave, typedIn, firstSave,
}: LongitudinalSaveDeps) {
  // The measurement-save conversion is sent once per page load (US-01 AC7).
  const isFirstSaveRef = useRef(firstSave);
  // How many saves are running: "Saving…" holds until the last one ends (US-03 AC9).
  // A departure's save runs beside a queued one, so a single flag ended early.
  const [savesRunning, setSavesRunning] = useState(0);
  const isSavingLongitudinal = savesRunning > 0;
  // The saves in order, each after the last (see handleSaveLongitudinal).
  const savesRef = useRef<Promise<unknown>>(Promise.resolve());
  // Counts the first-time vitals fields' saves, so InputPanel closes the
  // fields a save emptied.
  const [fieldsSaved, setFieldsSaved] = useState(0);
  // The prostate section's PSA day (YYYY-MM-DD); null until one is picked, so today (US-06 AC15).
  const [psaDate, setPsaDate] = useState<string | null>(null);
  // The PSA row was committed since its last save (US-06 AC15).
  const psaCommittedRef = useRef(false);

  // Save typed values by the one routing rule (matrix-save.ts), against the
  // store's own rows, then re-read the record. The matrices pass their cells;
  // with none, it saves the first-time vitals fields under today. Saves run
  // one after another, so two asked for at once (a press on Save as PDF
  // leaves a matrix, and saves the fields) both land. Resolves with what was
  // refused, slot by slot, so the caller keeps only that.
  // `erase`: as asked for, not as the queued save runs (US-16 AC2a).
  // `now`: the page is leaving or hiding, so the writes are staged before this
  // returns, ahead of the caller's synchronous flush; the re-read follows if
  // the page stays (US-06 AC15).
  const handleSaveLongitudinal = useCallback((tasks?: SaveTask[], erase = getShownErase(), now = false): Promise<Refused> => {
    // The first-time vitals fields: a weight, a waist, a blood pressure, each
    // naming the row the page shows for today ("Replaces 82 kg"), in the unit
    // it was typed in (mmHg either way). What a matrix's draft lends the plan
    // is kept apart (`lent`), and only that matrix saves it, on the day the
    // draft is dated (review of 2026-09-24). So what `inputs` holds here was
    // typed into these fields, by the user or the chat. The prostate section's
    // PSA takes the day picked beside it, or today until one is picked; a day
    // after today (or none) saves no PSA, and the field says so (US-06 AC15).
    const fromForm = (): SaveTask[] => {
      const today = localDay(new Date());
      const shown = activeRowIndex(history);
      // A PSA saves only once its row is committed (left, ticked, Enter, or
      // departure), so another field's save never takes it under a day not
      // yet chosen (US-06 AC15).
      const psaCommitted = psaCommittedRef.current;
      psaCommittedRef.current = false;
      return [['weight'], ['waist'], ['systolic_bp', 'diastolic_bp'], ['psa']].flatMap((metrics): SaveTask[] => {
        if (metrics[0] === 'psa' && !psaCommitted) return [];
        const date = metrics[0] === 'psa' ? psaDate ?? today : today;
        if (!date || date > today) return [];
        const field = METRIC_TO_FIELD[metrics[0]];
        const typed = typedIn.current[field];
        const unit = typed && typed.value === inputs[field] ? typed.unit : unitOverrides[field] ?? unitSystem;
        const task: SaveTask = { date, values: {}, expected: {}, unit };
        for (const metric of metrics) {
          const value = inputs[METRIC_TO_FIELD[metric]] as number | undefined;
          // US-02 AC5: a value out of range stays in its field, its error shown,
          // and is never sent (the record's slot rule has no range check, D4b).
          if (value === undefined || inputRangeFault(METRIC_TO_FIELD[metric], value)) continue;
          task.values[metric] = value;
          task.expected[metric] = shown.get(slotOf(date, metric))?.id ?? null;
        }
        return Object.keys(task.values).length > 0 ? [task] : [];
      });
    };

    // The store is synchronous, so every write is staged before this returns;
    // only the answers wait.
    const write = (toSave: SaveTask[]) => routeTasksToSaves(
      toSave,
      loadAllHistorySync(), // the store's rows, as it writes: never the page's copy
      async (date, metric, value) => {
        const { status } = await addMeasurement(metric, value, ensureIsoDatetime(date), erase);
        return status === 'inserted' ? 'ok' : status === 'duplicate' ? 'changed' : status;
      },
      (id, newValue) => countedCorrection(id, newValue, erase),
    );

    const finish = async (toSave: SaveTask[], staged: Promise<Refused>): Promise<Refused> => {
      setSavesRunning(n => n + 1);
      try {
        const refused = await staged;
        await reread();

        // What the fields saved leaves the form, in one update. A copy left in
        // `inputs` outranked the saved row in the plan and the chat, and the
        // next save of the fields wrote it again, under today (2026-09-24).
        // A number typed there while the save ran is not what was saved, and
        // stays for the next save (US-03 AC3). A matrix's save leaves the form
        // alone: its values were never in it, and a field's value equal to
        // one it saved, for another day, is not what it saved.
        if (!tasks) {
          setInputs(prev => {
            const next = { ...prev };
            for (const t of toSave) {
              for (const [metric, value] of Object.entries(t.values)) {
                const field = METRIC_TO_FIELD[metric];
                if (!refused.has(slotOf(t.date, metric)) && next[field] === value) delete next[field];
              }
            }
            return next;
          });
          // A saved PSA puts its date box back to today, so it never reads "Replaces" the value just saved.
          if (toSave.some(t => t.values.psa !== undefined && !refused.has(slotOf(t.date, 'psa')))) setPsaDate(null);
          setFieldsSaved(n => n + 1);
        }

        // Track A/B conversion on the first measurement save.
        if (refused.size === 0) {
          if (isFirstSaveRef.current) trackABConversion();
          isFirstSaveRef.current = false;
        }
        return refused;
      } finally {
        setSavesRunning(n => n - 1);
      }
    };
    if (now) {
      if (getBackendKind() === 'local' && !healthWritesAllowed()) return Promise.resolve(new Map());
      const toSave = tasks ?? fromForm();
      return toSave.length ? finish(toSave, write(toSave)) : Promise.resolve(new Map());
    }
    const save = async (): Promise<Refused> => {
      // Keep the profile and saved measurements consistent across the debounce.
      await flushPendingProfileSave(erase);
      const toSave = tasks ?? fromForm();
      return toSave.length ? finish(toSave, write(toSave)) : new Map();
    };
    const run = savesRef.current.then(save);
    savesRef.current = run.catch(() => {});
    return run;
    // setInputs and the refs are stable; flushPendingProfileSave is read from the render that last rebuilt this, as before the move.
  }, [inputs, history, unitOverrides, unitSystem, psaDate, reread]);

  // Auto-save on blur / Enter for InputPanel longitudinal fields. The
  // 500ms debounce batches systolic→diastolic tab transitions into one
  // save; Enter flushes immediately.
  //
  // The ref mirror is load-bearing: the debounced closure must read the
  // latest `handleSaveLongitudinal` at fire-time, not at schedule-time.
  // Without it, systolic blur captures `inputs={sys:118}`, the save runs,
  // CLEARS inputs.systolicBp, then diastolic blur captures already-cleared
  // inputs and saves only diastolic — two POSTs instead of one batched.
  const handleSaveLongitudinalRef = useRef(handleSaveLongitudinal);
  handleSaveLongitudinalRef.current = handleSaveLongitudinal;
  const longitudinalDebounce = useDebouncedSave(500);
  // The fields' save waiting on the timer, and the erase it was asked under:
  // departure stages it at once (US-06 AC15).
  const pendingSaveRef = useRef<{ erase: string | undefined } | null>(null);
  const scheduleLongitudinalSave = useCallback(() => {
    const erase = getShownErase(); // as the field was left, not as the timer fires
    pendingSaveRef.current = { erase };
    longitudinalDebounce.schedule(() => { pendingSaveRef.current = null; void handleSaveLongitudinalRef.current(undefined, erase); });
  }, [longitudinalDebounce]);
  const flushLongitudinalSave = useCallback(() => {
    pendingSaveRef.current = null;
    longitudinalDebounce.commit(() => { void handleSaveLongitudinalRef.current(); });
  }, [longitudinalDebounce]);
  // The PSA row is committed (US-06 AC15): left, or at once on its tick or Enter.
  const commitPsa = useCallback((now: boolean) => {
    psaCommittedRef.current = true;
    if (now) flushLongitudinalSave(); else scheduleLongitudinalSave();
  }, [flushLongitudinalSave, scheduleLongitudinalSave]);

  /** The page is going: the fields' waiting save is written at once, with the erase it was asked under. */
  const stagePendingSave = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    longitudinalDebounce.cancel();
    void handleSaveLongitudinalRef.current(undefined, pending.erase, true);
  }, [longitudinalDebounce]);

  /** An erase: the fields' waiting save was asked of the old record, so it goes, timer and all (US-03 AC9). */
  const cancelPendingSave = useCallback(() => {
    pendingSaveRef.current = null;
    longitudinalDebounce.cancel();
  }, [longitudinalDebounce]);
  /** A save the page needs landed now (an upload's re-read): the waiting one runs at once. */
  const flushPendingSave = useCallback(() => longitudinalDebounce.flush(), [longitudinalDebounce]);

  return {
    handleSaveLongitudinal, scheduleLongitudinalSave, flushLongitudinalSave, commitPsa, stagePendingSave,
    cancelPendingSave, flushPendingSave, isSavingLongitudinal, fieldsSaved, psaDate, setPsaDate,
  };
}
