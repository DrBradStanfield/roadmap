import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { calculateHealthResults, knownMinorOf } from '@roadmap/health-core/calculations';
import { unreadableNote } from '@roadmap/health-core/readable-rows';
import { medicinesShown, weightMedicationTrigger, lipidMarkerFor } from '@roadmap/health-core/suggestions';
import { validateHealthInputs, getValidationErrors, convertValidationErrorsToUnits, birthRefusedMessage, inputRangeFault } from '@roadmap/health-core/validation';
import { planInputsFrom, withLabEgfr, labEgfrOf } from '@roadmap/health-core/plan';
import { type SuggestionInputs, type AlcoholAnswer, type HealthInputs, isSex } from '@roadmap/health-core/types';
import { detectUnitSystem, type UnitSystem, type MetricType } from '@roadmap/health-core/units';
import { PREFILL_FIELDS, hasUnsavedProfileEdits, LONGITUDINAL_FIELDS, medicationsToInputs, mergeLongitudinalInputs, screeningsToInputs, computeFormStage, opensFullForm, FIELD_METRIC_MAP, METRIC_TO_FIELD, withPsaMeasurement, type FormStage, type RecordHoldings } from '@roadmap/health-core/mappings';
import { chatContextOf, type ChatContextPayload } from '@roadmap/health-core/chat-context';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { medicationForm, screeningForm } from '@roadmap/health-core/input-form';
import { localDay, dayOf } from '@roadmap/health-core/merge';
import { newestUsablePsa } from '@roadmap/health-core/measurement-history';
import type { BloodTestPrefillFn } from './BloodTestTimeline';
import type { MoveTestApi } from './MoveTestPanel';
import type { VitalsPrefillFn } from './StartingInfoVitals';
import type { LatestMeasurementsResult } from '../lib/api-types';
import { InputPanel, type PlanBasis } from './InputPanel';
import { OpenEvidenceContext, usePlanView } from './ResultsPanel';
import { PersonButton } from './SettingsSheet';
import { MyHealth, type FormSlots } from './MyHealth';
import { revealAndFocus, stickyTop } from '../lib/reveal';
import { CHAT_BUBBLES } from './icons';
import { ChatSection, type ChatPrefetchData } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';
import { listConversations } from '../lib/chat-api';
import { UploadModal } from './UploadModal';
import { useIsMobile, useIsWideDesktop } from '../lib/useIsMobile';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { ensureIsoDatetime } from '../lib/recordedAt';
import { BottomTabBar, panelDomId, tabDomId, type TabId } from './BottomTabBar';
import { ONBOARDING_STEPS } from '@roadmap/health-core/product-events';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  patchMirror,
  clearLocalStorage,
  saveUnitPreference,
  loadUnitPreference,
  safeSetItem,
  safeRemoveItem,
  getJson,
  localHealthWritesStopped,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  hasSavedRecord,
  getInitialInputsSync,
  getEraseIdentity,
  getShownErase,
  markEraseShown,
  clearOffFileAfterErase,
  flushRoadmapStoreSync,
  loadLatestMeasurementsSync,
  loadAllHistory,
  loadAllHistorySync,
  loadLabValues,
  loadDerivedSeries,
  saveChangedMeasurements,
  addMeasurement,
  correctValue,
  moveBloodTest,
  previewMove,
  saveMedication,
  saveScreening,
  saveSupplement,
  deleteSupplementApi,
  deleteUserData,
  getBackendKind,
  getUnreadableCount,
} from '../lib/roadmap-data';
import { trackABImpression, trackABConversion, trackProductEvent } from '../lib/server-api';
import { observeVisibility } from '../lib/observe-visibility';
import { activeRowIndex, routeTasksToSaves, slotOf, type CorrectFn, type Refused, type SaveTask } from '../lib/matrix-save';
import type { Grading } from '../lib/blood-test-cell';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { createRemoteChangeRelay } from '../lib/remote-replay';
import { debounceSave, cancelListSave, flushListSaves, type ListSaves } from '../lib/list-saves';
import { useRecordState } from '../hooks/useRecordState';
import { useChatEdits } from './ChatEdits';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING, ERASE_DONE_CHAT_UNREAD, ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';

/** A correction the store answered; a success is counted (name only). */
const countedCorrection = async (id: string, newValue: number, erase?: string) => {
  const status = await correctValue(id, newValue, erase);
  if (status === 'ok') trackProductEvent('correction_made');
  return status;
};

/** After a medication or screening save, failed or not, the chat copy takes
 *  the lists the store holds (US-15 AC10). Never the form's: a failed save
 *  would leave a row the record lacks, and a re-read inside the debounce
 *  would put the old list back with nothing to undo it. */
async function mirrorSavedLists(): Promise<void> {
  const result = await loadLatestMeasurements();
  if (result) patchMirror({ medications: result.medications, screenings: result.screenings });
}

/** This device's per-field unit toggles: the entries whose unit is 'si' or
 *  'conventional'. A stored value that is not a plain object reads as none,
 *  so a hand edit or an old build's junk never breaks the page (US-05 AC6). */
function loadUnitOverrides(): Record<string, UnitSystem> {
  const stored = getJson<unknown>('health_roadmap_unit_overrides');
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([, us]) => us === 'si' || us === 'conventional'));
}

/**
 * US-62 AC13: the highest onboarding stage reached on the record the screen
 * shows (`reached`), the stage that record opened at (`opened`), and a count
 * of the records shown (`epoch`). `reached` only rises, so nothing unlocked
 * goes away while an answer is retyped; `fullForm` latches the same way.
 * An erase (the screen moving to another erase identity) starts all again.
 */
function useReachedStage(stage: FormStage, holdings: RecordHoldings): { reached: FormStage; opened: FormStage; epoch: number; fullForm: boolean } {
  const ref = useRef<{ erase: string; reached: FormStage; opened: FormStage; epoch: number; fullForm: boolean } | null>(null);
  const erase = getShownErase();
  const was = ref.current;
  if (!was || was.erase !== erase) ref.current = { erase, reached: stage, opened: stage, epoch: (was?.epoch ?? 0) + 1, fullForm: false };
  else if (stage > was.reached) was.reached = stage;
  const now = ref.current!;
  // The whole form, once open on this record, stays open until an erase
  // (a deleted document that opened it does not close it).
  now.fullForm ||= opensFullForm(now.reached, holdings);
  const { reached, opened, epoch, fullForm } = now;
  return { reached, opened, epoch, fullForm };
}

/** The same rows, value for value: a re-read that changed nothing keeps the old array. */
/** The onboarding's answers (US-62 AC13): only an edit to one of them counts as a step. */
const ONBOARDING_FIELDS: ReadonlyArray<keyof HealthInputs> = ['heightCm', 'weightKg', 'sex', 'birthMonth', 'birthYear'];
/** US-62 AC31: this browser has pressed "Your plan is ready."'s Got it. A UI flag only, never in the record. */
const PLAN_READY_SEEN_KEY = 'hr_plan_ready_seen';
const planReadySeen = (): boolean => { try { return localStorage.getItem(PLAN_READY_SEEN_KEY) === '1'; } catch { return false; } };

