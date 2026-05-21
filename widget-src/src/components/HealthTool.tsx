import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  calculateHealthResults,
  validateHealthInputs,
  getValidationErrors,
  convertValidationErrorsToUnits,
  detectUnitSystem,
  PREFILL_FIELDS,
  LONGITUDINAL_FIELDS,
  BLOOD_TEST_METRICS,
  METRIC_TO_FIELD,
  FIELD_TO_METRIC,
  medicationsToInputs,
  screeningsToInputs,
  computeFormStage,
  resolveEmailConfirmStatus,
  FIELD_METRIC_MAP,
  type HealthInputs,
  type UnitSystem,
  type MetricType,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
} from '@roadmap/health-core';
import { type ApiSupplement, type ApiLabValue } from '../lib/api';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
import { ChatSection, type ChatPrefetchData } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';
import { listConversations, loadConversation, getGuestSessionToken, clearGuestSessionToken, type ChatMessage } from '../lib/chat-api';
import { UploadModal, FloatingUploadIndicator } from './UploadModal';
import { useIsMobile, useIsWideDesktop } from '../lib/useIsMobile';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { MobileTabBar, type TabId } from './MobileTabBar';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperType } from 'swiper';
import 'swiper/css';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
  saveUnitPreference,
  loadUnitPreference,
  setAuthenticatedFlag,
  getAuthRedirectFlag,
  consumeEmailConfirmFlag,
  hasAuthenticatedFlag,
  safeSetItem,
  safeRemoveItem,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  loadAllHistory,
  loadLabValues,
  saveChangedMeasurements,
  addMeasurement,
  correctMeasurement,
  saveMedication,
  saveScreening,
  saveSupplement,
  deleteSupplementApi,
  deleteUserData,
  saveReminderPreference,
  setGlobalReminderOptout,
  sendWelcomeEmail,
  PROXY_PATH,
  trackABImpression,
  trackABConversion,
  type ApiReminderPreference,
  type ApiDocument,
} from '../lib/api';

// Auth state from Liquid template
interface AuthState {
  isLoggedIn: boolean;
  loginUrl?: string;
  accountUrl?: string;
  redirectFailed: boolean;
}

// Get auth state from DOM data attributes
function getAuthState(): AuthState {
  const root = document.getElementById('health-tool-root');
  if (!root) {
    return { isLoggedIn: false, redirectFailed: false };
  }

  const isLoggedIn = root.dataset.loggedIn === 'true';
  const loginUrl = root.dataset.loginUrl || undefined;
  const accountUrl = root.dataset.accountUrl || undefined;
  // Redirect was attempted but user is still not logged in.
  // Also require the auth flag — if it's gone (e.g. user cleared localStorage), this is a new guest.
  const redirectFailed = !isLoggedIn &&
    getAuthRedirectFlag() &&
    hasAuthenticatedFlag();
  return { isLoggedIn, loginUrl, accountUrl, redirectFailed };
}

