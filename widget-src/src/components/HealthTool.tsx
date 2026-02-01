import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  calculateHealthResults,
  validateHealthInputs,
  getValidationErrors,
  detectUnitSystem,
  type HealthInputs,
  type UnitSystem,
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
import { loadLatestMeasurements, saveChangedMeasurements } from '../lib/api';

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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Unit system: load saved preference or auto-detect
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => {
    return loadUnitPreference() ?? detectUnitSystem();
  });

  // Track previously saved inputs to only save changed fields
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
        const cloudData = await loadLatestMeasurements();
        const localData = loadFromLocalStorage();

        if (cloudData && Object.keys(cloudData).length > 0) {
          // Apply saved unit preference from cloud
          if (cloudData.unitSystem === 'si' || cloudData.unitSystem === 'conventional') {
            setUnitSystem(cloudData.unitSystem);
            saveUnitPreference(cloudData.unitSystem);
          }
          setInputs(cloudData);
          previousInputsRef.current = cloudData;
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

  // Save data whenever inputs change (debounced)
  useEffect(() => {
    if (!hasLoadedData) return;

    const timeout = setTimeout(async () => {
      if (authState.isLoggedIn) {
        setSaveStatus('saving');
        const success = await saveChangedMeasurements(inputs, previousInputsRef.current);
        setSaveStatus(success ? 'saved' : 'error');
        if (success) {
          previousInputsRef.current = { ...inputs };
        }
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        saveToLocalStorage(inputs);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [inputs, hasLoadedData, authState.isLoggedIn]);

  // Calculate results whenever inputs change
  const { results, isValid } = useMemo(() => {
    if (!inputs.heightCm || !inputs.sex) {
      return { results: null, isValid: false };
    }

    const validation = validateHealthInputs(inputs);

    if (!validation.success && validation.errors) {
      setErrors(getValidationErrors(validation.errors));
      return { results: null, isValid: false };
    }

    setErrors({});
    const healthResults = calculateHealthResults(inputs as HealthInputs, unitSystem);
    return { results: healthResults, isValid: true };
  }, [inputs, unitSystem]);

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