/** The chat list fetched ahead of time, and the record (`epoch`) it was listed for. */
type ChatPrefetch = { epoch: number; data: ChatPrefetchData };
/** That list, only for the record shown: an erase starts it again (US-11 AC2g). */
const prefetchFor = (prefetch: ChatPrefetch | null, epoch: number): ChatPrefetchData | null =>
  (prefetch?.epoch === epoch ? prefetch.data : null);

export function HealthTool({ syncControl, remindersSection, storageBar, saveAlert, syncAlert }: {
  syncControl?: (ctx: { hasData: boolean; attention: boolean }) => ReactNode;
  remindersSection?: ReactNode;
  /** US-09 AC30: the Sign in button, in the input column's header. */
  storageBar?: ReactNode;
  /** On a phone, where the storage button is in the Account tab (US-62 AC34): US-01 AC5's
   *  "Could not save on this device" atop My health and Chat, and a reconnect or waiting save atop My health. */
  saveAlert?: ReactNode;
  syncAlert?: ReactNode;
} = {}) {
  // The store is ready before render, so returning users see their saved prefill immediately.
  const [inputs, setInputs] = useState<Partial<HealthInputs>>(getInitialInputsSync);
  // What the matrices' drafts lend the plan and the chat, by field (US-03
  // AC6). It is kept apart from the form, which a re-read replaces, and only
  // handleDraftValue writes it, so each matrix knows what it lent.
  const [lent, setLent] = useState<Partial<HealthInputs>>({});
  // The day each lent value is dated, when its draft has one (US-07 AC7).
  const [lentDays, setLentDays] = useState<Partial<Record<keyof HealthInputs, string>>>({});
  // The record, read once at mount, so a returning user resumes at their step
  // with no flash of step 1 (US-62 AC13); the first load reuses it.
  const mountRead = useRef<{ erase: string; result: LatestMeasurementsResult | null } | null | undefined>(undefined);
  if (mountRead.current === undefined) mountRead.current = { erase: getEraseIdentity(), result: loadLatestMeasurementsSync() };
  // The screen's copy of the record: replaced by a re-read, emptied by an erase (hooks/useRecordState).
  const {
    previousMeasurements, history, bloodTestHistory, vitalsHistory, documentHistory, labValueHistory, medications, screenings, supplements,
    setPreviousMeasurements, setHistory, setLabValueHistory,
    applyLists, clearForErase, patchMedication, patchScreening, patchSupplement, stopSupplement, dropDocument,
  } = useRecordState(() => mountRead.current?.result?.previousMeasurements ?? []);
  // The prostate section's PSA day (YYYY-MM-DD); null until one is picked, so today (US-06 AC15).
  const [psaDate, setPsaDate] = useState<string | null>(null);
  // The PSA row was committed since its last save (US-06 AC15).
  const psaCommittedRef = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // US-54 AC5b: the birth month a save refused, in words, until the next birth edit.
  const [birthRefused, setBirthRefused] = useState<string | null>(null);
  const [hasApiResponse, setHasApiResponse] = useState(false);
  // The relay is created once; the load path it calls changes identity on
  // most renders, so it is reached through a ref (US-34 AC4).
  const applyRemoteRef = useRef<() => void>(() => {});
  const remoteRelay = useRef(
    createRemoteChangeRelay(() => {
      answeredHere.current = false; // another writer's change is no answer given here (US-62 AC13)
      trackProductEvent('remote_change_applied', { backend: getBackendKind() });
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
  const medSaveTimers = useRef<ListSaves>(new Map());
  const screeningSaveTimers = useRef<ListSaves>(new Map());
  const isFirstSaveRef = useRef(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [floatingChatOpen, setFloatingChatOpen] = useState(false);
  const [chatPrefetch, setChatPrefetch] = useState<ChatPrefetch | null>(null);

  // Clean up debounce timers on unmount to prevent stale API calls
  useEffect(() => {
    return () => {
      for (const { timer } of medSaveTimers.current.values()) clearTimeout(timer);
      for (const { timer } of screeningSaveTimers.current.values()) clearTimeout(timer);
    };
  }, []);
  // Unit system: load saved preference or auto-detect
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => {
    return loadUnitPreference() ?? detectUnitSystem();
  });

  // Per-field unit overrides (persisted to localStorage)
  const [unitOverrides, setUnitOverrides] = useState(loadUnitOverrides);

  // Track previously saved inputs to only save changed fields (demographics + height only)
  const previousInputsRef = useRef<Partial<HealthInputs>>({});

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
      if (rows && myGen === labValuesFetchGen.current) {
        setLabValueHistory(rows);
        // A lab eGFR added by hand reaches the other chats too (US-07 AC7).
        const labEgfr = labEgfrOf(rows);
        const cached = loadFromLocalStorage();
        if (cached && JSON.stringify(cached.labEgfr) !== JSON.stringify(labEgfr)) patchMirror({ labEgfr });
      }
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
      saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, undefined, labEgfrOf(await loadLabValues() ?? []),
        newestUsablePsa(loadAllHistorySync(), new Date()));
    }
    await Promise.all([refreshLabValues(), loadHistory()]);
    return result;
  }, [refreshLabValues]);

  // Convert field-keyed overrides to MetricType-keyed for health-core + ResultsPanel.
  // Lp(a) has its own three-unit control (US-05 AC2): an old build's two-way
  // toggle for it is read there alone, and drives no other display.
  const metricUnitOverrides = useMemo(() => {
    const m: Partial<Record<MetricType, UnitSystem>> = {};
    for (const [field, fieldUs] of Object.entries(unitOverrides)) {
      const metric = FIELD_METRIC_MAP[field];
      if (metric && metric !== 'lpa') m[metric] = fieldUs;
    }
    return Object.keys(m).length > 0 ? m : undefined;
  }, [unitOverrides]);

  // The erase the screen shows, marked on the store, which refuses every
  // write while it holds another (US-16 AC2a). The chat's banners (a profile
  // proposal, a medication Undo) go when the screen moves to another erase,
  // this tab's or another device's, even with post-erase rows. A re-read that
  // brings no erase keeps them.
  // The same erase as React state: the upload modal is keyed on it, so an
  // erase ends a review read before it (US-16 AC2c).
  const [shownErase, setShownErase] = useState(getShownErase);
  const showErase = useCallback((erase: string) => {
    if (erase === getShownErase()) return;
    markEraseShown(erase);
    setShownErase(erase);
    clearChatEdits();
  }, []);
  // The store holds an erase the screen does not show yet: this tab's erase
  // still writing or failed to write, or another device's erase whose re-read
  // has not landed (the relay never holds an erase, US-11 AC6). The screen's
  // values are pre-erase then, so no banner is made or answered.
  const eraseUnshown = useCallback(() => getEraseIdentity() !== getShownErase(), []);
  // True while this tab's erase runs.
  const erasingRef = useRef(false);
  const refusedFor = useRef(''); // the erase whose refusal was last said
  // A save the store refused. Outside this tab's own erase, which throws the
  // change away anyway, say so and show the record the store holds; that also
  // releases a remote change the relay held behind the edit (US-34 AC4).
  const writeRefused = useCallback(() => {
    // One alert per erase, however many saves it refuses (adversary R5).
    if (erasingRef.current || refusedFor.current === getEraseIdentity()) return;
    refusedFor.current = getEraseIdentity();
    window.alert(WRITE_REFUSED);
    answeredHere.current = false; // the record re-read is not an answer given here (US-62 AC13)
    void applyRemoteRef.current();
  }, []);
  const afterListSave = useCallback((saved: boolean) => {
    if (!saved) writeRefused();
    return mirrorSavedLists();
  }, [writeRefused]);

  // The RoadmapStore is authoritative. Never replay the retired v1 cache into it.
  useEffect(() => {
    async function loadData() {
      // The mount's read, or a fresh one: the erase is read with the record, in one turn.
      const first = mountRead.current;
      mountRead.current = null;
      const { erase, result } = first ?? { erase: getEraseIdentity(), result: await loadLatestMeasurements() };
      showErase(erase);

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
        applyLists(result);
        // Every measurement, for both matrices (fire-and-forget, so it
        // doesn't block the first render).
        loadHistory();
        // Keep the legacy mirror available to the separate storefront chat embed.
        saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, undefined, labEgfrOf(await loadLabValues() ?? []),
          newestUsablePsa(loadAllHistorySync(), new Date()));
      } else {
        // Nothing on record: a new visitor, or another device erased it. The
        // bubble and the embed must not keep sending the old copy (US-11).
        saveToLocalStorage({}, [], [], []);
      }
      setHasApiResponse(true);
    }

    void loadData();
  }, [showErase]);

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

  // The day of the value the plan reads for a field: a draft's own; one
  // typed with no day counts as today's (null); else the saved row's.
  const inputDay = useCallback((field: keyof HealthInputs, metric: string) => {
    const saved = previousMeasurements.find((m) => m.metricType === metric);
    return lent[field] !== undefined ? lentDays[field] ?? null
      : inputs[field] !== undefined || !saved ? null : dayOf(saved.recordedAt);
  }, [inputs, lent, lentDays, previousMeasurements]);

  // What the plan and the chat read: the inputs with the lab's printed eGFR
  // when it is newer than the creatinine or from its day (US-07 AC7).
  const labEgfr = useMemo(() => labEgfrOf(labValueHistory), [labValueHistory]);
  const planInputs = useMemo(
    () => withLabEgfr(effectiveInputs, inputDay('creatinine', 'creatinine'), labEgfr, localDay(new Date())),
    [inputDay, effectiveInputs, labEgfr],
  );
  // US-02 AC8: the pair is judged only when both halves are from one day. A
  // typed half counts as today's, the day it would be saved with.
  const pressureDays = useMemo(() => {
    const today = localDay(new Date());
    return {
      systolicBp: inputDay('systolicBp', 'systolic_bp') ?? today,
      diastolicBp: inputDay('diastolicBp', 'diastolic_bp') ?? today,
    };
  }, [inputDay]);

  // The form is the onboarding (US-62 AC13): the first answer the record
  // lacks. The chatbot embed reads the same rule. What the person has
  // unlocked on this record (`reached`) sets the form, About you, the weight's
  // place and the floating chat; a record holding more than the four answers
  // opens the whole form at once, the missing questions at the top (US-01
  // AC3). The chats' wording follows the stage itself.
  const formStage = useMemo(
    () => computeFormStage(effectiveInputs, previousMeasurements),
    [effectiveInputs, previousMeasurements],
  );
  const { reached, opened, epoch, fullForm } = useReachedStage(formStage, {
    saved: previousMeasurements, medications, screenings, supplements, documents: documentHistory, labValues: labValueHistory,
  });

  // US-62 AC13: each step answered in this tab, once, and the end. Only a
  // rise in `reached` after the person's own action here counts, as the
  // step that was asked (the form,
  // a matrix, the chat's profile proposal, an upload): a returning user, an
  // answer retyped, or a jump from another device or tab sends none. An erase
  // starts the count again. The step's name only, never its answer.
  const answeredHere = useRef(false); // set by the person's actions, cleared by a remote change
  const markAnswered = useCallback(() => { answeredHere.current = true; }, []);
  // A matrix's weight cell is the one matrix edit that can answer a step.
  const markMatrixWeight = useCallback((e: React.SyntheticEvent) => {
    if ((e.target as HTMLElement).closest?.('.bt-vitals-card [data-metric="weight"]')) markAnswered();
  }, [markAnswered]);
  const countedTo = useRef<{ epoch: number; stage: number } | null>(null);
  // US-62 AC31: "Your plan is ready." for the record whose onboarding ended in this tab.
  const [planReadyFor, setPlanReadyFor] = useState<number | null>(null);
  const dismissPlanReady = useCallback(() => {
    trackProductEvent('plan_ready_dismissed');
    try { localStorage.setItem(PLAN_READY_SEEN_KEY, '1'); } catch { /* private mode: gone for this visit only */ }
    setPlanReadyFor(null);
    // The focus stays on the page, not lost with the button.
    rootRef.current?.querySelector<HTMLElement>('.mh-title')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const from = countedTo.current?.epoch === epoch ? countedTo.current.stage : reached;
    countedTo.current = { epoch, stage: reached };
    if (reached <= from || !answeredHere.current || !hasApiResponse) return;
    answeredHere.current = false;
    // The step that was asked is the one answered; later steps a record already held were not (stage 1 asks the measurements, 2 sex, 3 the birth date).
    trackProductEvent('onboarding_step', { step: ONBOARDING_STEPS[from - 1] });
    if (reached === 4) {
      trackProductEvent('onboarding_done');
      if (!planReadySeen()) setPlanReadyFor(epoch); // US-62 AC31: this onboarding, this tab
    }
  });
  // US-62 AC12: About you goes low for a record complete when first shown, and
  // once the four answers hold and the focus leaves its card (this record:
  // an erase starts it again).
  const [movedLow, setMovedLow] = useState<number | null>(null);
  const aboutYouLow = opened === 4 || movedLow === epoch;
  const handleProfileLeft = useCallback(() => {
    if (stageRef.current === 4) setMovedLow(epoch);
  }, [epoch]);
  // An erase closes the floating chat: its conversation belongs to the old record.
  useEffect(() => { setFloatingChatOpen(false); }, [epoch]);
  // The latest stage, for a call made after the render that changed it.
  const stageRef = useRef(formStage);
  stageRef.current = formStage;

  // Pre-fetch chat conversations in background once the chat unmutes,
  // so messages are ready instantly when the user clicks the chat bubble.
  // The list is this record's: an erase starts it again, and a list asked for
  // before the erase is never handed to the chat after it (US-11 AC2g).
  useEffect(() => {
    if (reached < 4 || prefetchFor(chatPrefetch, epoch)) return;
    listConversations().then((result) => {
      if (!result) return;
      setChatPrefetch({
        epoch,
        data: { conversations: result.conversations, messages: [], activeConversationId: null },
      });
    });
  }, [reached, epoch, chatPrefetch]);

  // Save any unsaved profile/demographic fields (height, sex, birthYear, birthMonth, unitSystem).
  // Returns true if saved or nothing to save; false on failure.
  async function flushPendingProfileSave(erase?: string): Promise<boolean> {
    if (getBackendKind() === 'local' && localHealthWritesStopped()) return true;
    const autoSaveFields = [...PREFILL_FIELDS, 'unitSystem' as keyof HealthInputs];
    const currentPrefill: Partial<HealthInputs> = {};
    const previousPrefill: Partial<HealthInputs> = {};
    for (const field of autoSaveFields) {
      if (inputs[field] !== undefined) (currentPrefill as any)[field] = inputs[field];
      if (previousInputsRef.current[field] !== undefined) (previousPrefill as any)[field] = previousInputsRef.current[field];
    }

    const hasChanges = autoSaveFields.some(f => inputs[f] !== previousInputsRef.current[f]);
    // Clean (a refused value cleared or put back): a held remote change applies now (N1).
    if (!hasChanges) { remoteRelay.saved(); return true; }

    const result = await saveChangedMeasurements(currentPrefill, previousPrefill, erase);
    if (!result.ok) {
      writeRefused();
      return false;
    }
    if (getBackendKind() === 'local' && localHealthWritesStopped()) return true;
    const refused = result.birthRefused;
    // A value out of range was refused (US-02 AC5): it stays in the form, unsaved, its error shown.
    const kept = new Set(Object.keys(result.refused ?? {}) as Array<keyof HealthInputs>);
    if (refused) { kept.add('birthYear'); kept.add('birthMonth'); }
    for (const field of autoSaveFields) {
      if (!kept.has(field)) (previousInputsRef.current as any)[field] = inputs[field];
    }
    if (refused) {
      // US-54 AC5b: the form shows the record's pair again, unless typed over
      // since, so it is clean and a remote change still applies (US-34 AC4).
      const saved = previousInputsRef.current;
      setInputs(prev => (prev.birthYear === inputs.birthYear && prev.birthMonth === inputs.birthMonth
        ? { ...prev, birthYear: saved.birthYear, birthMonth: saved.birthMonth }
        : prev));
      setBirthRefused(birthRefusedMessage(refused.birthYear, refused.birthMonth));
    }
    // The chat copy holds the saved profile beside the saved values it
    // already has (US-15 AC10).
    patchMirror({ profile: { ...previousInputsRef.current } });
    // The form is clean again — apply any remote change held back while it
    // was dirty (US-34 AC4). Not while a refused value is still in the form:
    // the re-read would replace it and its error (US-02 AC5); the relay
    // waits for the save that takes it. Nor while an edit made during the
    // await is unsaved: read the latest form, not this save's snapshot.
    if (!result.refused && !autoSaveFields.some(f => inputsRef.current[f] !== inputs[f])) remoteRelay.saved();
    return true;
  }

  // Auto-save demographics + height only (debounced)
  const profileDebounce = useDebouncedSave(500);
  useEffect(() => {
    if (!hasApiResponse) return;

    const erase = getShownErase(); // as the edit was made, not as the timer fires
    profileDebounce.schedule(() => { void flushPendingProfileSave(erase); });

    return () => profileDebounce.cancel();
  }, [inputs, hasApiResponse, profileDebounce]);

  // The saved-value editor's correction, core or lab (US-04, US-21 AC5),
  // then the page re-reads the record.
  const handleCorrectValue = useCallback<CorrectFn>(async (id, newValue) => {
    const status = await countedCorrection(id, newValue);
    if (status === 'ok') await reloadValues();
    return status;
  }, [reloadValues]);

  // A saved blood test moved to the day it was drawn (US-04 AC5), counted by
  // name only; the page re-reads the record as after a correction.
  const moveTest = useMemo<MoveTestApi>(() => ({
    preview: previewMove,
    move: async (from, to, expectedIds, keep) => {
      const outcome = await moveBloodTest(from, to, expectedIds, keep);
      if (outcome.status === 'ok') {
        trackProductEvent('blood_test_moved');
        await reloadValues();
      }
      return outcome;
    },
  }), [reloadValues]);

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
      setIsSavingLongitudinal(true);
      try {
        const refused = await staged;
        await reloadValues();

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
        setIsSavingLongitudinal(false);
      }
    };
    if (now) {
      if (getBackendKind() === 'local' && localHealthWritesStopped()) return Promise.resolve(new Map());
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
  }, [inputs, history, unitOverrides, unitSystem, psaDate, reloadValues]);

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
  // Stage only queued edits, with the erase they were made against, then flush
  // synchronously: the entrypoint's earlier listener may have flushed first.
  // A matrix's draft stays on the device instead (US-03 AC5). A closing tab
  // fires no blur, so focus still in the PSA row is moved out first: the
  // row's blur commits it, with its own checks. The fields' waiting save and
  // a committed PSA are then written at once, not on the timer or a promise,
  // which would run after the flush (US-06 AC15; Brad 2026-11-03: weight,
  // waist or BP save on tab close). iOS kills a hidden tab, so hiding stages
  // the same, but leaves an unfinished PSA row alone: it waits for its date
  // (Brad 2026-11-03, "Wait for the date").
  useEffect(() => {
    const stage = (closing: boolean) => {
      const focused = document.activeElement;
      if (closing && focused instanceof HTMLElement && focused.closest('.psa-inline-row')) focused.blur();
      profileDebounce.flush();
      const pending = pendingSaveRef.current;
      if (pending) {
        pendingSaveRef.current = null;
        longitudinalDebounce.cancel();
        void handleSaveLongitudinalRef.current(undefined, pending.erase, true);
      }
      // The waiting medication, screening and supplement saves, each with the
      // erase it was made against, so the write below holds them (US-06 AC13).
      flushListSaves([medSaveTimers.current, screeningSaveTimers.current, supSaveTimers.current]);
      flushRoadmapStoreSync();
    };
    const onUnload = () => stage(true);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') stage(false);
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [longitudinalDebounce, profileDebounce]);

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
    const erase = getEraseIdentity(); // read with the record, in one turn
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
      // A value out of range is never in the record (its save refused or
      // skipped it, US-02 AC5), so it rides through too, with its error.
      // Only within one record: an erase from another device clears this
      // device's drafts (US-11 AC6, Codex R4).
      const typing = document.activeElement?.id as keyof HealthInputs | undefined;
      const sameRecord = erase === getShownErase();
      setInputs(prev => {
        if (!sameRecord) return result.inputs;
        const next: Partial<HealthInputs> = typing && LONGITUDINAL_FIELDS.includes(typing) && prev[typing] !== undefined
          ? { ...result.inputs, [typing]: prev[typing] }
          : { ...result.inputs };
        for (const [field, value] of Object.entries(prev)) {
          if (inputRangeFault(field, value)) (next as Record<string, unknown>)[field] = value;
        }
        return next;
      });
      previousInputsRef.current = { ...result.inputs };
      applyLists(result);
    }
    // Another device erased the record (US-16 AC2a / US-09): a chat banner
    // left standing would write pre-erase values into the erased record.
    showErase(erase);
  }, [reloadValues, longitudinalDebounce, showErase]);

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
    // An erase from another device (a new erase identity) is never held: it
    // applies at once and drops this device's drafts, refused ones included
    // (US-11 AC6); a refused draft would otherwise hold it for good.
    const onRemoteChange = () => remoteRelay.arrived(getEraseIdentity() === getShownErase()
      && hasUnsavedProfileEdits(inputsRef.current, previousInputsRef.current));
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
  }, [remoteRelay, handleUploadComplete]);

  // US-65: entries this build could not read are kept unchanged and never
  // shown; one calm line says how many, read on every render so a re-read
  // that brings or clears them shows at once. Counted once per tab, count only.
  const unreadable = getUnreadableCount();
  const unreadableLine = unreadableNote(unreadable);
  useEffect(() => {
    if (unreadable > 0) trackProductEvent('record_unreadable_kept', { count: Math.min(unreadable, 1000) });
  }, [unreadable]);

  // Calculate results using effective inputs (form + fallback to previous)
  const { results, isValid, validationErrors, planBasis } = useMemo(() => {
    // The plan needs a height; what needs sex waits for it (US-07 AC8).
    if (!planInputs.heightCm) {
      return { results: null, isValid: false, validationErrors: null, planBasis: null };
    }

    const validation = validateHealthInputs(planInputs, pressureDays);
    // Convert error messages to user's unit system (e.g., "20 kg" → "44 lbs")
    const errors = validation.errors ? convertValidationErrorsToUnits(getValidationErrors(validation.errors), unitSystem) : null;
    // health-core's one strip (US-07 AC11): refused fields left out so the rest still plans, a swapped pair marked.
    const calcInputs: SuggestionInputs | null = planInputsFrom(planInputs, validation);
    if (!calcInputs) {
      return { results: null, isValid: false, validationErrors: errors, planBasis: null };
    }

    const healthResults = calculateHealthResults(
      calcInputs,
      unitSystem,
      medicationsToInputs(medications),
      // US-06 AC14: the prostate cards read the newest usable saved PSA, as computePlan does.
      withPsaMeasurement(screeningsToInputs(screenings), newestUsablePsa(history, new Date())),
      metricUnitOverrides,
    );
    // The form follows the plan: its recommendations, targets and cascade
    // steps read what the plan was computed from (US-06 AC5): its age, BMI,
    // weight target and validated height, its trigger and its lipid marker.
    // The plan's medicine cards need a known age of 18 or over (US-07 AC6),
    // so without one the form's medication sections are plain fields.
    const medicines = medicinesShown(healthResults);
    const planBasis: PlanBasis = {
      ...healthResults,
      weightMedTrigger: medicines ? weightMedicationTrigger(calcInputs, healthResults) : { on: false, reasons: [] },
      lipidMarker: medicines ? lipidMarkerFor(calcInputs, healthResults) : null,
    };
    return { results: healthResults, isValid: true, validationErrors: errors, planBasis };
  }, [planInputs, pressureDays, unitSystem, medications, screenings, history, metricUnitOverrides]);

  useEffect(() => {
    setErrors(validationErrors ?? {});
  }, [validationErrors]);

  // US-07 AC6: the form withholds its adult readings from a known minor by the
  // validated birth year and month alone, with or without a plan (Codex R1:
  // with no height or sex the blood-test matrix still shows). Memoised: the
  // review's cells are memo components.
  const knownMinor = knownMinorOf(effectiveInputs);
  const grading = useMemo<Grading>(() => (knownMinor ? null : { sex: inputs.sex }), [knownMinor, inputs.sex]);

  // Mobile tab state
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const isWideDesktop = useIsWideDesktop(1200);
  const floatingChat = !isMobile && !isWideDesktop && reached === 4;
  const [activeTab, setActiveTab] = useState<TabId>('health');
  const tabIds = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // US-62 AC4: the redesign's denominator, once per tab, with the layout chosen
  // at mount (a later resize does not change it). Shopify only, like every event.
  useEffect(() => {
    trackProductEvent('tool_opened', { device: isMobile ? 'phone' : 'desktop' });
  }, []); // at mount only

  // US-62 AC5: `results_viewed` once the plan's cards are on screen, not when
  // they mount. They show with My health's topics, once the onboarding is done
  // (`fullForm`, US-62 AC25), on a phone only on the My health tab. The topics'
  // top must be in the upper three quarters of the viewport (a margin, not a
  // ratio: a tall page never reaches 25% visible). Once per tab by the throttle.
  const hasSuggestions = (results?.suggestions?.length ?? 0) > 0;
  const sectionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasSuggestions || !fullForm || (isMobile && activeTab !== 'health')) return;
    const el = sectionsRef.current;
    if (!el) return;
    return observeVisibility(el, (visible) => {
      if (visible) trackProductEvent('results_viewed');
    }, { rootMargin: '0px 0px -25% 0px' });
  }, [hasSuggestions, isMobile, activeTab, fullForm]);

  // The plan's tiles, once: under the onboarding, and on their rows' pages (US-62 AC25, AC26).
  const sex = isSex(inputs.sex) ? inputs.sex : undefined;
  const tiles = useMemo(
    () => (results ? statTiles(results, { unitSystem, unitOverrides: metricUnitOverrides, sex }) : []),
    [results, unitSystem, metricUnitOverrides, sex],
  );
  // My health's worked-out rows (US-62 AC21), read again as the record's rows or profile change.
  // The rows' data follows `history` and the lab rows, both read again after every save and
  // remote change; the profile is the screen's, so a typed height counts before its save lands.
  const series = useMemo(() => loadDerivedSeries({
    heightCm: inputs.heightCm, sex: inputs.sex, birthYear: inputs.birthYear, birthMonth: inputs.birthMonth,
  }), [history, labValueHistory, inputs.heightCm, inputs.sex, inputs.birthYear, inputs.birthMonth]);
  // The day and source of the plan's eGFR, for its row (the plan's own pick, withLabEgfr).
  const egfrFromLab = !!(results?.eGFRFromLab || results?.limits?.labEgfr);
  const egfrDay = egfrFromLab ? planInputs.labEgfrDate : results?.eGFR !== undefined ? planInputs.creatinineDay ?? localDay(new Date()) : undefined;
  const egfrCurrent = egfrDay ? { day: egfrDay, source: egfrFromLab ? 'lab' as const : 'calculated' as const } : null;

  // US-20 AC6: each tab keeps its own scroll position. The page scrolls, not
  // the panel, so leaving a tab records the page's offset and coming back
  // restores it; a tab not yet visited opens at the widget's top.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const scrollByTab = useRef<Partial<Record<TabId, number>>>({});
  const scrollOnSwitch = useRef(false);
  const selectTab = useCallback((tab: TabId) => {
    if (tab === activeTabRef.current) return;
    scrollByTab.current[activeTabRef.current] = window.scrollY;
    scrollOnSwitch.current = true;
    setActiveTab(tab);
  }, []);
  useLayoutEffect(() => {
    if (!scrollOnSwitch.current) return;
    scrollOnSwitch.current = false;
    const saved = scrollByTab.current[activeTab];
    // A first visit opens at the tab's panel, just under the theme's sticky header. The chat's
    // card is sized to the screen left between its own top (the header, then the card's measured
    // inset in its panel) and the tab bar (styles.css, --hr-chat-top, --hr-tabbar-h).
    const sticky = stickyTop();
    const panel = document.getElementById(panelDomId(tabIds, activeTab));
    const card = panel?.querySelector('.chat-embed');
    const inset = panel && card ? card.getBoundingClientRect().top - panel.getBoundingClientRect().top : 0;
    rootRef.current?.style.setProperty('--hr-chat-top', `${Math.round(sticky + inset)}px`);
    rootRef.current?.style.setProperty('--hr-tabbar-h', `${Math.round(rootRef.current.querySelector('.hr-tabbar')?.getBoundingClientRect().height ?? 51)}px`);
    const top = (panel?.getBoundingClientRect().top ?? 0) - sticky;
    // At once: the theme's smooth scrolling would slide the page from the top.
    if (saved !== undefined) window.scrollTo({ top: saved, behavior: 'instant' });
    else if (top !== 0) window.scrollTo({ top: window.scrollY + top, behavior: 'instant' });
  }, [activeTab]);

  // US-16 AC2 on a phone: after a chat edit switches to My data, the filled
  // cell (a matrix's highlighted cell, or the plain field) is scrolled to the
  // middle, clear of the tab bar, and focused. After the commit, so after the
  // tab's own scroll restore. On desktop the chat stays where it is: the
  // table opens (US-62 AC11) and the focus stays in the chat.
  const [revealCell, setRevealCell] = useState<{ field: string; grid: boolean } | null>(null);
  useEffect(() => {
    if (!revealCell || !isMobileRef.current) return;
    const panel = rootRef.current?.querySelector('.health-input-panel');
    const cell = panel?.querySelector<HTMLElement>('.bt-input-active') ?? document.getElementById(revealCell.field);
    cell?.scrollIntoView({ block: 'center' });
    cell?.focus({ preventScroll: true });
  }, [revealCell]);

  const handleDeleteData = useCallback(async () => {
    const confirmed = window.confirm(ERASE_CONFIRM);
    if (!confirmed) return false;

    setIsDeleting(true);
    erasingRef.current = true;
    const before = getEraseIdentity();
    const result = await deleteUserData();
    erasingRef.current = false;
    setIsDeleting(false);

    // An erase whose write failed still leaves the erased copy in the store,
    // which retries it: the screen shows that copy too (US-16 AC2a). A
    // refused erase moved nothing, whatever else the screen is behind.
    if (result.success || getEraseIdentity() !== before) {
      clearLocalStorage();
      // The matrices' drafts and the Lp(a) check's answers too, on the device
      // and on screen: a failed write's store holds the erased copy. Stored
      // originals go by the session's rule, never by the page (US-11 AC6).
      clearOffFileAfterErase();
      setInputs({});
      clearForErase();
      // Cleared here too: a re-read during the write may have shown this
      // erase already, and showErase then clears nothing (adversary R1).
      clearChatEdits();
      showErase(getEraseIdentity());
      // A refusal of this erase's own leftovers is not news (adversary R3).
      refusedFor.current = getEraseIdentity();
      longitudinalDebounce.cancel();
      profileDebounce.cancel();
      // A save the form scheduled before the erase is pre-erase (US-16 AC2a).
      for (const timers of [medSaveTimers, screeningSaveTimers, supSaveTimers]) {
        for (const { timer } of timers.current.values()) clearTimeout(timer);
        timers.current.clear();
      }
      previousInputsRef.current = {};
    }
    if (result.success) {
      const done = result.chatErased ? ERASE_DONE : result.chatUnread ? ERASE_DONE_CHAT_UNREAD : ERASE_DONE_CHAT_PENDING;
      window.alert(result.warning ? `${done}\n\n${result.warning}` : done);
    } else {
      window.alert(result.error || ERASE_FAILED);
    }
    return result.success;
  }, [longitudinalDebounce, profileDebounce, showErase]);

  // One field's new value, from the form or the chat. A weight or waist
  // keeps the unit its caller converted it from (typedIn). One update per
  // field, so several made at once all land (US-16 AC1).
  const handleInputChange = useCallback(<K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem) => {
    if (ONBOARDING_FIELDS.includes(field)) markAnswered(); // US-62 AC13: an answer given in this tab
    if (unit) typedIn.current[field] = { value, unit };
    // The user's own sex or height outranks a chat proposal for it (US-16 AC2).
    if (field === 'sex' || field === 'heightCm') dropProfileProposal();
    if (field === 'birthYear' || field === 'birthMonth') setBirthRefused(null);
    setInputs(prev => ({ ...prev, [field]: value }));
  }, []);
  // US-60: the plan card's answer saves as a profile field, as About you's
  // Alcohol row does. Its usage signal is the name alone, never the answer
  // (whether someone drinks is health information), and only from the card.
  const handleAlcoholAnswer = useCallback((answer: AlcoholAnswer) => {
    trackProductEvent('alcohol_question_answered');
    handleInputChange('alcohol', answer);
  }, [handleInputChange]);
  // A matrix's draft value, as the plan and the chat read it (US-03 AC6);
  // undefined leaves the field to the record. One update per field, so
  // several sent at once all land.
  const handleDraftValue = useCallback((field: keyof HealthInputs, value: number | undefined, day?: string) => {
    setLent(prev => {
      const next = { ...prev, [field]: value };
      if (value === undefined) delete next[field];
      return next;
    });
    setLentDays(prev => {
      const next = { ...prev, [field]: day };
      if (value === undefined || day === undefined) delete next[field];
      return next;
    });
  }, []);

  const handleMedicationChange = useCallback((
    medicationKey: string,
    drugName: string,
    doseValue: number | null,
    doseUnit: string | null,
  ) => {
    // Shown at once, ahead of the save.
    patchMedication(medicationKey, old => ({
      id: old?.id ?? '',
      medicationKey,
      drugName,
      doseValue,
      doseUnit,
      updatedAt: new Date().toISOString(),
    }));

    debounceSave(medSaveTimers.current, medicationKey,
      (erase) => void saveMedication(medicationKey, drugName, doseValue, doseUnit, erase).then(afterListSave));
  }, [afterListSave]);

  // `erase`: a caller that asked before now, such as an upload (US-16 AC2a).
  const handleScreeningChange = useCallback((screeningKey: string, value: string, erase?: string) => {
    patchScreening(screeningKey, old => ({
      id: old?.id ?? '',
      screeningKey,
      value,
      updatedAt: new Date().toISOString(),
    }));

    debounceSave(screeningSaveTimers.current, screeningKey,
      (stamp) => void saveScreening(screeningKey, value, stamp).then(afterListSave), erase);
  }, [afterListSave]);

  const supSaveTimers = useRef<ListSaves>(new Map());
  useEffect(() => () => { for (const { timer } of supSaveTimers.current.values()) clearTimeout(timer); }, []);

  const handleSupplementChange = useCallback((
    supplementKey: string,
    supplementName: string,
    doseValue: number | null,
    doseUnit: string | null,
    status: string = 'active',
    startedAt?: string,
  ) => {
    patchSupplement(supplementKey, old => ({
      id: old?.id ?? '',
      supplementKey,
      supplementName,
      doseValue,
      doseUnit,
      status,
      startedAt: startedAt ?? old?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    debounceSave(supSaveTimers.current, supplementKey,
      (erase) => void saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt, erase).then(saved => { if (!saved) writeRefused(); }));
  }, [writeRefused]);

  const handleSupplementDelete = useCallback((supplementKey: string) => {
    // A dose save still waiting would land after the stop and restart the row.
    cancelListSave(supSaveTimers.current, supplementKey);
    stopSupplement(supplementKey);
    void deleteSupplementApi(supplementKey).then(saved => { if (!saved) writeRefused(); });
  }, [writeRefused]);

  // Settings (US-62 AC24): the person button opens them in My health's place.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Edits the chat proposes, routed to the form (components/ChatEdits). The
  // hand-off: on a phone the form's tab opens, and Settings, which cover the
  // field, close (US-62 AC11).
  const showForm = useCallback(() => {
    if (isMobileRef.current) selectTab('health');
    setSettingsOpen(false);
  }, [selectTab]);
  const { handleProposeEdit, clearChatEdits, dropProfileProposal, banners: chatEditBanners } = useChatEdits({
    medications, inputs, inputsRef, unitSystem, eraseUnshown, handleInputChange, handleMedicationChange,
    medSaveTimers, vitalsPrefillRef, bloodTestPrefillRef, showForm, reveal: setRevealCell,
  });

  // Email capture and US-23 reminder enrolment require the Shopify server.
  const emailCaptureActive = SHOPIFY_SURFACE;

  // Says whether it acted, so a caller spends its once-only jump only then.
  // Once the last onboarding answer is in (US-62 AC13), the focus moves to the
  // "Your plan is ready." card, with no jump (US-62 AC31); with no card, the person
  // lands at the top of My health, its title (US-62 AC25, orchestrator 2026-11-06). Leaving the
  // field also lets About you go to Settings (US-62 AC12). A weight lands only
  // where it used to jump to the email box (the Shopify build, US-22), so the
  // Pages build never takes the focus from a value being typed; the birth year
  // (`fromBirth`, Brad 2026-11-02) lands on both.
  const landOnMyHealth = useCallback((fromBirth = false): boolean => {
    // Only when the answer was the last one: a first weight is step 1.
    if (stageRef.current !== 4 || (!emailCaptureActive && !fromBirth)) return false;
    selectTab('health');
    requestAnimationFrame(() => {
      const ready = rootRef.current?.querySelector<HTMLElement>('.mh-ready-title');
      if (ready) ready.focus({ preventScroll: true });
      else revealAndFocus(rootRef.current?.querySelector<HTMLElement>('.mh-title'), 'start', false);
    });
    return true;
  }, [emailCaptureActive, selectTab]);

  // Memoised so the UploadModal's matrix doesn't rebuild on unrelated
  // HealthTool re-renders (typing, mobile-tab switches, etc.).
  const uploadHistory = useMemo(
    () => ({ measurements: history, labValues: labValueHistory, documents: documentHistory }),
    [history, labValueHistory, documentHistory],
  );

  // The form's medicine and screening questions, as health-core builds them
  // (the InputPanel parity test pins the two together): a suggestion sits on
  // the question that asks it (US-62 AC20).
  const e = effectiveInputs;
  const hasLipidInput = e.apoB !== undefined || e.ldlC !== undefined || e.totalCholesterol !== undefined || e.hdlC !== undefined;
  const hasWeightInput = e.hba1c !== undefined || e.triglycerides !== undefined || (e.weightKg !== undefined && e.heightCm !== undefined);
  const forms = useMemo(() => ({
    medications: medicationForm(medicationsToInputs(medications), {
      lipidMarker: planBasis?.lipidMarker ?? null,
      weightMedTrigger: planBasis?.weightMedTrigger ?? { on: false, reasons: [] },
      bmi: planBasis?.bmi,
      hasLipidInput,
      hasWeightInput,
      unitFor: (metric) => unitOverrides[METRIC_TO_FIELD[metric]] ?? unitSystem,
    }),
    screenings: screeningForm(planBasis?.age, inputs.sex, screeningsToInputs(screenings)),
  }), [hasLipidInput, hasWeightInput, medications, screenings, planBasis, inputs.sex, unitOverrides, unitSystem]);

  const plan = usePlanView({
    results,
    isValid,
    tiles,
    forms,
    hasUnsavedLongitudinal: hasApiResponse && LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined),
    onSaveLongitudinal: handleSaveLongitudinal,
    showEmailCapture: emailCaptureActive,
    formStage: reached,
    // US-60 AC3: the Dismiss asks the unanswered and drinkers; a non-drinker has no card.
    // The "I still drink" line names About you, as Settings' heading does, once
    // About you sits there (aboutYouLow), the only time its rows hold the Alcohol row;
    // before that no row shows, so the line names none (US-60 AC4).
    alcoholQuestion: { answer: inputs.alcohol, onAnswer: handleAlcoholAnswer, aboutYouRow: aboutYouLow },
  });

  // Desktop: Settings open in My health's place, behind the person button. A phone: they are
  // the Account tab (US-62 AC34), so leaving them (an erase) lands on My health's title.
  const personRef = useRef<HTMLButtonElement>(null);
  const [accountHost, setAccountHost] = useState<HTMLFieldSetElement | null>(null);
  const settingsShown = isMobile ? activeTab === 'account' : settingsOpen;
  const toggleSettings = useCallback(() => setSettingsOpen(open => !open), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (isMobileRef.current) selectTab('health');
    requestAnimationFrame(() => (isMobileRef.current ? rootRef.current?.querySelector<HTMLElement>('.mh-title') : personRef.current)?.focus());
  }, [selectTab]);
  // Back closes Settings, as it closes a value page (US-62 AC24).
  useEffect(() => {
    if (!settingsOpen) return;
    window.addEventListener('popstate', closeSettings);
    return () => window.removeEventListener('popstate', closeSettings);
  }, [settingsOpen, closeSettings]);
  const personButton = <PersonButton onClick={toggleSettings} buttonRef={personRef} open={settingsOpen}/>;
  // Where the record lives (US-09): in Settings, and for a guest also at My health's foot (orchestrator
  // 2026-11-06). One place at a time: one picker. A phone's Account shows it before any data (its button
  // is the tab's one sign-in, US-62 AC34). A tab switch remounts SyncControl and shuts an open picker;
  // the chat hand-off's selectTab('health') can do that mid-pick (accepted: the lift finishes on its own).
  const storageCard = syncControl?.({ hasData: plan.planned || (isMobile && settingsShown), attention: plan.attention });

  const myHealthProps = {
    plan, tiles, series, egfrCurrent, sectionsRef, setShowUploadModal,
    // On My health's title line on desktop; on a phone, on the Account tab's (US-62 AC34).
    storageBar,
    personButton,
    saveAlert,
    syncAlert,
    settingsOpen: settingsShown,
    onSettingsClose: closeSettings,
    settingsHost: isMobile ? accountHost : undefined,
    // US-07 AC6: no reminders for a known minor, who is never enrolled and must see no mailing-list box.
    reminders: plan.planned && !results?.knownMinor ? remindersSection : null,
    storageCard,
    onDelete: async () => { if (await handleDeleteData()) { plan.onErased(); closeSettings(); } },
    isDeleting,
    storageAtFoot: getBackendKind() === 'local',
    onPlanReadyDismiss: planReadyFor === epoch ? dismissPlanReady : undefined,
    healthDocuments: documentHistory,
    onDocumentDeleted: dropDocument,
  };
  // The reasons open on screen are the PDF's too (US-62 AC28).
  const myHealth = (form: FormSlots) => (
    <OpenEvidenceContext.Provider value={plan.evidence}><MyHealth form={form} {...myHealthProps}/></OpenEvidenceContext.Provider>
  );

  const inputPanelProps = {
    inputs,
    effectiveInputs,
    onChange: handleInputChange,
    errors: birthRefused ? { ...errors, birthMonth: birthRefused } : errors,
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
    moveTest,
    onDraftValue: handleDraftValue,
    medications,
    onMedicationChange: handleMedicationChange,
    screenings,
    onScreeningChange: handleScreeningChange,
    psaDate,
    onPsaDateChange: setPsaDate,
    onPsaCommit: commitPsa,
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
    reached,
    fullForm,
    aboutYouLow,
    onProfileLeft: handleProfileLeft,
    setShowUploadModal,
    planBasis,
    grading,
    onOnboardingDone: landOnMyHealth,
    // On a phone a chat edit opens the grids, so the filled cell shows (US-62 AC11).
    revealCell,
  };

  // The chat reads its context as each message is sent (useChatState), through
  // one reader that never changes, so the chat's send handler is not rebuilt
  // on every keystroke. chatContextOf builds it here as it does for the blog
  // bubble and the chatbot embed: the plan's inputs and the dated history.
  const chatContextRef = useRef<() => ChatContextPayload | null>(() => null);
  chatContextRef.current = () => chatContextOf(
    planInputs, unitSystem, medications, screenings, [...bloodTestHistory, ...vitalsHistory],
  );
  const readChatContext = useCallback(() => chatContextRef.current(), []);

  const chatSectionProps = {
    isLoggedIn: true,
    guestInputs: readChatContext,
    prefetchedData: prefetchFor(chatPrefetch, epoch),
    onProposeEdit: handleProposeEdit,
  };

  // US-62 AC16, AC34: on a phone, three panels, My health, Chat and Account, and a bottom tab
  // bar. My health and Chat stay mounted (the form's drafts and the chat's conversation survive
  // a switch); only the active one shows. Account holds Settings, drawn by My health and kept
  // mounted (a half-typed reminder email survives a switch), inside the erase lock.
  const panel = (tab: TabId, children: ReactNode) => (
    <div className="hr-tabpanel" role="tabpanel" id={panelDomId(tabIds, tab)} aria-labelledby={tabDomId(tabIds, tab)} hidden={activeTab !== tab}>
      {children}
    </div>
  );
  const healthForm = <fieldset className="health-form-lock" disabled={isDeleting} onChangeCapture={markMatrixWeight}><InputPanel {...inputPanelProps}>{myHealth}</InputPanel></fieldset>;
  const chat = (
    <div className="health-tool-chat">
      <ChatEmbed isLoggedIn={chatSectionProps.isLoggedIn} guestInputs={chatSectionProps.guestInputs} muted={formStage < 4} onProposeEdit={handleProposeEdit}/>
    </div>
  );
  return (
    <div className="health-tool" ref={rootRef} data-clarity-mask="true">
      {unreadableLine && <p className="hr-unreadable-note no-print" role="status">{unreadableLine}</p>}
      {isMobile ? (
        <>
          {panel('health', healthForm)}
          {/* US-01 AC5: a refused save is said on the open tab, here too (US-62 AC34). */}
          {panel('chat', <>{saveAlert}{chat}</>)}
          {panel('account', <fieldset className="health-form-lock mh-account" disabled={isDeleting} ref={setAccountHost}/>)}
          <BottomTabBar activeTab={activeTab} onTabChange={selectTab} idPrefix={tabIds} />
        </>
      ) : (
        <div className="health-tool-content">
          {/* US-62 AC16: one My health column, centred; the chat column beside it from 1200px. */}
          <div className="health-tool-main">{healthForm}</div>
          {isWideDesktop && chat}
        </div>
      )}

      {/* A new erase mounts a new modal: a review read before it, hidden or
          open, would save pre-erase values into the erased record (US-16 AC2c). */}
      <UploadModal
        key={shownErase}
        open={showUploadModal}
        onOpen={() => setShowUploadModal(true)}
        unitSystem={unitSystem}
        metricUnitOverrides={metricUnitOverrides}
        onToggleFieldUnit={handleToggleFieldUnit}
        history={uploadHistory}
        onComplete={() => { markAnswered(); return handleUploadComplete(); }}
        onStart={handleUploadStart}
        onClose={() => setShowUploadModal(false)}
        onScreeningUpdate={handleScreeningChange}
        age={planBasis?.age}
        sex={sex}
        grading={grading}
      />

      {chatEditBanners}

      {/* Floating chat FAB + expanded panel — portaled to body so their
          position: fixed doesn't resolve against the transform'd .health-tool. */}
      {/* The chat waits for the onboarding's four answers (US-62 AC13); an
          open panel stays through an answer retyped, its wording muted. Only
          where no chat is on screen already: the phone has its Chat tab, and
          from 1200px the chat column shows (US-62 AC14). */}
      {floatingChat && !floatingChatOpen && createPortal(
        <button
          className="chat-fab no-print"
          onClick={() => setFloatingChatOpen(true)}
          aria-label="Open chat"
        >
          <svg className="chat-fab-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{CHAT_BUBBLES}</svg>
          <span className="chat-fab-label">Ask about your health</span>
        </button>,
        document.body,
      )}
      {floatingChat && floatingChatOpen && createPortal(
        <ChatSection
          startExpanded
          muted={formStage < 4}
          onClose={() => setFloatingChatOpen(false)}
          {...chatSectionProps}
        />,
        document.body,
      )}
    </div>
  );
}
