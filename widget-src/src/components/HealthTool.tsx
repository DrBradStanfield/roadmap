import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  calculateHealthResults,
  validateHealthInputs,
  getValidationErrors,
  detectUnitSystem,
  PREFILL_FIELDS,
  LONGITUDINAL_FIELDS,
  METRIC_TO_FIELD,
  FIELD_TO_METRIC,
  type HealthInputs,
  type UnitSystem,
  type ApiMeasurement,
} from '@roadmap/health-core';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
  saveUnitPreference,
  loadUnitPreference,
} from '../lib/storage';
import {
  loadLatestMeasurements,
  saveChangedMeasurements,
  addMeasurement,
} from '../lib/api';

// Auth state from Liquid template
interface AuthState {
  isLoggedIn: boolean;
  loginUrl?: string;
}

// Get auth state from DOM data attributes
function getAuthState(): AuthState {
  const root = document.getElementById('health-tool-root');
  if (!root) {
    return { isLoggedIn: false };
  }

  const isLoggedIn = root.dataset.loggedIn === 'true';
  const loginUrl = root.dataset.loginUrl || undefined;
  return { isLoggedIn, loginUrl };
}

export function HealthTool() {
  const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
  const [previousMeasurements, setPreviousMeasurements] = useState<ApiMeasurement[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isSavingLongitudinal, setIsSavingLongitudinal] = useState(false);

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
        const result = await loadLatestMeasurements();
        const localData = loadFromLocalStorage();

        if (result && (Object.keys(result.inputs).length > 0 || result.previousMeasurements.length > 0)) {
          // Apply saved unit preference from cloud
          const unitPref = result.inputs.unitSystem;
          if (unitPref === 'si' || unitPref === 'conventional') {
            setUnitSystem(unitPref);
            saveUnitPreference(unitPref);
          }
          // Only pre-fill demographic/height fields; longitudinal fields start empty
          setInputs(result.inputs);
          previousInputsRef.current = { ...result.inputs };
          setPreviousMeasurements(result.previousMeasurements);
          if (localData && Object.keys(localData).length > 0) {
            clearLocalStorage();
          }
        } else if (localData && Object.keys(localData).length > 0) {
          setInputs(localData);
          // Explicitly sync localStorage data to cloud on first login
          const synced = await saveChangedMeasurements(localData, {});
          if (synced) {
            previousInputsRef.current = { ...localData };
            clearLocalStorage();
          } else {
            previousInputsRef.current = {};
          }
        }
      } else {
        const saved = loadFromLocalStorage();
        if (saved) {
          setInputs(saved);
        }
      }
      setHasLoadedData(true);
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
    if (!hasLoadedData) return;

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
        saveToLocalStorage({ ...effectiveInputs, ...inputs });
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [inputs, hasLoadedData, authState.isLoggedIn, effectiveInputs]);

  // Explicit save for longitudinal fields
  const handleSaveLongitudinal = useCallback(async () => {
    if (!authState.isLoggedIn) return;

    const fieldsToSave: Array<{ metricType: string; value: number }> = [];
    for (const field of LONGITUDINAL_FIELDS) {
      const value = inputs[field];
      if (value !== undefined) {
        const metricType = FIELD_TO_METRIC[field];
        if (metricType) {
          fieldsToSave.push({ metricType, value: value as number });
        }
      }
    }

    if (fieldsToSave.length === 0) return;

    setIsSavingLongitudinal(true);
    setSaveStatus('saving');

    const results = await Promise.all(
      fieldsToSave.map(f => addMeasurement(f.metricType, f.value)),
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
  const { results, isValid } = useMemo(() => {
    if (!effectiveInputs.heightCm || !effectiveInputs.sex) {
      return { results: null, isValid: false };
    }

    const validation = validateHealthInputs(effectiveInputs);

    if (!validation.success && validation.errors) {
      setErrors(getValidationErrors(validation.errors));
      return { results: null, isValid: false };
    }

    setErrors({});
    const healthResults = calculateHealthResults(effectiveInputs as HealthInputs, unitSystem);
    return { results: healthResults, isValid: true };
  }, [effectiveInputs, unitSystem]);

  const handleInputChange = (newInputs: Partial<HealthInputs>) => {
    setInputs(newInputs);
  };

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
          />
        </div>
      </div>
    </div>
  );
}
