import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  calculateHealthResults,
  validateHealthInputs,
  getValidationErrors,
  type HealthInputs,
} from '@roadmap/health-core';
import { InputPanel } from './InputPanel';
import { ResultsPanel } from './ResultsPanel';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
  hasStoredData,
} from '../lib/storage';
import { loadCloudProfile, saveCloudProfile, migrateLocalData } from '../lib/api';

// Auth state from Liquid template
interface AuthState {
  isLoggedIn: boolean;
}

// Get auth state from DOM data attributes
function getAuthState(): AuthState {
  const root = document.getElementById('health-tool-root');
  if (!root) {
    return { isLoggedIn: false };
  }

  const isLoggedIn = root.dataset.loggedIn === 'true';
  return { isLoggedIn };
}

export function HealthTool() {
  const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showMigrationPrompt, setShowMigrationPrompt] = useState(false);
  const [localDataForMigration, setLocalDataForMigration] = useState<Partial<HealthInputs> | null>(null);

  // Get auth state once on mount
  const [authState] = useState<AuthState>(() => getAuthState());

  // Load data on mount (from cloud if logged in, otherwise localStorage)
  useEffect(() => {
    async function loadData() {
      if (authState.isLoggedIn) {
        // Load from cloud via app proxy (Shopify adds customer ID automatically)
        const cloudData = await loadCloudProfile();
        const localData = loadFromLocalStorage();

        if (cloudData && Object.keys(cloudData).length > 0) {
          setInputs(cloudData);
          if (localData && Object.keys(localData).length > 0) {
            clearLocalStorage();
          }
        } else if (localData && Object.keys(localData).length > 0) {
          // No cloud data but local data exists - offer migration
          setLocalDataForMigration(localData);
          setShowMigrationPrompt(true);
          setInputs(localData);
        }
      } else {
        // Guest mode - load from localStorage
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
        // Save to cloud via app proxy
        setIsSaving(true);
        setSaveStatus('saving');
        const success = await saveCloudProfile(inputs);
        setIsSaving(false);
        setSaveStatus(success ? 'saved' : 'error');

        // Reset status after a delay
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        // Guest mode - save to localStorage
        saveToLocalStorage(inputs);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [inputs, hasLoadedData, authState.isLoggedIn]);

  // Handle migration confirmation
  const handleMigrate = useCallback(async () => {
    if (!localDataForMigration) return;

    const result = await migrateLocalData(localDataForMigration);

    if (result.success) {
      clearLocalStorage();
      setShowMigrationPrompt(false);
      setLocalDataForMigration(null);

      if (!result.migrated && result.cloudData) {
        setInputs(result.cloudData);
      }
    }
  }, [localDataForMigration]);

  // Skip migration and use local data
  const handleSkipMigration = useCallback(() => {
    setShowMigrationPrompt(false);
    setLocalDataForMigration(null);
  }, []);

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
    const healthResults = calculateHealthResults(inputs as HealthInputs);
    return { results: healthResults, isValid: true };
  }, [inputs]);

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

      {/* Migration Prompt */}
      {showMigrationPrompt && (
        <div className="health-tool-migration-prompt">
          <div className="migration-content">
            <p>
              <strong>Welcome back!</strong> We found health data saved on this device.
              Would you like to save it to your account?
            </p>
            <div className="migration-actions">
              <button onClick={handleMigrate} className="migration-btn primary">
                Save to Account
              </button>
              <button onClick={handleSkipMigration} className="migration-btn secondary">
                Keep Local Only
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="health-tool-content">
        <div className="health-tool-left">
          <InputPanel
            inputs={inputs}
            onChange={handleInputChange}
            errors={errors}
          />
        </div>

        <div className="health-tool-right">
          <ResultsPanel
            results={results}
            isValid={isValid}
            authState={authState}
            saveStatus={saveStatus}
          />
        </div>
      </div>
    </div>
  );
}
