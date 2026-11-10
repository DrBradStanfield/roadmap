import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { calculateHealthResults, knownMinorOf } from '@roadmap/health-core/calculations';
import { unreadableNote } from '@roadmap/health-core/readable-rows';
import { medicinesShown, weightMedicationTrigger, lipidMarkerFor } from '@roadmap/health-core/suggestions';
import { validateHealthInputs, getValidationErrors, convertValidationErrorsToUnits, inputRangeFault } from '@roadmap/health-core/validation';
import { planInputsFrom, withLabEgfr, labEgfrOf } from '@roadmap/health-core/plan';
import { type SuggestionInputs, type AlcoholAnswer, type HealthInputs, isSex } from '@roadmap/health-core/types';
import type { UnitSystem } from '@roadmap/health-core/units';
import { LONGITUDINAL_FIELDS, medicationsToInputs, mergeLongitudinalInputs, screeningsToInputs, computeFormStage, METRIC_TO_FIELD, withPsaMeasurement } from '@roadmap/health-core/mappings';
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
import { revealAndFocus } from '../lib/reveal';
import { CHAT_BUBBLES } from './icons';
import { ChatSection, type ChatPrefetchData } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';
import { listConversations } from '../lib/chat-api';
import { UploadModal } from './UploadModal';
import { useIsMobile, useIsWideDesktop } from '../lib/useIsMobile';
import { BottomTabBar, panelDomId, tabDomId, type TabId } from './BottomTabBar';
import {
  saveToLocalStorage,
  clearLocalStorage,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  hasSavedRecord,
  getInitialInputsSync,
  getEraseIdentity,
  getShownErase,
  clearOffFileAfterErase,
  flushRoadmapStoreSync,
  loadLatestMeasurementsSync,
  loadDerivedSeries,
  moveBloodTest,
  previewMove,
  getBackendKind,
  getUnreadableCount,
} from '../lib/roadmap-data';
import { trackABImpression, trackProductEvent } from '../lib/server-api';
import { observeVisibility } from '../lib/observe-visibility';
import type { CorrectFn } from '../lib/matrix-save';
import type { Grading } from '../lib/blood-test-cell';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { createRemoteChangeRelay } from '../lib/remote-replay';
import { useRecordState } from '../hooks/useRecordState';
import { useOnboarding } from '../hooks/useOnboarding';
import { useErase } from '../hooks/useErase';
import { useProfileSave } from '../hooks/useProfileSave';
import { useListSaves } from '../hooks/useListSaves';
import { useRecordReads, mirrorRecord } from '../hooks/useRecordReads';
import { useTabs } from '../hooks/useTabs';
import { useUnits } from '../hooks/useUnits';
import { useLongitudinalSave, countedCorrection } from '../hooks/useLongitudinalSave';
import { useChatEdits } from './ChatEdits';
import { WRITE_REFUSED } from '../lib/erase-copy';

