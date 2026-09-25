import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  calculateHealthResults,
  validateHealthInputs,
  getValidationErrors,
  convertValidationErrorsToUnits,
  detectUnitSystem,
  PREFILL_FIELDS,
  hasUnsavedProfileEdits,
  LONGITUDINAL_FIELDS,
  BLOOD_TEST_METRICS,
  FIELD_TO_METRIC,
  medicationsToInputs,
  mergeLongitudinalInputs,
  screeningsToInputs,
  buildMeasurementHistory,
  computeFormStage,
  FIELD_METRIC_MAP,
  METRIC_TO_FIELD,
  localDay,
  toCanonicalValue,
  VITALS_INPUT_FIELDS,
  type HealthInputs,
  type UnitSystem,
  type MetricType,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  type ProposedEdit,
  type ProposedFieldEdit,
  type ProposedMedicationEdit,
} from '@roadmap/health-core';
import type { BloodTestPrefillFn } from './BloodTestTimeline';
import { routeVitalsEdit, type VitalsPrefillFn } from './StartingInfoVitals';
import type { ApiSupplement, ApiLabValue } from '../lib/api-types';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
import { ChatSection, type ChatPrefetchData } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';
import { listConversations } from '../lib/chat-api';
import { UploadModal } from './UploadModal';
import { useIsMobile, useIsWideDesktop } from '../lib/useIsMobile';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { MobileTabBar, type TabId } from './MobileTabBar';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperType } from 'swiper';
import 'swiper/css';
import {
  saveToLocalStorage,
  clearLocalStorage,
  saveUnitPreference,
  loadUnitPreference,
  safeSetItem,
  safeRemoveItem,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  hasSavedRecord,
  getInitialInputsSync,
  loadAllHistory,
  loadLabValues,
  saveChangedMeasurements,
  addMeasurement,
  correctValue,
  saveMedication,
  saveScreening,
  saveSupplement,
  deleteSupplementApi,
  deleteUserData,
} from '../lib/roadmap-data';
import { trackABImpression, trackABConversion, trackProductEvent } from '../lib/server-api';
import { activeRowIndex, routeTasksToSaves, slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import type { ApiDocument } from '../lib/api-types';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { createRemoteChangeRelay } from '../lib/remote-replay';

// What "Delete all my data" does, said BEFORE the click. The caveats used to
// arrive in the alert afterwards, which is too late to be a decision, and
// "permanently delete" on its own was a promise the app cannot keep: copies it
// never touches sit in the user's own cloud folder.
export const ERASE_CONFIRM =
  'Delete all your data?\n\n' +
  'Your health record and your chat history are erased, on this device and in your cloud file. ' +
  'This cannot be undone.\n\n' +
  'Four things this cannot reach:\n' +
  '1. Documents you uploaded that are already in your cloud folder. They stay.\n' +
  '2. Candidate files from a connector import (imports/pending-*.json). They stay until your next import.\n' +
  '3. Your cloud provider keeps version history, and GitHub keeps every past commit.\n' +
  '4. Backups made by the command-line tool stay beside the file until that tool next writes it.\n\n' +
  'Reminders are turned off. The row on our server keeps your address for 90 days, so a later ' +
  'enrolment of that address does not send a second welcome email; anyone who enrols the address ' +
  'again restarts the schedule, and each email carries the off link. ' +
  'Cancelling from a Google sign-in deletes that row.';

const ERASE_DONE_TAIL =
  '\n\nStill in your cloud folder: the documents you uploaded, any pending import files, ' +
  'your provider\'s version history, and any command-line backups until that tool next writes the file. ' +
  'Delete those in your cloud account if you want them gone.';

export const ERASE_DONE = 'Your health record and chat history are deleted.' + ERASE_DONE_TAIL;

// The chat erase is best-effort (roadmap-data.ts): an unreachable cloud must
// never trap a user's data on their device. When it fails, the tombstones are
// already in the in-memory singleton, so the next recordExchange merges them
// through sync.save. Say that, rather than claiming a deletion that did not
// happen.
export const ERASE_DONE_CHAT_PENDING =
  'Your health record is deleted. Your chat history could not be reached just now; ' +
  'it is erased on your next chat.' + ERASE_DONE_TAIL;

/** A correction the store answered; a success is counted (name only). */
const countedCorrection: CorrectFn = async (id, newValue) => {
  const status = await correctValue(id, newValue);
  if (status === 'ok') trackProductEvent('correction_made');
  return status;
};

export function HealthTool({ syncControl, remindersSection }: { syncControl?: (ctx: { hasData: boolean }) => ReactNode; remindersSection?: ReactNode } = {}) {
  // The store is ready before render, so returning users see their saved prefill immediately.
  const [inputs, setInputs] = useState<Partial<HealthInputs>>(getInitialInputsSync);
  // What the matrices' drafts lend the plan and the chat, by field (US-03
  // AC6). It is kept apart from the form, which a re-read replaces, and only
  // handleDraftValue writes it, so each matrix knows what it lent.
  const [lent, setLent] = useState<Partial<HealthInputs>>({});
  const [previousMeasurements, setPreviousMeasurements] = useState<ApiMeasurement[]>([]);
  // Every active measurement, re-read after each save. The blood-test matrix
  // and the vitals matrix (StartingInfoVitals) each read their own metrics.
  const [history, setHistory] = useState<ApiMeasurement[]>([]);
  const bloodTestHistory = useMemo(() => history.filter(r => BLOOD_TEST_METRICS.includes(r.metricType)), [history]);
  const vitalsHistory = useMemo(
    () => history.filter(r => ['weight', 'waist', 'systolic_bp', 'diastolic_bp'].includes(r.metricType)),
    [history],
  );
  const [documentHistory, setDocumentHistory] = useState<ApiDocument[]>([]);
  const [labValueHistory, setLabValueHistory] = useState<ApiLabValue[]>([]);
  const [medications, setMedications] = useState<ApiMedication[]>([]);
  const [screenings, setScreenings] = useState<ApiScreening[]>([]);
  const [supplements, setSupplements] = useState<ApiSupplement[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasApiResponse, setHasApiResponse] = useState(false);
  // The relay is created once; the load path it calls changes identity on
  // most renders, so it is reached through a ref (US-34 AC4).
  const applyRemoteRef = useRef<() => void>(() => {});
  const remoteRelay = useRef(
    createRemoteChangeRelay(() => {
      trackProductEvent('remote_change_applied');
      void applyRemoteRef.current();
    }),
  ).current;

  // Filled by each matrix with its commit, so a lab upload commits both
  // drafts before its own save (US-03 AC5).
  const bloodTestFlushRef = useRef<(() => Promise<void>) | null>(null);
  const vitalsFlushRef = useRef<(() => Promise<void>) | null>(null);
  // Filled by BloodTestTimeline so the chatbot can inject a value into a
  // blood-test cell (highlighted, for the user to Save).
  const bloodTestPrefillRef = useRef<BloodTestPrefillFn | null>(null);
  // Filled by StartingInfoVitals ONLY when the vitals matrix is mounted
  // (returning users). Its presence is the routing signal: a chatbot vitals
  // edit flashes the matrix cell when set, else falls back to the plain field.
  const vitalsPrefillRef = useRef<VitalsPrefillFn | null>(null);
  const [isSavingLongitudinal, setIsSavingLongitudinal] = useState(false);
  // The saves in order, each after the last (see handleSaveLongitudinal).
  const savesRef = useRef<Promise<unknown>>(Promise.resolve());
  // Counts the first-time vitals fields' saves, so InputPanel closes the
  // fields a save emptied.
  const [fieldsSaved, setFieldsSaved] = useState(0);
  // The unit a first-time weight or waist was typed in, in its field or to
  // the chat, beside the value it gave: a unit switch before the save leaves
  // "changes nothing" asked in that unit (US-03 AC3). It holds only while
  // the form holds that value. The journey redesign deletes it: it rebuilds
  // these fields on the matrices' draft model.
  const typedIn = useRef<Partial<Record<keyof HealthInputs, { value: unknown; unit: UnitSystem }>>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const medSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const screeningSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isFirstSaveRef = useRef(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [floatingChatOpen, setFloatingChatOpen] = useState(false);
  const [chatPrefetch, setChatPrefetch] = useState<ChatPrefetchData | null>(null);

  // Clean up debounce timers on unmount to prevent stale API calls
  useEffect(() => {
    return () => {
      for (const timer of medSaveTimers.current.values()) clearTimeout(timer);
      for (const timer of screeningSaveTimers.current.values()) clearTimeout(timer);
    };
  }, []);
  // Unit system: load saved preference or auto-detect
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => {
    return loadUnitPreference() ?? detectUnitSystem();
  });

  // Per-field unit overrides (persisted to localStorage)
  const [unitOverrides, setUnitOverrides] = useState<Record<string, UnitSystem>>(() => {
    try {
      const stored = localStorage.getItem('health_roadmap_unit_overrides');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });

  // Track previously saved inputs to only save changed fields (demographics + height only)
  const previousInputsRef = useRef<Partial<HealthInputs>>({});

  // Get auth state once on mount

  // Load additional lab values on mount (AdditionalLabRows surfaces them
  // under the matrix — US-21 phase 1) and refresh when the upload modal
  // opens (review-matrix dedup/context columns). Was modal-open-only while
  // the review matrix was the sole consumer; the mount load was missing and
  // the lab-rows section rendered empty (caught by live WebKit verification
  // 2026-08-07). Generation counter discards stale overlapping responses.
  const labValuesFetchGen = useRef(0);
  const refreshLabValues = useCallback(() => {
    const myGen = ++labValuesFetchGen.current;
    return loadLabValues().then(rows => {
      // Skip null (API error) so we don't blank cached history.
      if (rows && myGen === labValuesFetchGen.current) setLabValueHistory(rows);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    refreshLabValues();
  }, [showUploadModal, refreshLabValues]);

  // Toggle a single field's unit override
  const handleToggleFieldUnit = useCallback((field: string) => {
    setUnitOverrides(prev => {
      const current = prev[field] ?? unitSystem;
      const toggled = current === 'si' ? 'conventional' : 'si';
      const next = { ...prev };
      if (toggled === unitSystem) {
        delete next[field];
      } else {
        next[field] = toggled;
      }
      safeSetItem('health_roadmap_unit_overrides', JSON.stringify(next));
      return next;
    });
  }, [unitSystem]);

  // Handle unit system change — save to localStorage and to inputs (for cloud sync)
  const handleUnitSystemChange = useCallback((system: UnitSystem) => {
    setUnitSystem(system);
    saveUnitPreference(system);
    setInputs(prev => ({ ...prev, unitSystem: system }));
    // Clear per-field overrides when global unit changes
    setUnitOverrides({});
    safeRemoveItem('health_roadmap_unit_overrides');
  }, []);

  const loadHistory = () => loadAllHistory().then(setHistory);

  // Re-read every value the page shows from the store: the plan's latest
  // values, both matrices, the lab rows and so the chat context. Every save
  // and correction ends here, so nothing reads a patched copy that could
  // disagree with the record. Hands back what it read.
  const reloadValues = useCallback(async () => {
    const result = await loadLatestMeasurements();
    if (result) {
      setPreviousMeasurements(result.previousMeasurements);
      // The storefront chat embed reads this mirror; keep it in step too.
      saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings);
    }
    await Promise.all([refreshLabValues(), loadHistory()]);
    return result;
  }, [refreshLabValues]);

  // Convert field-keyed overrides to MetricType-keyed for health-core + ResultsPanel
  const metricUnitOverrides = useMemo(() => {
    const m: Partial<Record<MetricType, UnitSystem>> = {};
    for (const [field, fieldUs] of Object.entries(unitOverrides)) {
      const metric = FIELD_METRIC_MAP[field];
      if (metric) m[metric] = fieldUs;
    }
    return Object.keys(m).length > 0 ? m : undefined;
  }, [unitOverrides]);

  // The RoadmapStore is authoritative. Never replay the retired v1 cache into it.
  useEffect(() => {
    async function loadData() {
      const result = await loadLatestMeasurements();

      if (hasSavedRecord(result)) {
        // Apply saved unit preference
        const unitPref = result.inputs.unitSystem;
        if (unitPref === 'si' || unitPref === 'conventional') {
          setUnitSystem(unitPref);
          saveUnitPreference(unitPref);
        }
        setInputs(result.inputs);
        previousInputsRef.current = { ...result.inputs };
        setPreviousMeasurements(result.previousMeasurements);
        if (result.previousMeasurements.length > 0) {
          isFirstSaveRef.current = false;
        }
        setMedications(result.medications);
        setScreenings(result.screenings);
        if (result.supplements) setSupplements(result.supplements);
        setDocumentHistory(result.documents);
        // Every measurement, for both matrices (fire-and-forget, so it
        // doesn't block the first render).
        loadHistory();
        // Keep the legacy mirror available to the separate storefront chat embed.
        saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings);
      }
      setHasApiResponse(true);
    }

    void loadData();
  }, []);

  // Fire A/B impression once on mount
  useEffect(() => { trackABImpression(); }, []);

  // Effective inputs for results calculation: form inputs, the drafts' lent
  // values over them, then a fallback to previousMeasurements, which the data
  // layer has already reduced to the newest active row per metric (US-07 AC4)
  // — so the first match here IS the latest.
  const effectiveInputs = useMemo(
    () => mergeLongitudinalInputs({ ...inputs, ...lent }, previousMeasurements),
    [inputs, lent, previousMeasurements],
  );

  // Progressive disclosure: compute which stage of the form to show.
  // Override to stage 3 if user has saved blood test data (e.g. from lab import).
  const formStage = useMemo(() => {
    const stage = computeFormStage(effectiveInputs);
    if (stage < 3 && previousMeasurements.some(m => BLOOD_TEST_METRICS.includes(m.metricType))) {
      return 3 as const;
    }
    return stage;
  }, [effectiveInputs, previousMeasurements]);

  // Pre-fetch chat conversations in background when chat becomes visible (stage 3)
  // So messages are ready instantly when the user clicks the chat bubble
  useEffect(() => {
    if (formStage < 3 || chatPrefetch) return;
    listConversations().then((result) => {
      if (!result) return;
      setChatPrefetch({
        conversations: result.conversations,
        messages: [],
        activeConversationId: null,
      });
    });
  }, [formStage, chatPrefetch]);

  // Save any unsaved profile/demographic fields (height, sex, birthYear, birthMonth, unitSystem).
  // Returns true if saved or nothing to save; false on failure.
  async function flushPendingProfileSave(): Promise<boolean> {
    const autoSaveFields = [...PREFILL_FIELDS, 'unitSystem' as keyof HealthInputs];
    const currentPrefill: Partial<HealthInputs> = {};
    const previousPrefill: Partial<HealthInputs> = {};
    for (const field of autoSaveFields) {
      if (inputs[field] !== undefined) (currentPrefill as any)[field] = inputs[field];
      if (previousInputsRef.current[field] !== undefined) (previousPrefill as any)[field] = previousInputsRef.current[field];
    }

    const hasChanges = autoSaveFields.some(f => inputs[f] !== previousInputsRef.current[f]);
    if (!hasChanges) return true;

    const success = await saveChangedMeasurements(currentPrefill, previousPrefill);
    if (success) {
      for (const field of autoSaveFields) {
        (previousInputsRef.current as any)[field] = inputs[field];
      }
      // The form is clean again — apply any remote change held back while it
      // was dirty (US-34 AC4).
      remoteRelay.saved();
    }
    return success;
  }

  // Auto-save demographics + height only (debounced)
  useEffect(() => {
    if (!hasApiResponse) return;

    const timeout = setTimeout(async () => {
      // Check if there are unsaved profile changes before showing status
      const autoSaveFields = [...PREFILL_FIELDS, 'unitSystem' as keyof HealthInputs];
      const hasChanges = autoSaveFields.some(f => inputs[f] !== previousInputsRef.current[f]);
      if (!hasChanges) return;

      await flushPendingProfileSave();
    }, 500);

    return () => clearTimeout(timeout);
  }, [inputs, hasApiResponse]);

  // The saved-value editor's correction, core or lab (US-04, US-21 AC5),
  // then the page re-reads the record.
  const handleCorrectValue = useCallback<CorrectFn>(async (id, newValue) => {
    const status = await countedCorrection(id, newValue);
    if (status === 'ok') await reloadValues();
    return status;
  }, [reloadValues]);

  // Save typed values by the one routing rule (matrix-save.ts), against the
  // store's own rows, then re-read the record. The matrices pass their cells;
  // with none, it saves the first-time vitals fields under today. Saves run
  // one after another, so two asked for at once (a press on Save as PDF
  // leaves a matrix, and saves the fields) both land. Resolves with what was
  // refused, slot by slot, so the caller keeps only that.
  const handleSaveLongitudinal = useCallback((tasks?: SaveTask[]): Promise<Refused> => {
    // The first-time vitals fields: a weight, a waist, a blood pressure, each
    // naming the row the page shows for today ("Replaces 82 kg"), in the unit
    // it was typed in (mmHg either way). What a matrix's draft lends the plan
    // is kept apart (`lent`), and only that matrix saves it, on the day the
    // draft is dated (review of 2026-09-24). So what `inputs` holds here was
    // typed into these fields, by the user or the chat.
    const fromForm = (): SaveTask[] => {
      const date = localDay(new Date());
      const shown = activeRowIndex(history);
      return [['weight'], ['waist'], ['systolic_bp', 'diastolic_bp']].flatMap((metrics): SaveTask[] => {
        const field = METRIC_TO_FIELD[metrics[0]];
        const typed = typedIn.current[field];
        const unit = typed && typed.value === inputs[field] ? typed.unit : unitOverrides[field] ?? unitSystem;
        const task: SaveTask = { date, values: {}, expected: {}, unit };
        for (const metric of metrics) {
          const value = inputs[METRIC_TO_FIELD[metric]] as number | undefined;
          if (value === undefined) continue;
          task.values[metric] = value;
          task.expected[metric] = shown.get(slotOf(date, metric))?.id ?? null;
        }
        return Object.keys(task.values).length > 0 ? [task] : [];
      });
    };

    const save = async (): Promise<Refused> => {
      // Keep the profile and saved measurements consistent across the debounce.
      await flushPendingProfileSave();
      const toSave = tasks ?? fromForm();
      if (toSave.length === 0) return new Map();

      setIsSavingLongitudinal(true);
      try {
        const refused = await routeTasksToSaves(
          toSave,
          await loadAllHistory(), // the store's rows, as it writes: never the page's copy
          async (date, metric, value) => {
            const { status } = await addMeasurement(metric, value, ensureIsoDatetime(date));
            return status === 'inserted' ? 'ok' : status === 'duplicate' ? 'changed' : 'error';
          },
          countedCorrection,
        );
        await reloadValues();

        // What was saved leaves the form, in one update. A copy left in
        // `inputs` outranked the saved row in the plan and the chat, and the
        // next save of the fields wrote it again, under today (2026-09-24).
        // A number typed there while the save ran is not what was saved, and
        // stays for the next save (US-03 AC3).
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
        if (!tasks) setFieldsSaved(n => n + 1);

        // Track A/B conversion on the first measurement save.
        if (refused.size === 0) {
          if (isFirstSaveRef.current) trackABConversion();
          isFirstSaveRef.current = false;
        }
        return refused;
      } finally {
        setIsSavingLongitudinal(false);
      }
    };
    const run = savesRef.current.then(save);
    savesRef.current = run.catch(() => {});
    return run;
  }, [inputs, history, unitOverrides, unitSystem, reloadValues]);

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
  const scheduleLongitudinalSave = useCallback(() => {
    longitudinalDebounce.schedule(() => { void handleSaveLongitudinalRef.current(); });
  }, [longitudinalDebounce]);
  const flushLongitudinalSave = useCallback(() => {
    longitudinalDebounce.commit(() => { void handleSaveLongitudinalRef.current(); });
  }, [longitudinalDebounce]);

  // Tab-close safety net for the first-time vitals fields: a field the user
  // left has its save waiting (500 ms); it runs before the page unloads. A
  // matrix's draft stays on the device instead (US-03 AC5).
  useEffect(() => {
    const onUnload = () => longitudinalDebounce.flush();
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [longitudinalDebounce]);

  // A lab upload starts: both matrices commit their drafts, then the fields
  // save (US-03 AC5), before any file is read.
  const handleUploadStart = useCallback(async () => {
    for (const commit of [bloodTestFlushRef.current, vitalsFlushRef.current]) {
      try { await commit?.(); }
      catch { /* best-effort: the next save still runs */ }
    }
    await handleSaveLongitudinal();
  }, [handleSaveLongitudinal]);

  // Refresh state after upload bulk save (lab values + documents): the values,
  // lab rows and both matrices, then the profile and the rest.
  const handleUploadComplete = useCallback(async () => {
    // A field the user left has its save waiting (500 ms): it lands first.
    longitudinalDebounce.flush();
    const result = await reloadValues();
    if (result) {
      // The record holds the profile and every saved value. A first-time
      // field's value gets none of a draft's checks: it names the row it
      // replaces only as it saves (still open), and nothing stops it standing
      // in once another writer fills its slot. Carried through a re-read, it
      // would outrank that writer's value in the plan, then correct it. So
      // only the field the user is typing in rides through, since losing
      // keystrokes is worse (US-34 AC4). The journey redesign moves these
      // fields onto the draft model. What the matrices' drafts lend is kept
      // apart (`lent`): it rides through, and each draft is judged again
      // against the record read (US-03 AC6).
      const typing = document.activeElement?.id as keyof HealthInputs | undefined;
      setInputs(prev => (typing && LONGITUDINAL_FIELDS.includes(typing) && prev[typing] !== undefined
        ? { ...result.inputs, [typing]: prev[typing] }
        : result.inputs));
      previousInputsRef.current = { ...result.inputs };
      setMedications(result.medications);
      setScreenings(result.screenings);
      setDocumentHistory(result.documents);
    }
  }, [reloadValues, longitudinalDebounce]);

  // Something wrote to the record under us — another device, or an AI
  // connector through MCP (US-34). The store has already re-read and merged;
  // re-run the same load path an upload finishes with, so the page shows the
  // new profile and values without a reload. The listener reads the form
  // through a ref, never a stale closure.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  useEffect(() => {
    applyRemoteRef.current = handleUploadComplete;
    // Not while the user is mid-typing: the load path replaces the form's
    // inputs, and a remote change landing on a half-entered height would take
    // those keystrokes with it. The relay HOLDS it — the next profile save
    // carries the edit up and then replays the change.
    const onRemoteChange = () =>
      remoteRelay.arrived(hasUnsavedProfileEdits(inputsRef.current, previousInputsRef.current));
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
  }, [remoteRelay, handleUploadComplete]);

  // Calculate results using effective inputs (form + fallback to previous)
  const { results, isValid, validationErrors } = useMemo(() => {
    if (!effectiveInputs.heightCm || !effectiveInputs.sex) {
      return { results: null, isValid: false, validationErrors: null };
    }

    const validation = validateHealthInputs(effectiveInputs);

    let inputsForCalc = effectiveInputs;
    let errors: Record<string, string> | null = null;

    if (!validation.success && validation.errors) {
      const rawErrors = getValidationErrors(validation.errors);
      // Convert error messages to user's unit system (e.g., "20 kg" → "44 lbs")
      errors = convertValidationErrorsToUnits(rawErrors, unitSystem);
      // Strip invalid fields (all optional) so remaining suggestions still show
      const invalidFields = new Set(validation.errors.issues.map((i) => i.path[0] as string));
      if (invalidFields.has('heightCm') || invalidFields.has('sex')) {
        return { results: null, isValid: false, validationErrors: errors };
      }
      const sanitized = { ...effectiveInputs };
      for (const field of invalidFields) {
        (sanitized as Record<string, unknown>)[field] = undefined;
      }
      inputsForCalc = sanitized;
    }

    const healthResults = calculateHealthResults(
      inputsForCalc as HealthInputs,
      unitSystem,
      medicationsToInputs(medications),
      screeningsToInputs(screenings),
      metricUnitOverrides,
    );
    return { results: healthResults, isValid: true, validationErrors: errors };
  }, [effectiveInputs, unitSystem, medications, screenings, metricUnitOverrides]);

  useEffect(() => {
    setErrors(validationErrors ?? {});
  }, [validationErrors]);

  // Active suggestion IDs for cascade trigger logic
  const activeSuggestionIds = useMemo(() =>
    new Set(results?.suggestions?.map(s => s.id) ?? []),
    [results?.suggestions],
  );

  // Mobile tab state
  const isMobile = useIsMobile();
  const isWideDesktop = useIsWideDesktop(1200);
  const [activeTab, setActiveTab] = useState<TabId>('input');



  // Swiper ref for programmatic slide control (tab button clicks)
  const swiperRef = useRef<SwiperType | null>(null);
  // The Swiper renders only under isMobile: a viewport crossing the
  // breakpoint destroys it while the ref still points at it, and
  // updateAutoHeight on a destroyed instance throws inside the commit
  // (US-20 AC2). Every call goes through here; the test counts direct reads.
  const liveSwiper = () => (swiperRef.current && !swiperRef.current.destroyed ? swiperRef.current : null);

  // Sync tab button clicks → Swiper
  useEffect(() => {
    const index = activeTab === 'input' ? 0 : activeTab === 'plan' ? 1 : 2;
    const swiper = liveSwiper();
    if (swiper && swiper.activeIndex !== index) swiper.slideTo(index);
  }, [activeTab]);

  // Re-measure Swiper autoHeight when slide content changes
  useEffect(() => {
    liveSwiper()?.updateAutoHeight();
  }, [formStage, supplements, documentHistory]);

  const handleDeleteData = useCallback(async () => {
    const confirmed = window.confirm(ERASE_CONFIRM);
    if (!confirmed) return;

    setIsDeleting(true);
    const result = await deleteUserData();
    setIsDeleting(false);

    if (result.success) {
      clearLocalStorage();
      setInputs({});
      setPreviousMeasurements([]);
      setHistory([]);
      setMedications([]);
      setScreenings([]);
      previousInputsRef.current = {};
      window.alert(result.chatErased ? ERASE_DONE : ERASE_DONE_CHAT_PENDING);
    } else {
      window.alert(result.error || 'Failed to delete data. Please try again.');
    }
  }, []);

  // One field's new value, from the form or the chat. A weight or waist
  // keeps the unit its caller converted it from (typedIn). One update per
  // field, so several made at once all land (US-16 AC1).
  const handleInputChange = useCallback(<K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem) => {
    if (unit) typedIn.current[field] = { value, unit };
    setInputs(prev => ({ ...prev, [field]: value }));
    window.dispatchEvent(new CustomEvent('hr:inputs-changed'));
  }, []);
  // A matrix's draft value, as the plan and the chat read it (US-03 AC6);
  // undefined leaves the field to the record. One update per field, so
  // several sent at once all land.
  const handleDraftValue = useCallback((field: keyof HealthInputs, value: number | undefined) => setLent(prev => {
    const next = { ...prev, [field]: value };
    if (value === undefined) delete next[field];
    return next;
  }), []);

  const handleMedicationChange = useCallback((
    medicationKey: string,
    drugName: string,
    doseValue: number | null,
    doseUnit: string | null,
  ) => {
    // Update local state immediately
    setMedications(prev => {
      const idx = prev.findIndex(m => m.medicationKey === medicationKey);
      const updated: ApiMedication = {
        id: idx >= 0 ? prev[idx].id : '',
        medicationKey,
        drugName,
        doseValue,
        doseUnit,
        updatedAt: new Date().toISOString(),
      };
      const next = idx >= 0 ? [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)] : [...prev, updated];

      // Cache to localStorage
      saveToLocalStorage(inputs, previousMeasurements, next, screenings);

      return next;
    });

    // Debounce cloud save per medication_key to prevent race conditions
    // when rapid dropdown changes fire multiple concurrent API calls
    const existing = medSaveTimers.current.get(medicationKey);
    if (existing) clearTimeout(existing);
    medSaveTimers.current.set(medicationKey, setTimeout(() => {
      medSaveTimers.current.delete(medicationKey);
      saveMedication(medicationKey, drugName, doseValue, doseUnit);
    }, 300));
  }, [inputs, previousMeasurements, screenings]);

  const handleScreeningChange = useCallback((screeningKey: string, value: string) => {
    setScreenings(prev => {
      const idx = prev.findIndex(s => s.screeningKey === screeningKey);
      const updated: ApiScreening = {
        id: idx >= 0 ? prev[idx].id : '',
        screeningKey,
        value,
        updatedAt: new Date().toISOString(),
      };
      const next = idx >= 0 ? [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)] : [...prev, updated];

      saveToLocalStorage(inputs, previousMeasurements, medications, next);

      return next;
    });

    const existing = screeningSaveTimers.current.get(screeningKey);
    if (existing) clearTimeout(existing);
    screeningSaveTimers.current.set(screeningKey, setTimeout(() => {
      screeningSaveTimers.current.delete(screeningKey);
      saveScreening(screeningKey, value);
    }, 300));
  }, [inputs, previousMeasurements, medications]);

  const supSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of supSaveTimers.current.values()) clearTimeout(t); }, []);

  const handleSupplementChange = useCallback((
    supplementKey: string,
    supplementName: string,
    doseValue: number | null,
    doseUnit: string | null,
    status: string = 'active',
    startedAt?: string,
  ) => {
    setSupplements(prev => {
      const idx = prev.findIndex(s => s.supplementKey === supplementKey);
      const updated: ApiSupplement = {
        id: idx >= 0 ? prev[idx].id : '',
        supplementKey,
        supplementName,
        doseValue,
        doseUnit,
        status,
        startedAt: startedAt ?? (idx >= 0 ? prev[idx].startedAt : null) ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return idx >= 0 ? [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)] : [...prev, updated];
    });

    const existing = supSaveTimers.current.get(supplementKey);
    if (existing) clearTimeout(existing);
    supSaveTimers.current.set(supplementKey, setTimeout(() => {
      supSaveTimers.current.delete(supplementKey);
      saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt);
    }, 300));
  }, []);

  const handleSupplementDelete = useCallback((supplementKey: string) => {
    setSupplements(prev => prev.filter(s => s.supplementKey !== supplementKey));
    deleteSupplementApi(supplementKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Chatbot-driven form edits (the chat proposes; this routes to the real form)
  // ---------------------------------------------------------------------------
  // A one-shot undo for a medication change the chat just applied (meds
  // auto-save, so the chat states the change + offers Undo).
  const [medUndo, setMedUndo] = useState<
    | { key: string; drugName: string; doseValue: number | null; doseUnit: string | null }
    | null
  >(null);
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const applyFieldEdit = useCallback((edit: ProposedFieldEdit) => {
    const metric = FIELD_TO_METRIC[edit.field] as MetricType | undefined;
    if (!metric) return;
    // Vitals (weight/waist/BP). When the vitals MATRIX is mounted (returning
    // users), route into its draft/backfill cell so it pre-fills AND flashes —
    // exactly like the blood-test matrix. The matrix only registers its prefill
    // ref while mounted, so a non-null ref is the "matrix is shown" signal.
    // Fresh users (legacy plain fields, ref null) fall back to setting the form
    // input directly — no flash, unchanged behaviour.
    if (VITALS_INPUT_FIELDS.includes(edit.field)) {
      if (routeVitalsEdit(!!vitalsPrefillRef.current) === 'matrix') {
        vitalsPrefillRef.current!(metric, edit.displayValue, edit.unitSystem, edit.date);
      } else {
        handleInputChange(edit.field, toCanonicalValue(metric, edit.displayValue, edit.unitSystem), edit.unitSystem);
      }
      return;
    }
    // Blood-test metrics → the timeline matrix's draft/backfill cell.
    bloodTestPrefillRef.current?.(metric, edit.displayValue, edit.unitSystem, edit.date);
  }, [handleInputChange]);

  const applyMedicationEdit = useCallback((edit: ProposedMedicationEdit) => {
    // Snapshot the prior value FIRST so Undo can restore it.
    const prior = medicationsRef.current.find(m => m.medicationKey === edit.medicationKey);
    setMedUndo({
      key: edit.medicationKey,
      drugName: prior?.drugName ?? 'none',
      doseValue: prior?.doseValue ?? null,
      doseUnit: prior?.doseUnit ?? null,
    });
    handleMedicationChange(edit.medicationKey, edit.drugName, edit.doseValue, edit.doseUnit);
  }, [handleMedicationChange]);

  const handleProposeEdit = useCallback((edits: ProposedEdit[]) => {
    let hasFieldEdit = false;
    for (const edit of edits) {
      if (edit.kind === 'field') { applyFieldEdit(edit); hasFieldEdit = true; }
      else applyMedicationEdit(edit);
    }
    // Mobile hand-off: bring the user to the form so they SEE the pre-filled
    // cell + Save button (they were on the chat tab). Mirror handleAutoFocusEmail.
    if (hasFieldEdit && isMobileRef.current) {
      setActiveTab('input');
      liveSwiper()?.slideTo(0);
    }
  }, [applyFieldEdit, applyMedicationEdit]);

  const undoMedEdit = useCallback(() => {
    if (!medUndo) return;
    handleMedicationChange(medUndo.key, medUndo.drugName, medUndo.doseValue, medUndo.doseUnit);
    setMedUndo(null);
  }, [medUndo, handleMedicationChange]);

  // Email capture and US-23 reminder enrolment require the Shopify server.
  const emailCaptureActive = SHOPIFY_SURFACE;

  const handleAutoFocusEmail = useCallback(() => {
    if (!emailCaptureActive) return;
    if (isMobile) {
      setActiveTab('plan');
      setTimeout(() => document.getElementById('guestEmail')?.focus(), 400);
    } else {
      document.getElementById('guestEmail')?.focus();
    }
  }, [emailCaptureActive, isMobile]);

  // Memoised so the UploadModal's matrix doesn't rebuild on unrelated
  // HealthTool re-renders (typing, mobile-tab switches, etc.).
  const uploadHistory = useMemo(
    () => ({ bloodTests: bloodTestHistory, labValues: labValueHistory, documents: documentHistory }),
    [bloodTestHistory, labValueHistory, documentHistory],
  );

  const inputPanelProps = {
    inputs,
    effectiveInputs,
    onChange: handleInputChange,
    errors,
    unitSystem,
    onUnitSystemChange: handleUnitSystemChange,
    unitOverrides,
    onToggleFieldUnit: handleToggleFieldUnit,
    previousMeasurements,
    bloodTestHistory,
    vitalsHistory,
    labValues: labValueHistory,
    // Refresh additional lab rows after a manual addition (US-21).
    onLabValueAdded: refreshLabValues,
    onSaveBloodTestBatch: handleSaveLongitudinal,
    onCorrectValue: handleCorrectValue,
    onDraftValue: handleDraftValue,
    medications,
    onMedicationChange: handleMedicationChange,
    screenings,
    onScreeningChange: handleScreeningChange,
    supplements,
    onSupplementChange: handleSupplementChange,
    onSupplementDelete: handleSupplementDelete,
    scheduleLongitudinalSave,
    flushLongitudinalSave,
    isSavingLongitudinal,
    fieldsSaved,
    hasApiResponse,
    bloodTestFlushRef,
    vitalsFlushRef,
    bloodTestPrefillRef,
    vitalsPrefillRef,
    formStage,
    setShowUploadModal,
    activeSuggestionIds,
    healthDocuments: documentHistory,
    onDocumentDeleted: (docId: string) => {
      setDocumentHistory(prev => prev.filter(d => d.id !== docId));
    },
    onAutoFocusEmail: handleAutoFocusEmail,
  };

  const resultsPanelProps = {
    results,
    syncControl,
    remindersSection,
    isValid,
    unitSystem,
    unitOverrides: metricUnitOverrides,
    hasUnsavedLongitudinal: hasApiResponse && LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined),
    onSaveLongitudinal: handleSaveLongitudinal,
    onDeleteData: handleDeleteData,
    isDeleting,
    sex: inputs.sex,
    showEmailCapture: emailCaptureActive,
    formStage,
  };

  // Dated blood-test + vitals time series for the chat context (local-first
  // only — see chatSectionProps). Keyed by metricType, chronological, SI values,
  // capped at HISTORY_CAP_PER_METRIC points/metric to bound the prompt.
  const chatMeasurementHistory = useMemo(() => {
    const out = buildMeasurementHistory([...bloodTestHistory, ...vitalsHistory]);
    return Object.keys(out).length > 0 ? out : undefined;
  }, [bloodTestHistory, vitalsHistory]);

  const chatSectionProps = {
    isLoggedIn: true,
    // The server has no health record to read. Send the current plan and dated
    // history as context; chat-api independently owns the guest session identity.
    guestInputs: { ...effectiveInputs, unitSystem, medications, screenings, ...(chatMeasurementHistory ? { measurementHistory: chatMeasurementHistory } : {}) },
    prefetchedData: chatPrefetch,
    onProposeEdit: handleProposeEdit,
  };

  // Bottom clearance only while the fixed "See Your Personalized Plan" bar is
  // actually rendered (same condition as the button below) — an unconditional
  // padding would leave a blank strip on the plan/chat tabs and stage 1.
  const planBarVisible = isMobile && formStage >= 2 && activeTab === 'input';
  return (
    <div className={`health-tool${planBarVisible ? ' health-tool--plan-bar' : ''}`} data-clarity-mask="true">
      {isMobile ? (
        <>
          <MobileTabBar activeTab={activeTab} onTabChange={setActiveTab} />
          <Swiper
            autoHeight
            touchStartPreventDefault={false}
            noSwiping
            noSwipingSelector=".bt-cell-strip, .bt-timeline-scroll"
            onSwiper={(s) => { swiperRef.current = s; }}
            onSlideChange={(s) => {
              const tabs: TabId[] = ['input', 'plan', 'chat'];
              setActiveTab(tabs[s.activeIndex] ?? 'input');
            }}
          >
            <SwiperSlide>
              <InputPanel {...inputPanelProps} />
            </SwiperSlide>
            <SwiperSlide>
              <div className="health-tool-right">
                <ResultsPanel {...resultsPanelProps} />
              </div>
            </SwiperSlide>
            <SwiperSlide>
              <div className="health-tool-chat">
                <ChatEmbed
                  isLoggedIn={chatSectionProps.isLoggedIn}
                  guestInputs={chatSectionProps.guestInputs}
                  muted={formStage < 3}
                  onProposeEdit={handleProposeEdit}
                />
              </div>
            </SwiperSlide>
          </Swiper>
          {formStage >= 2 && activeTab === 'input' && (
            <button
              className="btn-primary mobile-view-plan-btn"
              onClick={() => setActiveTab('plan')}
            >
              See Your Personalized Plan
            </button>
          )}
        </>
      ) : (
        <div className="health-tool-content">
          <div className="health-tool-left">
            <InputPanel {...inputPanelProps} />
          </div>
          <div className="health-tool-right">
            <ResultsPanel {...resultsPanelProps} />
          </div>
          {isWideDesktop && (
            <div className="health-tool-chat">
              <ChatEmbed
                isLoggedIn={chatSectionProps.isLoggedIn}
                guestInputs={chatSectionProps.guestInputs}
                muted={formStage < 3}
                onProposeEdit={handleProposeEdit}
              />
            </div>
          )}
        </div>
      )}

      <UploadModal
        open={showUploadModal}
        onOpen={() => setShowUploadModal(true)}
        unitSystem={unitSystem}
        metricUnitOverrides={metricUnitOverrides}
        onToggleFieldUnit={handleToggleFieldUnit}
        history={uploadHistory}
        onComplete={handleUploadComplete}
        onStart={handleUploadStart}
        onClose={() => setShowUploadModal(false)}
        onScreeningUpdate={handleScreeningChange}
        birthYear={inputs.birthYear ? Number(inputs.birthYear) : undefined}
        sex={inputs.sex === 'male' || inputs.sex === 'female' ? inputs.sex : undefined}
      />

      {/* Undo banner for a medication the chat just changed (meds auto-save, so
          the chat applies + states the change and offers an explicit Undo). */}
      {medUndo && createPortal(
        <div className="chat-med-undo no-print" role="status">
          <span className="chat-med-undo-text">Medication updated from chat.</span>
          <button type="button" className="chat-med-undo-btn" onClick={undoMedEdit}>Undo</button>
          <button
            type="button"
            className="chat-med-undo-dismiss"
            aria-label="Dismiss"
            onClick={() => setMedUndo(null)}
          >✕</button>
        </div>,
        document.body,
      )}

      {/* Floating chat FAB + expanded panel — portaled to body so their
          position: fixed doesn't resolve against the transform'd .health-tool. */}
      {!isMobile && formStage >= 3 && !floatingChatOpen && createPortal(
        <button
          className="chat-fab no-print"
          onClick={() => setFloatingChatOpen(true)}
          aria-label="Open chat"
        >
          <span className="chat-fab-icon">💬</span>
          <span className="chat-fab-label">Ask about your health</span>
        </button>,
        document.body,
      )}
      {!isMobile && floatingChatOpen && createPortal(
        <ChatSection
          startExpanded
          onClose={() => setFloatingChatOpen(false)}
          {...chatSectionProps}
        />,
        document.body,
      )}
    </div>
  );
}
