import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  calculateAge,
  calculateBMI,
  LIPID_TREATMENT_TARGETS,
  HBA1C_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  BP_THRESHOLDS,
  computeFormStage,
  type HealthInputs,
  type UnitSystem,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
} from '@roadmap/health-core';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
import { useIsMobile } from '../lib/useIsMobile';
import { MobileTabBar, MobileTabNav, type TabId, type Tab } from './MobileTabBar';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
  saveUnitPreference,
  loadUnitPreference,
  setAuthenticatedFlag,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  saveChangedMeasurements,
  addMeasurement,
  saveMedication,
  saveScreening,
  deleteUserData,
  saveReminderPreference,
  setGlobalReminderOptout,
  PROXY_PATH,
  type ApiReminderPreference,
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
    !!window.sessionStorage?.getItem('health_roadmap_auth_redirect') &&
    !!window.localStorage?.getItem('health_roadmap_authenticated');
  return { isLoggedIn, loginUrl, accountUrl, redirectFailed };
}

export function HealthTool() {
  const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
  const [previousMeasurements, setPreviousMeasurements] = useState<ApiMeasurement[]>([]);
  const [medications, setMedications] = useState<ApiMedication[]>([]);
  const [screenings, setScreenings] = useState<ApiScreening[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasApiResponse, setHasApiResponse] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'first-saved' | 'error'>('idle');
  const [isSavingLongitudinal, setIsSavingLongitudinal] = useState(false);
  const isSavingLongitudinalRef = useRef(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [reminderPreferences, setReminderPreferences] = useState<ApiReminderPreference[]>([]);
  const medSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const screeningSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isFirstSaveRef = useRef(true);

  // Unit system: load saved preference or auto-detect
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => {
    return loadUnitPreference() ?? detectUnitSystem();
  });

  // Track previously saved inputs to only save changed fields (demographics + height only)
  const previousInputsRef = useRef<Partial<HealthInputs>>({});

  // Get auth state once on mount
  const [authState] = useState<AuthState>(() => getAuthState());

  // Handle unit system change — save to localStorage and to inputs (for cloud sync)
  const handleUnitSystemChange = useCallback((system: UnitSystem) => {
    setUnitSystem(system);
    saveUnitPreference(system);
    setInputs(prev => ({ ...prev, unitSystem: system }));
  }, []);

  // Load data on mount (from cloud if logged in, otherwise localStorage)
  useEffect(() => {
    async function loadData() {
      if (authState.isLoggedIn) {
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

          if (cached.previousMeasurements.length > 0) {
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

          if (cached.medications.length > 0) {
            setMedications(cached.medications);
          }
          if (cached.screenings.length > 0) {
            setScreenings(cached.screenings);
          }
          if (cached.reminderPreferences.length > 0) {
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
          setReminderPreferences(result.reminderPreferences);
          // Cache to localStorage for instant display on next page load
          saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, result.reminderPreferences);
        } else {
          // No cloud data — sync localStorage→cloud directly.
          // (sync-embed.liquid skips when the widget is on the page, so the widget must handle this.)
          if (cached && Object.keys(cached.inputs).length > 0) {
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
            if (Object.keys(profileFields).length > 0) {
              await saveChangedMeasurements(profileFields, {});
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

            // Trigger welcome email (fire-and-forget)
            fetch(`${PROXY_PATH}/api/measurements`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sendWelcomeEmail: true }),
            }).catch(() => {});

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
              saveToLocalStorage(syncResult.inputs, syncResult.previousMeasurements, syncResult.medications, syncResult.screenings, syncResult.reminderPreferences);
              // Show email confirmation after sync (welcome email just fired)
              setSaveStatus('first-saved');
              isFirstSaveRef.current = false;
              setTimeout(() => setSaveStatus('idle'), 4000);
            } else {
              previousInputsRef.current = { ...cached.inputs };
            }
          }
        }
        // Set after all branches complete so Save buttons don't flash during sync
        setHasApiResponse(true);
      } else {
        // Detect stale data from a previous logged-in session (user logged out)
        if (localStorage.getItem('health_roadmap_authenticated')) {
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

  // Progressive disclosure: compute which stage of the form to show
  const formStage = useMemo(() => computeFormStage(effectiveInputs), [effectiveInputs]);

  // Auto-save demographics + height only (debounced)
  useEffect(() => {
    if (!hasApiResponse) return;

    const timeout = setTimeout(async () => {
      if (authState.isLoggedIn) {
        // Only auto-save pre-fill fields (demographics + height) + unitSystem
        const autoSaveFields = [...PREFILL_FIELDS, 'unitSystem' as keyof HealthInputs];
        const currentPrefill: Partial<HealthInputs> = {};
        const previousPrefill: Partial<HealthInputs> = {};
        for (const field of autoSaveFields) {
          if (inputs[field] !== undefined) (currentPrefill as any)[field] = inputs[field];
          if (previousInputsRef.current[field] !== undefined) (previousPrefill as any)[field] = previousInputsRef.current[field];
        }

        const hasChanges = autoSaveFields.some(f => inputs[f] !== previousInputsRef.current[f]);
        if (!hasChanges) return;

        setSaveStatus('saving');
        const success = await saveChangedMeasurements(currentPrefill, previousPrefill);
        setSaveStatus(success ? 'saved' : 'error');
        if (success) {
          for (const field of autoSaveFields) {
            (previousInputsRef.current as any)[field] = inputs[field];
          }
        }
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

  // Explicit save for longitudinal fields
  // bloodTestDate is an ISO string (e.g., "2026-01-01T00:00:00.000Z") for blood test metrics
  const handleSaveLongitudinal = useCallback(async (bloodTestDate?: string) => {
    if (!authState.isLoggedIn) return;
    if (isSavingLongitudinalRef.current) return;
    isSavingLongitudinalRef.current = true;

    try {
      const bloodTestMetrics = new Set(BLOOD_TEST_METRICS);
      const fieldsToSave: Array<{ metricType: string; value: number; recordedAt?: string }> = [];
      for (const field of LONGITUDINAL_FIELDS) {
        const value = inputs[field];
        if (value !== undefined) {
          const metricType = FIELD_TO_METRIC[field];
          if (metricType) {
            // Use bloodTestDate for blood test metrics, undefined (server uses NOW) for body measurements
            const recordedAt = bloodTestMetrics.has(metricType) ? bloodTestDate : undefined;
            fieldsToSave.push({ metricType, value: value as number, recordedAt });
          }
        }
      }

      if (fieldsToSave.length === 0) return;

      setIsSavingLongitudinal(true);
      setSaveStatus('saving');

      const results = await Promise.all(
        fieldsToSave.map(f => addMeasurement(f.metricType, f.value, f.recordedAt)),
      );
      const allSaved = results.every(r => r !== null);

      if (allSaved) {
        // Update previousMeasurements with the new values
        const newMeasurements = [...previousMeasurements];
        for (const saved of results) {
          if (saved) {
            const idx = newMeasurements.findIndex(m => m.metricType === saved.metricType);
            if (idx >= 0) {
              newMeasurements[idx] = saved;
            } else {
              newMeasurements.push(saved);
            }
          }
        }
        setPreviousMeasurements(newMeasurements);

        // Clear longitudinal input fields
        setInputs(prev => {
          const next = { ...prev };
          for (const field of LONGITUDINAL_FIELDS) {
            delete (next as any)[field];
          }
          return next;
        });

        const wasFirstSave = isFirstSaveRef.current;
        setSaveStatus(wasFirstSave ? 'first-saved' : 'saved');
        isFirstSaveRef.current = false;

        setIsSavingLongitudinal(false);
        setTimeout(() => setSaveStatus('idle'), wasFirstSave ? 4000 : 2000);
      } else {
        setSaveStatus('error');
        setIsSavingLongitudinal(false);
        setTimeout(() => setSaveStatus('idle'), 2000);
      }
    } finally {
      isSavingLongitudinalRef.current = false;
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements]);

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
    );
    return { results: healthResults, isValid: true, validationErrors: errors };
  }, [effectiveInputs, unitSystem, medications, screenings]);

  useEffect(() => {
    setErrors(validationErrors ?? {});
  }, [validationErrors]);

  // Mobile tab state
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<TabId>('profile');


  // Compute which tabs are visible (medications + screening are conditional)
  const tabs: Tab[] = useMemo(() => {
    // Medications visible: lipids elevated OR weight cascade trigger
    const ei = effectiveInputs;
    const nonHdl = (ei.totalCholesterol !== undefined && ei.hdlC !== undefined)
      ? ei.totalCholesterol - ei.hdlC : undefined;
    const lipidsElevated =
      (ei.apoB !== undefined && ei.apoB > LIPID_TREATMENT_TARGETS.apobGl) ||
      (ei.ldlC !== undefined && ei.ldlC > LIPID_TREATMENT_TARGETS.ldlMmol) ||
      (nonHdl !== undefined && nonHdl > LIPID_TREATMENT_TARGETS.nonHdlMmol);

    const bmi = (ei.weightKg !== undefined && ei.heightCm !== undefined)
      ? calculateBMI(ei.weightKg, ei.heightCm) : undefined;
    const whr = (ei.waistCm !== undefined && ei.heightCm !== undefined)
      ? ei.waistCm / ei.heightCm : undefined;
    let weightCascadeVisible = false;
    if (bmi !== undefined && bmi > 25) {
      if (bmi > 28) {
        weightCascadeVisible = true;
      } else {
        weightCascadeVisible =
          (ei.hba1c !== undefined && ei.hba1c >= HBA1C_THRESHOLDS.prediabetes) ||
          (ei.triglycerides !== undefined && ei.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline) ||
          (ei.systolicBp !== undefined && ei.systolicBp >= BP_THRESHOLDS.stage1Sys) ||
          (whr !== undefined && whr >= 0.5);
      }
    }
    const medsVisible = lipidsElevated || weightCascadeVisible;

    // Screening visible: birthYear set + age-based eligibility
    let screeningVisible = false;
    if (inputs.birthYear) {
      const age = calculateAge(inputs.birthYear, inputs.birthMonth ?? 1);
      screeningVisible =
        age >= 35 ||
        (inputs.sex === 'female' && age >= 25) ||
        (inputs.sex === 'female' && age >= 40) ||
        (age >= 50 && age <= 80) ||
        (inputs.sex === 'male' && age >= 45) ||
        (inputs.sex === 'female' && age >= 45) ||
        (inputs.sex === 'female' && age >= 50) || // DEXA
        (inputs.sex === 'male' && age >= 70);     // DEXA
    }

    return [
      { id: 'profile', label: 'Profile', visible: true },
      { id: 'vitals', label: 'Vitals', visible: formStage >= 3 },
      { id: 'blood-tests', label: 'Blood Tests', visible: formStage >= 4 },
      { id: 'medications', label: 'Medications', visible: formStage >= 4 && medsVisible },
      { id: 'screening', label: 'Screening', visible: formStage >= 4 && screeningVisible },
      { id: 'results', label: 'Results', visible: true },
    ];
  }, [effectiveInputs, inputs.birthYear, inputs.birthMonth, inputs.sex, formStage]);

  // Auto-fallback: if active tab becomes invisible, switch to first visible tab
  useEffect(() => {
    const current = tabs.find(t => t.id === activeTab);
    if (current && !current.visible) {
      const firstVisible = tabs.find(t => t.visible);
      if (firstVisible) setActiveTab(firstVisible.id);
    }
  }, [tabs, activeTab]);

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
    const success = await deleteUserData();
    setIsDeleting(false);

    if (success) {
      clearLocalStorage();
      setInputs({});
      setPreviousMeasurements([]);
      setMedications([]);
      setScreenings([]);
      setReminderPreferences([]);
      previousInputsRef.current = {};
      setSaveStatus('idle');
      window.alert('All your health data has been deleted.');
    } else {
      window.alert('Failed to delete data. Please try again.');
    }
  }, [authState.isLoggedIn]);

  const handleInputChange = (newInputs: Partial<HealthInputs>) => {
    setInputs(newInputs);
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

  const inputPanelProps = {
    inputs,
    onChange: handleInputChange,
    errors,
    unitSystem,
    onUnitSystemChange: handleUnitSystemChange,
    isLoggedIn: authState.isLoggedIn,
    previousMeasurements,
    medications,
    onMedicationChange: handleMedicationChange,
    screenings,
    onScreeningChange: handleScreeningChange,
    onSaveLongitudinal: handleSaveLongitudinal,
    isSavingLongitudinal,
    hasApiResponse,
    formStage,
  };

  const resultsPanelProps = {
    results,
    isValid,
    authState,
    saveStatus,
    unitSystem,
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
  };

  return (
    <div className="health-tool">
      <div className="health-tool-header">
        <h2>Health Roadmap - How to Look Young and Feel Strong</h2>
        <p>
          Enter your health information below to receive personalized
          suggestions to discuss with your healthcare provider.
        </p>
      </div>

      {isMobile ? (
        <>
          <MobileTabBar tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          <div className="mobile-tab-content">
            {activeTab === 'results' ? (
              <div className="health-tool-right">
                <ResultsPanel {...resultsPanelProps} />
              </div>
            ) : (
              <InputPanel {...inputPanelProps} mobileActiveTab={activeTab} />
            )}
            <MobileTabNav tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
            {activeTab !== 'results' && (
              <button
                className="btn-primary mobile-view-results-btn"
                onClick={() => setActiveTab('results')}
              >
                View Results
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="health-tool-content">
          <div className="health-tool-left">
            <InputPanel {...inputPanelProps} />
          </div>
          <div className="health-tool-right">
            <ResultsPanel {...resultsPanelProps} />
          </div>
        </div>
      )}
    </div>
  );
}