/** The onboarding's answers (US-62 AC13): only an edit to one of them counts as a step. */
const ONBOARDING_FIELDS: ReadonlyArray<keyof HealthInputs> = ['heightCm', 'weightKg', 'sex', 'birthMonth', 'birthYear'];

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
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasApiResponse, setHasApiResponse] = useState(false);
  // The relay is created once; the load path it calls changes identity on
  // most renders, so it is reached through a ref (US-34 AC4).
  const applyRemoteRef = useRef<() => void>(() => {});
  const [remoteRelay] = useState(() =>
    createRemoteChangeRelay(() => {
      clearAnswered(); // another writer's change is no answer given here (US-62 AC13)
      trackProductEvent('remote_change_applied', { backend: getBackendKind() });
      void applyRemoteRef.current();
    }),
  );

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
  // The unit a first-time weight or waist was typed in, in its field or to
  // the chat, beside the value it gave: a unit switch before the save leaves
  // "changes nothing" asked in that unit (US-03 AC3). It holds only while
  // the form holds that value. The journey redesign deletes it: it rebuilds
  // these fields on the matrices' draft model.
  const typedIn = useRef<Partial<Record<keyof HealthInputs, { value: unknown; unit: UnitSystem }>>>({});
  const isFirstSaveRef = useRef(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [floatingChatOpen, setFloatingChatOpen] = useState(false);
  const [chatPrefetch, setChatPrefetch] = useState<ChatPrefetch | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  // The unit system and each field's own unit (hooks/useUnits, US-05); the record's, held while anything is typed (hooks/useHeldUnits).
  const { unitSystem, unitOverrides, metricUnitOverrides, handleToggleFieldUnit, handleUnitSystemChange, showUnits, offerUnits, onDraftsHold } = useUnits(setInputs, rootRef);

  // The page's reads of the record: the values, both matrices, the lab rows (hooks/useRecordReads).
  const { reloadValues, refreshLabValues, loadHistory } = useRecordReads({ setPreviousMeasurements, setHistory, setLabValueHistory });
  // The lab rows on mount (AdditionalLabRows shows them under the matrix,
  // US-21), and again when the upload modal opens or closes (its review
  // matrix dedups against them).
  useEffect(() => {
    refreshLabValues();
  }, [showUploadModal, refreshLabValues]);

  // The erase the screen shows, and this tab's own erase (hooks/useErase.ts).
  // The chat's banners (a profile proposal, a medication Undo) go when the
  // screen moves to another erase, this tab's or another device's, even with
  // post-erase rows. A re-read that brings no erase keeps them.
  const { shownErase, erasing: isDeleting, showErase, eraseUnshown, refusalIsNews, eraseAll } = useErase(() => clearChatEdits());
  // A save the store refused. Outside this tab's own erase, which throws the
  // change away anyway, say so and show the record the store holds; that also
  // releases a remote change the relay held behind the edit (US-34 AC4).
  const writeRefused = useCallback(() => {
    if (!refusalIsNews()) return;
    window.alert(WRITE_REFUSED);
    clearAnswered(); // the record re-read is not an answer given here (US-62 AC13)
    void applyRemoteRef.current();
  }, []);
  // The medication, screening and supplement saves (hooks/useListSaves).
  const {
    handleMedicationChange, handleScreeningChange, handleSupplementChange, handleSupplementDelete,
    flushListSaves, dropListSaves, medicationWaiting,
  } = useListSaves({ patchMedication, patchScreening, patchSupplement, stopSupplement }, writeRefused);

  // The RoadmapStore is authoritative. Never replay the retired v1 cache into it.
  useEffect(() => {
    async function loadData() {
      // The mount's read, or a fresh one: the erase is read with the record, in one turn.
      const first = mountRead.current;
      mountRead.current = null;
      const { erase, result } = first ?? { erase: getEraseIdentity(), result: await loadLatestMeasurements() };
      showErase(erase);
      if (hasSavedRecord(result)) {
        showRecord(result);
        setPreviousMeasurements(result.previousMeasurements);
        if (result.previousMeasurements.length > 0) isFirstSaveRef.current = false;
        // Every measurement, for both matrices (fire-and-forget, so it
        // doesn't block the first render).
        loadHistory();
        // Keep the legacy mirror available to the separate storefront chat embed.
        await mirrorRecord(result);
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
  const onboarding = useOnboarding(formStage, {
    saved: previousMeasurements, medications, screenings, supplements, documents: documentHistory, labValues: labValueHistory,
  }, hasApiResponse);
  // Stable callbacks: the relay and the refused save above call them after the first commit.
  const {
    reached, epoch, fullForm, aboutYouLow, planReady,
    markAnswered, clearAnswered, isComplete, profileLeft, dismissPlanReady: leavePlanReady,
  } = onboarding;
  // A matrix's weight cell is the one matrix edit that can answer a step (US-62 AC13).
  const markMatrixWeight = useCallback((e: React.SyntheticEvent) => {
    if ((e.target as HTMLElement).closest?.('.bt-vitals-card [data-metric="weight"]')) markAnswered();
  }, [markAnswered]);
  const dismissPlanReady = useCallback(() => {
    leavePlanReady();
    // The focus stays on the page, not lost with the button.
    rootRef.current?.querySelector<HTMLElement>('.mh-title')?.focus({ preventScroll: true });
  }, [leavePlanReady]);
  // An erase closes the floating chat: its conversation belongs to the old record.
  useEffect(() => { setFloatingChatOpen(false); }, [epoch]);

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

  // The profile's save: height, sex, the birth date, the unit system (hooks/useProfileSave).
  const { flushProfile, profileTimer, markSaved, profileDirty, birthRefused, clearBirthRefused } = useProfileSave({
    inputs, inputsRef, setInputs, loaded: hasApiResponse, onClean: remoteRelay.saved, writeRefused,
  });

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

  // The first-time vitals fields' and the PSA's save, queued and debounced (hooks/useLongitudinalSave).
  const {
    handleSaveLongitudinal, scheduleLongitudinalSave, flushLongitudinalSave, commitPsa, stagePendingSave,
    cancelPendingSave, flushPendingSave, isSavingLongitudinal, fieldsSaved, psaDate, setPsaDate,
  } = useLongitudinalSave({
    inputs, setInputs, history, unitOverrides, unitSystem, reloadValues,
    flushPendingProfileSave: flushProfile, typedIn, isFirstSaveRef,
  });
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
      profileTimer.flush();
      stagePendingSave();
      // The waiting medication, screening and supplement saves, each with the
      // erase it was made against, so the write below holds them (US-06 AC13).
      flushListSaves();
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
  }, [stagePendingSave, profileTimer]);

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
  // The record shown in one step, load and every re-read: units, form, saved copy, lists (US-34 AC7).
  // `form` builds the form from the one shown, for a re-read that keeps what is being typed; `units` shows or offers its units.
  const showRecord = useCallback((result: LatestMeasurementsResult, form: (shown: Partial<HealthInputs>) => Partial<HealthInputs> = () => result.inputs, units = showUnits) => {
    units(result.inputs.unitSystem);
    setInputs(form);
    markSaved(result.inputs);
    applyLists(result);
  }, [showUnits, markSaved, applyLists]);

  const handleUploadComplete = useCallback(async () => {
    // A field the user left has its save waiting (500 ms): it starts now; its own re-read follows.
    flushPendingSave();
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
      showRecord(result, prev => {
        if (!sameRecord) return result.inputs;
        const next: Partial<HealthInputs> = typing && LONGITUDINAL_FIELDS.includes(typing) && prev[typing] !== undefined
          ? { ...result.inputs, [typing]: prev[typing] }
          : { ...result.inputs };
        for (const [field, value] of Object.entries(prev)) {
          if (inputRangeFault(field, value)) (next as Record<string, unknown>)[field] = value;
        }
        return next;
      }, sameRecord ? offerUnits : showUnits); // another erase's units show at once, never held
    }
    // Another device erased the record (US-16 AC2a / US-09): a chat banner
    // left standing would write pre-erase values into the erased record.
    showErase(erase);
  }, [reloadValues, flushPendingSave, showErase, showRecord, offerUnits, showUnits]);

  // Something wrote to the record under us — another device, or an AI
  // connector through MCP (US-34). The store has already re-read and merged;
  // re-run the same load path an upload finishes with, so the page shows the
  // new profile and values without a reload. The listener reads the form
  // through a ref, never a stale closure.
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
      && profileDirty());
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
  }, [remoteRelay, handleUploadComplete, profileDirty]);

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
  // The phone's three tabs, each keeping its own scroll (hooks/useTabs, US-20 AC6).
  const { activeTab, selectTab, tabIds } = useTabs(rootRef);

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

  // "Delete all my data": once the erase moves, the screen forgets the old
  // record, on the device and on screen. The matrices' drafts and the Lp(a)
  // check's answers too: a failed write's store holds the erased copy. Stored
  // originals go by the session's rule, never by the page (US-11 AC6).
  const handleDeleteData = useCallback(() => eraseAll(() => {
    clearLocalStorage();
    clearOffFileAfterErase();
    setInputs({});
    clearForErase();
    cancelPendingSave();
    profileTimer.cancel();
    // A save the form scheduled before the erase is pre-erase (US-16 AC2a).
    dropListSaves();
    markSaved({});
  }), [eraseAll, cancelPendingSave, profileTimer, markSaved, dropListSaves]);

  // One field's new value, from the form or the chat. A weight or waist
  // keeps the unit its caller converted it from (typedIn). One update per
  // field, so several made at once all land (US-16 AC1).
  const handleInputChange = useCallback(<K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem) => {
    if (ONBOARDING_FIELDS.includes(field)) markAnswered(); // US-62 AC13: an answer given in this tab
    if (unit) typedIn.current[field] = { value, unit };
    // The user's own sex or height outranks a chat proposal for it (US-16 AC2).
    if (field === 'sex' || field === 'heightCm') dropProfileProposal();
    if (field === 'birthYear' || field === 'birthMonth') clearBirthRefused();
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
    medicationWaiting, vitalsPrefillRef, bloodTestPrefillRef, showForm, reveal: setRevealCell,
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
    if (!isComplete() || (!emailCaptureActive && !fromBirth)) return false;
    selectTab('health');
    requestAnimationFrame(() => {
      const ready = rootRef.current?.querySelector<HTMLElement>('.mh-ready-title');
      if (ready) ready.focus({ preventScroll: true });
      else revealAndFocus(rootRef.current?.querySelector<HTMLElement>('.mh-title'), 'start', false);
    });
    return true;
  }, [emailCaptureActive, selectTab, isComplete]);

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
    onPlanReadyDismiss: planReady ? dismissPlanReady : undefined,
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
    onProfileLeft: profileLeft, onDraftsHold,
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
