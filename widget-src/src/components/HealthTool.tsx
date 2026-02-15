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
  type HealthInputs,
  type UnitSystem,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
} from '@roadmap/health-core';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
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
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isSavingLongitudinal, setIsSavingLongitudinal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [reminderPreferences, setReminderPreferences] = useState<ApiReminderPreference[]>([]);

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
          setInputs(cached.inputs);
          if (cached.previousMeasurements.length > 0) {
            setPreviousMeasurements(cached.previousMeasurements);
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
        setHasApiResponse(true);

        if (result && (Object.keys(result.inputs).length > 0 || result.previousMeasurements.length > 0)) {
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
          setMedications(result.medications);
          setScreenings(result.screenings);
          setReminderPreferences(result.reminderPreferences);
          // Cache to localStorage for instant display on next page load
          saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, result.reminderPreferences);
        } else {
          // No cloud data — sync-embed.liquid handles localStorage→cloud migration.
          // Just track current inputs so auto-save doesn't re-send them.
          if (cached && Object.keys(cached.inputs).length > 0) {
            previousInputsRef.current = { ...cached.inputs };
          }
        }
      } else {
        const saved = loadFromLocalStorage();
        if (saved) {
          setInputs(saved.inputs);
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

  // Auto-save demographics + height only (debounced)
  useEffect(() => {
    if (!hasApiResponse) return;

    const timeout = setTimeout(async () => {
      if (authState.isLoggedIn) {
        // Only auto-save pre-fill fields (demographics + height)
        const currentPrefill: Partial<HealthInputs> = {};
        const previousPrefill: Partial<HealthInputs> = {};
        for (const field of PREFILL_FIELDS) {
          if (inputs[field] !== undefined) (currentPrefill as any)[field] = inputs[field];
          if (previousInputsRef.current[field] !== undefined) (previousPrefill as any)[field] = previousInputsRef.current[field];
        }

        const hasChanges = PREFILL_FIELDS.some(f => inputs[f] !== previousInputsRef.current[f]);
        if (!hasChanges) return;

        setSaveStatus('saving');
        const success = await saveChangedMeasurements(currentPrefill, previousPrefill);
        setSaveStatus(success ? 'saved' : 'error');
        if (success) {
          for (const field of PREFILL_FIELDS) {
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

      setSaveStatus('saved');
    } else {
      setSaveStatus('error');
    }

    setIsSavingLongitudinal(false);
    setTimeout(() => setSaveStatus('idle'), 2000);
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

  const handleMedicationChange = useCallback(async (
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

    // Save to cloud if logged in
    if (authState.isLoggedIn) {
      await saveMedication(medicationKey, drugName, doseValue, doseUnit);
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements, screenings, reminderPreferences]);

  const handleScreeningChange = useCallback(async (screeningKey: string, value: string) => {
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
      await saveScreening(screeningKey, value);
    }
  }, [authState.isLoggedIn, inputs, previousMeasurements, medications, reminderPreferences]);

  return (
    <div className="health-tool">
      <div className="health-tool-header">
        <h2>Health Roadmap Tool</h2>
        <p>
          Enter your health information below to receive personalized
          suggestions to discuss with your healthcare provider.
        </p>
      </div>

      <div className="health-tool-content">
        <div className="health-tool-left">
          <InputPanel
            inputs={inputs}
            onChange={handleInputChange}
            errors={errors}
            unitSystem={unitSystem}
            onUnitSystemChange={handleUnitSystemChange}
            isLoggedIn={authState.isLoggedIn}
            previousMeasurements={previousMeasurements}
            medications={medications}
            onMedicationChange={handleMedicationChange}
            screenings={screenings}
            onScreeningChange={handleScreeningChange}
            onSaveLongitudinal={handleSaveLongitudinal}
            isSavingLongitudinal={isSavingLongitudinal}
          />
        </div>

        <div className="health-tool-right">
          <ResultsPanel
            results={results}
            isValid={isValid}
            authState={authState}
            saveStatus={saveStatus}
            unitSystem={unitSystem}
            hasUnsavedLongitudinal={authState.isLoggedIn && LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined)}
            onSaveLongitudinal={handleSaveLongitudinal}
            isSavingLongitudinal={isSavingLongitudinal}
            onDeleteData={handleDeleteData}
            isDeleting={isDeleting}
            redirectFailed={authState.redirectFailed}
            reminderPreferences={reminderPreferences}
            onReminderPreferenceChange={handleReminderPreferenceChange}
            onGlobalReminderOptout={handleGlobalReminderOptout}
            sex={inputs.sex}
          />
        </div>
      </div>
    </div>
  );
}