export function HealthTool() {
  const [inputs, setInputs] = useState<Partial<HealthInputs>>(() => {
    // Pre-load prefill fields from localStorage so InputPanel's first render
    // correctly detects returning users (for Basic Information collapse).
    if (!getAuthState().isLoggedIn && hasAuthenticatedFlag()) return {};
    const cached = loadFromLocalStorage();
    if (!cached || Object.keys(cached.inputs).length === 0) return {};
    const prefill: Partial<HealthInputs> = {};
    for (const field of PREFILL_FIELDS) {
      if (cached.inputs[field] !== undefined) {
        (prefill as any)[field] = cached.inputs[field];
      }
    }
    if (cached.inputs.unitSystem) prefill.unitSystem = cached.inputs.unitSystem;
    return prefill;
  });
  const [previousMeasurements, setPreviousMeasurements] = useState<ApiMeasurement[]>([]);
  // Full blood-test history (all draws, all metrics) for the timeline-matrix UI.
  // Filtered subset of loadAllHistory(); refreshed after each blood-test save.
  const [bloodTestHistory, setBloodTestHistory] = useState<ApiMeasurement[]>([]);
  const [documentHistory, setDocumentHistory] = useState<ApiDocument[]>([]);
  const [labValueHistory, setLabValueHistory] = useState<ApiLabValue[]>([]);
  const [medications, setMedications] = useState<ApiMedication[]>([]);
  const [screenings, setScreenings] = useState<ApiScreening[]>([]);
  const [supplements, setSupplements] = useState<ApiSupplement[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasApiResponse, setHasApiResponse] = useState(false);
  // Filled by BloodTestTimeline on mount so we can flush its in-flight typed
  // values (draft + backfills) before kicking off the upload-modal flow.
  // `handleSaveLongitudinal` (legacy path) skips blood-test metrics, so without
  // this flush, typed-but-unsaved matrix values are lost when the user uploads.
  const bloodTestFlushRef = useRef<(() => Promise<void>) | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'first-saved' | 'duplicates' | 'error'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [isSavingLongitudinal, setIsSavingLongitudinal] = useState(false);
  const isSavingLongitudinalRef = useRef(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [reminderPreferences, setReminderPreferences] = useState<ApiReminderPreference[]>([]);
  const medSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const screeningSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isFirstSaveRef = useRef(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [floatingChatOpen, setFloatingChatOpen] = useState(false);
  const [chatPrefetch, setChatPrefetch] = useState<ChatPrefetchData | null>(null);
  const [uploadActive, setUploadActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, fileName: '' });

  // Clean up debounce timers on unmount to prevent stale API calls
  useEffect(() => {
    return () => {
      for (const timer of medSaveTimers.current.values()) clearTimeout(timer);
      for (const timer of screeningSaveTimers.current.values()) clearTimeout(timer);
    };
  }, []);
  const [emailConfirmStatus, setEmailConfirmStatus] = useState<'idle' | 'sent' | 'error'>(() => {
    const flag = consumeEmailConfirmFlag();
    if (flag) {
      isFirstSaveRef.current = false;
      return resolveEmailConfirmStatus(flag);
    }
    return 'idle';
  });

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
  const [authState] = useState<AuthState>(() => getAuthState());

  // Lazy-load additional lab values only when the upload modal opens —
  // they're only used by the review-matrix dedup/context columns and would
  // otherwise sit unused on every widget mount. Generation counter
  // discards stale responses if the user opens/closes the modal fast
  // enough to trigger overlapping fetches, OR if a post-upload refetch
  // (handleUploadComplete) is still in flight when the modal reopens.
  const labValuesFetchGen = useRef(0);
  useEffect(() => {
    if (!showUploadModal || !authState.isLoggedIn) return;
    const myGen = ++labValuesFetchGen.current;
    loadLabValues().then(rows => {
      // Skip null (API error) so we don't blank cached history.
      if (rows && myGen === labValuesFetchGen.current) setLabValueHistory(rows);
    }).catch(() => {});
  }, [showUploadModal, authState.isLoggedIn]);

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

  // Load full blood-test history (filtered) for the timeline-matrix UI.
  // Fire-and-forget so it doesn't block the initial render.
  const loadBloodTestHistory = () => {
    loadAllHistory(200).then(rows => {
      const bloodTestSet = new Set(BLOOD_TEST_METRICS);
      setBloodTestHistory(rows.filter(r => bloodTestSet.has(r.metricType)));
    });
  };

  // Load data on mount (from cloud if logged in, otherwise localStorage)
  useEffect(() => {
    async function loadData() {
      if (authState.isLoggedIn) {
        // Migrate guest chat if token exists (sync-embed handles this on non-widget pages)
        const guestToken = getGuestSessionToken();
        if (guestToken) {
          clearGuestSessionToken();
          setChatPrefetch(null); // clear stale guest prefetch so authenticated chat loads fresh
          fetch(`${PROXY_PATH}/api/measurements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ migrateGuestChat: guestToken }),
          }).catch(() => {});
        }

        // Phase 1: show cached data instantly
        const cached = loadFromLocalStorage();
        if (cached && Object.keys(cached.inputs).length > 0) {
          // Only load prefill fields into inputs — longitudinal values go to previousMeasurements
          // so they render as blue "previous value" labels instead of editable input values.
          const cachedPrefill: Partial<HealthInputs> = {};
          for (const field of PREFILL_FIELDS) {
            if (cached.inputs[field] !== undefined) {
              (cachedPrefill as any)[field] = cached.inputs[field];
            }
          }
          if (cached.inputs.unitSystem !== undefined) {
            cachedPrefill.unitSystem = cached.inputs.unitSystem;
          }
          setInputs(cachedPrefill);

          if (cached.previousMeasurements?.length > 0) {
            // Returning user — real previousMeasurements from last API response
            setPreviousMeasurements(cached.previousMeasurements);
          } else {
            // Guest→logged-in transition — create synthetic entries from cached longitudinal values
            // so blue "previous value" labels show immediately instead of values in input fields.
            // These are replaced by real API data in Phase 2.
            const synthetic: ApiMeasurement[] = [];
            const now = new Date().toISOString();
            for (const field of LONGITUDINAL_FIELDS) {
              const value = cached.inputs[field];
              if (value !== undefined) {
                const metricType = FIELD_TO_METRIC[field];
                if (metricType) {
                  synthetic.push({ id: `cache-${metricType}`, metricType, value: value as number, recordedAt: now, createdAt: now });
                }
              }
            }
            if (synthetic.length > 0) {
              setPreviousMeasurements(synthetic);
            }
          }

          if (cached.medications?.length > 0) {
            setMedications(cached.medications);
          }
          if (cached.screenings?.length > 0) {
            setScreenings(cached.screenings);
          }
          if (cached.reminderPreferences?.length > 0) {
            setReminderPreferences(cached.reminderPreferences);
          }
        }

        // Phase 2: API response is authoritative
        const result = await loadLatestMeasurements();

        if (result && (Object.keys(result.inputs).length > 0 || result.previousMeasurements.length > 0 || result.medications.length > 0 || result.screenings.length > 0)) {
          // User has cloud data — set flag so auto-redirect works on direct navigation
          setAuthenticatedFlag();
          // Apply saved unit preference from cloud
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
          setReminderPreferences(result.reminderPreferences);
          setDocumentHistory(result.documents);
          // Full blood-test history for the timeline-matrix UI (fire-and-forget).
          loadBloodTestHistory();
          // Cache to localStorage for instant display on next page load
          saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, result.reminderPreferences);
        } else {
          // No cloud data — sync localStorage→cloud directly.
          // (sync-embed.liquid skips when the widget is on the page, so the widget must handle this.)
          if (cached && Object.keys(cached.inputs).length > 0) {
            // Show email confirmation immediately (optimistic)
            setSaveStatus('first-saved');
            setEmailConfirmStatus('sent');
            isFirstSaveRef.current = false;

            // Sync profile (demographics + height + unitSystem)
            const profileFields: Partial<HealthInputs> = {};
            for (const field of PREFILL_FIELDS) {
              if (cached.inputs[field] !== undefined) {
                (profileFields as any)[field] = cached.inputs[field];
              }
            }
            // unitSystem may be in inputs (if user changed it) or in the separate preference key
            const cachedUnit = cached.inputs.unitSystem ?? loadUnitPreference();
            if (cachedUnit) {
              profileFields.unitSystem = cachedUnit;
            }
            let profileSaved = true;
            if (Object.keys(profileFields).length > 0) {
              profileSaved = await saveChangedMeasurements(profileFields, {});
              if (!profileSaved) {
                // Retry once — profile creation may still be committing
                profileSaved = await saveChangedMeasurements(profileFields, {});
              }
              if (!profileSaved) {
                console.warn('[HealthTool] Profile sync failed after retry');
              }
            }

            // Sync longitudinal measurements (weight, waist, bp, blood tests)
            for (const field of LONGITUDINAL_FIELDS) {
              const value = cached.inputs[field];
              if (value !== undefined) {
                const metricType = FIELD_TO_METRIC[field];
                if (metricType) {
                  await addMeasurement(metricType, value as number);
                }
              }
            }

            // Sync medications
            const cachedMeds = cached.medications ?? [];
            for (const med of cachedMeds) {
              if (med.medicationKey && med.drugName) {
                await saveMedication(med.medicationKey, med.drugName, med.doseValue, med.doseUnit);
              }
            }

            // Sync screenings
            const cachedScreenings = cached.screenings ?? [];
            for (const scr of cachedScreenings) {
              if (scr.screeningKey && scr.value) {
                await saveScreening(scr.screeningKey, scr.value);
              }
            }

            // Track A/B conversion immediately — don't gate on email success.
            // The sync path already set isFirstSaveRef = false, so the guard in
            // handleSaveLongitudinal won't double-fire.
            trackABConversion();

            // Trigger welcome email only if profile saved (needs height + sex)
            if (profileSaved) {
              sendWelcomeEmail().then(result => {
                if (!result.success) {
                  setEmailConfirmStatus('error');
                }
              }).catch(() => {
                setEmailConfirmStatus('error');
              });
            } else {
              setEmailConfirmStatus('error');
            }

            // Reload from API to get authoritative data
            const syncResult = await loadLatestMeasurements();
            if (syncResult) {
              setAuthenticatedFlag();
              setInputs(syncResult.inputs);
              previousInputsRef.current = { ...syncResult.inputs };
              setPreviousMeasurements(syncResult.previousMeasurements);
              setMedications(syncResult.medications);
              setScreenings(syncResult.screenings);
              setReminderPreferences(syncResult.reminderPreferences);
              loadBloodTestHistory();
              saveToLocalStorage(syncResult.inputs, syncResult.previousMeasurements, syncResult.medications, syncResult.screenings, syncResult.reminderPreferences);
            } else {
              previousInputsRef.current = { ...cached.inputs };
            }
          }
        }
        // Set after all branches complete so Save buttons don't flash during sync
        setHasApiResponse(true);
      } else {
        // Detect stale data from a previous logged-in session (user logged out)
        if (hasAuthenticatedFlag()) {
          clearLocalStorage();
        } else {
          const saved = loadFromLocalStorage();
          if (saved) {
            setInputs(saved.inputs);
          }
        }
        setHasApiResponse(true);
      }
    }

    loadData();
  }, [authState.isLoggedIn]);

  // Fire A/B impression once on mount
  useEffect(() => { trackABImpression(); }, []);

  // Effective inputs for results calculation: form inputs + fallback to previousMeasurements
  const effectiveInputs = useMemo(() => {
    const base = { ...inputs };
    if (authState.isLoggedIn) {
      for (const m of previousMeasurements) {
        const field = METRIC_TO_FIELD[m.metricType];
        if (field && (LONGITUDINAL_FIELDS as readonly string[]).includes(field) && base[field] === undefined) {
          (base as any)[field] = m.value;
        }
      }
    }
    return base;
  }, [inputs, previousMeasurements, authState.isLoggedIn]);

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
    listConversations().then(async (result) => {
      if (!result) return;
      let msgs: ChatMessage[] = [];
      let activeId: string | null = null;
      // For guests, auto-load the most recent conversation
      if (!authState.isLoggedIn && result.conversations.length > 0) {
        const latest = result.conversations[0];
        activeId = latest.id;
        msgs = await loadConversation(latest.id);
      }
      setChatPrefetch({
        conversations: result.conversations,
        messages: msgs,
        activeConversationId: activeId,
      });
    });
  }, [formStage, chatPrefetch, authState.isLoggedIn]);

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
    }
    return success;
  }

  // Auto-save demographics + height only (debounced)
  useEffect(() => {
    if (!hasApiResponse) return;

    const timeout = setTimeout(async () => {
      if (authState.isLoggedIn) {
        // Check if there are unsaved profile changes before showing status
        const autoSaveFields = [...PREFILL_FIELDS, 'unitSystem' as keyof HealthInputs];
        const hasChanges = autoSaveFields.some(f => inputs[f] !== previousInputsRef.current[f]);
        if (!hasChanges) return;

        setSaveStatus('saving');
        const success = await flushPendingProfileSave();
        setSaveStatus(success ? 'saved' : 'error');
        if (success) setLastSavedAt(Date.now());
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        // Guests: save everything to localStorage (including longitudinal)
        const merged = { ...effectiveInputs, ...inputs };
        if (Object.keys(merged).length > 0) {
          saveToLocalStorage(merged);
        }
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [inputs, hasApiResponse, authState.isLoggedIn, effectiveInputs]);

  // Patches local state in place: drops the old row + appends the new one with
  // the same date/metric, no network refetch. Suggestions recompute via the
  // existing `effectiveInputs` derivation off `previousMeasurements`.
  //
  // `previousMeasurements` is intentionally a no-op when `oldId` isn't the
  // latest for its metric (correcting a non-latest entry shouldn't shift the
  // latest summary). For `bloodTestHistory`, a miss means local state is
  // stale — fall back to a refetch so the corrected row appears.
  const handleCorrectBloodTestValue = useCallback(async (
    oldId: string,
    newValueSI: number,
  ): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'not_found' | 'error' }> => {
    if (!authState.isLoggedIn) return { ok: false, reason: 'error' };
    const result = await correctMeasurement(oldId, newValueSI);
    if (result.status !== 'ok') return { ok: false, reason: result.status };

    const newId = result.newId;
    const patchList = <T extends ApiMeasurement>(rows: T[]): T[] => {
      const old = rows.find(r => r.id === oldId);
      if (!old) return rows;
      const withoutOld = rows.filter(r => r.id !== oldId);
      const replacement: T = {
        ...old,
        id: newId,
        value: newValueSI,
        source: 'manual_correction',
        status: 'active',
        correctsId: oldId,
      };
      return [...withoutOld, replacement];
    };
    // Inspect `prev` inside the updater so the stale-check sees the freshest
    // state — not a closure-captured snapshot that may have been replaced by
    // a concurrent refetch while the network round-trip was in flight.
    let needsRefetch = false;
    setBloodTestHistory(prev => {
      needsRefetch = !prev.some(r => r.id === oldId);
      return patchList(prev);
    });
    setPreviousMeasurements(patchList);
    if (needsRefetch) {
      // Stale: row vanished from local history between display and click.
      // Refetch so the corrected value appears in the matrix.
      loadBloodTestHistory();
    }
    return { ok: true };
  }, [authState.isLoggedIn]);

  const handleSaveLongitudinal = useCallback(async (
    bloodTestDate?: string,
    // Optional: when provided, save these metric→SI-value pairs at the given
    // recordedAt instead of reading from the form `inputs` state. Used by the
    // BloodTestTimeline component to commit a draft batch (and back-filled
    // values into a past batch). When omitted, the legacy path runs.
    explicitMeasurements?: Record<string, number>,
  ) => {
    if (!authState.isLoggedIn) return;
    if (isSavingLongitudinalRef.current) return;
    isSavingLongitudinalRef.current = true;

    try {
      // Flush any pending profile auto-save before saving measurements.
      // This ensures height/sex are in the DB when checkAndSendWelcomeEmail
      // fires on each measurement POST (prevents race with 500ms debounce).
      await flushPendingProfileSave();

      const bloodTestMetrics = new Set(BLOOD_TEST_METRICS);
      const fieldsToSave: Array<{ metricType: string; value: number; recordedAt?: string }> = [];

      if (explicitMeasurements) {
        // Caller supplied a batch directly (bloodTestDate + metric→SI map).
        for (const [metricType, value] of Object.entries(explicitMeasurements)) {
          if (value === undefined || value === null || Number.isNaN(value)) continue;
          fieldsToSave.push({ metricType, value, recordedAt: bloodTestDate });
        }
      } else {
        // Legacy path: read from current form `inputs`. Skip blood-test
        // metrics — they're committed via BloodTestTimeline's own Save button
        // which calls this function with explicitMeasurements. Without this
        // skip, blood-test values mirrored into `inputs` (for live suggestions)
        // would double-save when the user clicks the global Save button.
        for (const field of LONGITUDINAL_FIELDS) {
          const value = inputs[field];
          if (value === undefined) continue;
          const metricType = FIELD_TO_METRIC[field];
          if (!metricType) continue;
          if (bloodTestMetrics.has(metricType)) continue;
          fieldsToSave.push({ metricType, value: value as number, recordedAt: undefined });
        }
      }

      if (fieldsToSave.length === 0) return;

      setIsSavingLongitudinal(true);
      setSaveStatus('saving');

      const results = await Promise.all(
        fieldsToSave.map(f => addMeasurement(f.metricType, f.value, f.recordedAt)),
      );
      const insertedRows = results
        .filter((r): r is { status: 'inserted'; row: ApiMeasurement } => r.status === 'inserted')
        .map(r => r.row);
      const hasError = results.some(r => r.status === 'error');
      // Duplicates are treated as success: the value is already present at
      // this timestamp. Errors are real failures and surface as 'error'.
      const allSaved = !hasError;

      if (allSaved) {
        // Update previousMeasurements (latest-per-metric) with the new values.
        // Only replace the existing entry when the saved row is newer —
        // backfilling an older date must NOT clobber the latest entry, since
        // `effectiveInputs` reads from `previousMeasurements` and would then
        // surface stale data on the Results page.
        const newMeasurements = [...previousMeasurements];
        for (const saved of insertedRows) {
          const idx = newMeasurements.findIndex(m => m.metricType === saved.metricType);
          if (idx >= 0) {
            if (saved.recordedAt > newMeasurements[idx].recordedAt) {
              newMeasurements[idx] = saved;
            }
          } else {
            newMeasurements.push(saved);
          }
        }
        setPreviousMeasurements(newMeasurements);

        // Append new blood-test rows to the full-history state so the timeline
        // matrix reflects the save without a reload.
        const savedBloodTestRows = insertedRows.filter(r => bloodTestMetrics.has(r.metricType));
        if (savedBloodTestRows.length > 0) {
          setBloodTestHistory(prev => [...prev, ...savedBloodTestRows]);
        }

        // Clear longitudinal input fields (legacy path only — when caller
        // supplied explicit values, the form `inputs` weren't used so leave them).
        if (!explicitMeasurements) {
          setInputs(prev => {
            const next = { ...prev };
            for (const field of LONGITUDINAL_FIELDS) {
              delete (next as any)[field];
            }
            return next;
          });
        }

        // Track A/B conversion on first-ever save (covers direct logged-in users
        // who skip the guest→login sync path).
        if (isFirstSaveRef.current) {
          trackABConversion();
        }
        isFirstSaveRef.current = false;
        // Distinguish "saved fresh" from "all dupes" — same DB end-state, but
        // the toast wording should reflect that nothing actually changed.
        setSaveStatus(insertedRows.length === 0 ? 'duplicates' : 'saved');
        setLastSavedAt(Date.now());
        setIsSavingLongitudinal(false);
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
        setIsSavingLongitudinal(false);
        setTimeout(() => setSaveStatus('idle'), 2000);
      }
    } finally {
      isSavingLongitudinalRef.current = false;
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements]);

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
    longitudinalDebounce.flush();
  }, [longitudinalDebounce]);

  // Tab-close safety net: flush any pending debounced saves before the
  // page unloads so a "typed then closed" edit doesn't get lost.
  useEffect(() => {
    if (!authState.isLoggedIn) return;
    const onUnload = () => {
      longitudinalDebounce.flush();
      bloodTestFlushRef.current?.();
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [authState.isLoggedIn, longitudinalDebounce]);

  // Save any unsaved longitudinal values (weight, BP, etc.) then refresh from API.
  // Called when the upload modal opens — ensures typed-but-unsaved values persist.
  const handleUploadStart = useCallback(async () => {
    if (!authState.isLoggedIn) return;
    // Flush BloodTestTimeline's in-flight draft + backfills BEFORE the legacy
    // save runs. Sequential (not parallel): handleSaveLongitudinal has a
    // re-entry guard (isSavingLongitudinalRef) and the matrix flush also goes
    // through it (via onSaveBatch → handleSaveLongitudinal with explicit args),
    // so a parallel run would short-circuit one of them.
    if (bloodTestFlushRef.current) {
      try { await bloodTestFlushRef.current(); }
      catch { /* swallow — best-effort flush, legacy save still runs below */ }
    }
    await handleSaveLongitudinal();
  }, [authState.isLoggedIn, handleSaveLongitudinal]);

  // Refresh state after upload bulk save (lab values + documents)
  const handleUploadComplete = useCallback(async () => {
    const result = await loadLatestMeasurements();
    if (result) {
      setInputs(result.inputs);
      previousInputsRef.current = { ...result.inputs };
      setPreviousMeasurements(result.previousMeasurements);
      setMedications(result.medications);
      setScreenings(result.screenings);
      setReminderPreferences(result.reminderPreferences);
      setDocumentHistory(result.documents);
      saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, result.reminderPreferences);
    }
    // labValues are lazy — refresh now so the next modal-open shows the
    // values this upload just saved without an extra round-trip. Bump the
    // gen counter so a stale post-upload fetch can't overwrite a fresh
    // modal-open fetch that started later.
    const myGen = ++labValuesFetchGen.current;
    loadLabValues().then(rows => {
      if (rows && myGen === labValuesFetchGen.current) setLabValueHistory(rows);
    }).catch(() => {});
    // Refresh full blood-test history so the matrix reflects newly extracted lab rows.
    loadBloodTestHistory();
  }, []);

  // Convert field-keyed overrides to MetricType-keyed for health-core + ResultsPanel
  const metricUnitOverrides = useMemo(() => {
    const m: Partial<Record<MetricType, UnitSystem>> = {};
    for (const [field, fieldUs] of Object.entries(unitOverrides)) {
      const metric = FIELD_METRIC_MAP[field];
      if (metric) m[metric] = fieldUs;
    }
    return Object.keys(m).length > 0 ? m : undefined;
  }, [unitOverrides]);

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

  // Sync tab button clicks → Swiper
  useEffect(() => {
    const index = activeTab === 'input' ? 0 : activeTab === 'plan' ? 1 : 2;
    if (swiperRef.current && swiperRef.current.activeIndex !== index) {
      swiperRef.current.slideTo(index);
    }
  }, [activeTab]);

  // Re-measure Swiper autoHeight when slide content changes
  useEffect(() => {
    if (swiperRef.current) {
      swiperRef.current.updateAutoHeight();
    }
  }, [formStage, supplements, documentHistory]);

  const handleReminderPreferenceChange = useCallback(async (category: string, enabled: boolean) => {
    // Optimistic update
    setReminderPreferences(prev => {
      const idx = prev.findIndex(p => p.reminderCategory === category);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], enabled };
        return next;
      }
      return [...prev, { reminderCategory: category, enabled }];
    });

    if (authState.isLoggedIn) {
      await saveReminderPreference(category, enabled);
    }
  }, [authState.isLoggedIn]);

  const handleGlobalReminderOptout = useCallback(async () => {
    if (!authState.isLoggedIn) return;
    const confirmed = window.confirm(
      'This will disable all health reminder emails. You can re-enable them anytime. Continue?',
    );
    if (!confirmed) return;

    // Optimistic: mark all as disabled
    setReminderPreferences(prev => prev.map(p => ({ ...p, enabled: false })));
    await setGlobalReminderOptout(true);
  }, [authState.isLoggedIn]);

  const handleDeleteData = useCallback(async () => {
    if (!authState.isLoggedIn) return;
    const confirmed = window.confirm(
      'This will permanently delete all your health data and measurements. This action cannot be undone. Are you sure?',
    );
    if (!confirmed) return;

    setIsDeleting(true);
    const result = await deleteUserData();
    setIsDeleting(false);

    if (result.success) {
      clearLocalStorage();
      setInputs({});
      setPreviousMeasurements([]);
      setBloodTestHistory([]);
      setMedications([]);
      setScreenings([]);
      setReminderPreferences([]);
      previousInputsRef.current = {};
      setSaveStatus('idle');
      window.alert('All your health data has been deleted.');
    } else {
      window.alert(result.error || 'Failed to delete data. Please try again.');
    }
  }, [authState.isLoggedIn]);

  const handleInputChange = (newInputs: Partial<HealthInputs>) => {
    setInputs(newInputs);
    window.dispatchEvent(new CustomEvent('hr:inputs-changed'));
  };

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
      saveToLocalStorage(inputs, previousMeasurements, next, screenings, reminderPreferences);

      return next;
    });

    // Debounce cloud save per medication_key to prevent race conditions
    // when rapid dropdown changes fire multiple concurrent API calls
    if (authState.isLoggedIn) {
      const existing = medSaveTimers.current.get(medicationKey);
      if (existing) clearTimeout(existing);
      medSaveTimers.current.set(medicationKey, setTimeout(() => {
        medSaveTimers.current.delete(medicationKey);
        saveMedication(medicationKey, drugName, doseValue, doseUnit);
      }, 300));
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements, screenings, reminderPreferences]);

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

      saveToLocalStorage(inputs, previousMeasurements, medications, next, reminderPreferences);

      return next;
    });

    if (authState.isLoggedIn) {
      const existing = screeningSaveTimers.current.get(screeningKey);
      if (existing) clearTimeout(existing);
      screeningSaveTimers.current.set(screeningKey, setTimeout(() => {
        screeningSaveTimers.current.delete(screeningKey);
        saveScreening(screeningKey, value);
      }, 300));
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements, medications, reminderPreferences]);

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

    if (authState.isLoggedIn) {
      const existing = supSaveTimers.current.get(supplementKey);
      if (existing) clearTimeout(existing);
      supSaveTimers.current.set(supplementKey, setTimeout(() => {
        supSaveTimers.current.delete(supplementKey);
        saveSupplement(supplementKey, supplementName, doseValue, doseUnit, status, startedAt);
      }, 300));
    }
  }, [authState.isLoggedIn]);

  const handleSupplementDelete = useCallback((supplementKey: string) => {
    setSupplements(prev => prev.filter(s => s.supplementKey !== supplementKey));
    if (authState.isLoggedIn) {
      deleteSupplementApi(supplementKey);
    }
  }, [authState.isLoggedIn]);

  const handleAutoFocusEmail = useCallback(() => {
    if (authState.isLoggedIn) return;
    if (isMobile) {
      setActiveTab('plan');
      setTimeout(() => document.getElementById('guestEmail')?.focus(), 400);
    } else {
      document.getElementById('guestEmail')?.focus();
    }
  }, [authState.isLoggedIn, isMobile]);

  // Memoised so the UploadModal's matrix doesn't rebuild on unrelated
  // HealthTool re-renders (typing, mobile-tab switches, etc.).
  const uploadHistory = useMemo(
    () => ({ bloodTests: bloodTestHistory, labValues: labValueHistory, documents: documentHistory }),
    [bloodTestHistory, labValueHistory, documentHistory],
  );

  const inputPanelProps = {
    inputs,
    onChange: handleInputChange,
    errors,
    unitSystem,
    onUnitSystemChange: handleUnitSystemChange,
    unitOverrides,
    onToggleFieldUnit: handleToggleFieldUnit,
    isLoggedIn: authState.isLoggedIn,
    previousMeasurements,
    bloodTestHistory,
    onSaveBloodTestBatch: (date: string, values: Record<string, number>) =>
      handleSaveLongitudinal(date, values),
    onCorrectBloodTestValue: handleCorrectBloodTestValue,
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
    hasApiResponse,
    bloodTestFlushRef,
    formStage,
    lastSavedAt,
    setShowUploadModal,
    loginUrl: authState.loginUrl,
    activeSuggestionIds,
    healthDocuments: documentHistory,
    onDocumentDeleted: (docId: string) => {
      setDocumentHistory(prev => prev.filter(d => d.id !== docId));
    },
    onAutoFocusEmail: handleAutoFocusEmail,
  };

  const resultsPanelProps = {
    results,
    isValid,
    authState,
    saveStatus,
    emailConfirmStatus,
    unitSystem,
    unitOverrides: metricUnitOverrides,
    hasUnsavedLongitudinal: authState.isLoggedIn && hasApiResponse && LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined),
    onSaveLongitudinal: handleSaveLongitudinal,
    isSavingLongitudinal,
    onDeleteData: handleDeleteData,
    isDeleting,
    redirectFailed: authState.redirectFailed,
    reminderPreferences,
    onReminderPreferenceChange: handleReminderPreferenceChange,
    onGlobalReminderOptout: handleGlobalReminderOptout,
    sex: inputs.sex,
    guestReportData: !authState.isLoggedIn ? { inputs: effectiveInputs, medications, screenings } : undefined,
    formStage,
  };

  const chatSectionProps = {
    isLoggedIn: authState.isLoggedIn,
    guestInputs: !authState.isLoggedIn ? { ...effectiveInputs, unitSystem, medications, screenings } : null,
    prefetchedData: chatPrefetch,
  };

  return (
    <div className="health-tool">
      {isMobile ? (
        <>
          <MobileTabBar activeTab={activeTab} onTabChange={setActiveTab} />
          <Swiper
            autoHeight
            touchStartPreventDefault={false}
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
              />
            </div>
          )}
        </div>
      )}

      {(showUploadModal || uploadActive) && authState.isLoggedIn && (
        <UploadModal
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
          hidden={!showUploadModal && uploadActive}
          onProcessingStart={() => setUploadActive(true)}
          onProcessingEnd={(autoReopen) => {
            setUploadActive(false);
            if (autoReopen) setShowUploadModal(true);
          }}
          onProgressUpdate={setUploadProgress}
        />
      )}

      {!showUploadModal && uploadActive && (
        <FloatingUploadIndicator
          progress={uploadProgress}
          onClick={() => setShowUploadModal(true)}
        />
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
