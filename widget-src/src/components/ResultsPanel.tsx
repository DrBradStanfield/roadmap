import React from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type UnitSystem,
  formatDisplayValue,
  getDisplayLabel,
} from '@roadmap/health-core';

// Auth state type (matches HealthTool)
interface AuthState {
  isLoggedIn: boolean;
}

interface ResultsPanelProps {
  results: HealthResults | null;
  isValid: boolean;
  authState?: AuthState;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  unitSystem: UnitSystem;
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const priorityColors = {
    info: 'suggestion-info',
    attention: 'suggestion-attention',
    urgent: 'suggestion-urgent',
  };

  return (
    <div className={`suggestion-card ${priorityColors[suggestion.priority]}`}>
      <div className="suggestion-header">
        <span className={`suggestion-badge ${priorityColors[suggestion.priority]}`}>
          {suggestion.priority === 'urgent' && '⚠️ '}
          {suggestion.category}
        </span>
        {suggestion.discussWithDoctor && (
          <span className="doctor-badge">Discuss with doctor</span>
        )}
      </div>
      <h4 className="suggestion-title">{suggestion.title}</h4>
      <p className="suggestion-desc">{suggestion.description}</p>
    </div>
  );
}

function AccountStatus({ authState, saveStatus }: { authState?: AuthState; saveStatus?: string }) {
  if (!authState) return null;

  if (authState.isLoggedIn) {
    return (
      <div className="account-status logged-in">
        <div className="account-info">
          <span className="account-icon">👤</span>
          <span className="account-email">Logged in</span>
        </div>
        <div className="save-status">
          {saveStatus === 'saving' && (
            <span className="save-indicator saving">Saving...</span>
          )}
          {saveStatus === 'saved' && (
            <span className="save-indicator saved">✓ Saved to account</span>
          )}
          {saveStatus === 'error' && (
            <span className="save-indicator error">Failed to save</span>
          )}
          {saveStatus === 'idle' && (
            <span className="save-indicator idle">Data synced to account</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="account-status guest">
      <div className="guest-info">
        <span className="account-icon">💾</span>
        <span className="guest-text">Data saved to this device only</span>
      </div>
      <p className="login-prompt">
        <a href="/account/login" className="login-link">Log in</a> to save your data across devices
      </p>
    </div>
  );
}

export function ResultsPanel({ results, isValid, authState, saveStatus, unitSystem }: ResultsPanelProps) {
  if (!isValid || !results) {
    return (
      <div className="health-results-panel">
        <AccountStatus authState={authState} saveStatus={saveStatus} />
        <div className="results-placeholder">
          <div className="placeholder-icon">📊</div>
          <h3>Enter your information</h3>
          <p>
            Fill in your height and sex to see your personalized health
            suggestions. The more information you provide, the more tailored
            your recommendations will be.
          </p>
        </div>
      </div>
    );
  }

  const weightUnit = getDisplayLabel('weight', unitSystem);
  const ibwDisplay = formatDisplayValue('weight', results.idealBodyWeight, unitSystem);

  const urgentSuggestions = results.suggestions.filter(s => s.priority === 'urgent');
  const attentionSuggestions = results.suggestions.filter(s => s.priority === 'attention');
  const infoSuggestions = results.suggestions.filter(s => s.priority === 'info');

  return (
    <div className="health-results-panel">
      {/* Account Status */}
      <AccountStatus authState={authState} saveStatus={saveStatus} />

      {/* Quick Stats */}
      <section className="quick-stats">
        <h3 className="results-section-title">Your Health Snapshot</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Ideal Body Weight</span>
            <span className="stat-value">{ibwDisplay} {weightUnit}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Protein Target</span>
            <span className="stat-value">{results.proteinTarget}g/day</span>
          </div>
          {results.bmi !== undefined && (
            <div className="stat-card">
              <span className="stat-label">BMI</span>
              <span className="stat-value">{results.bmi}</span>
            </div>
          )}
          {results.age !== undefined && (
            <div className="stat-card">
              <span className="stat-label">Age</span>
              <span className="stat-value">{results.age} years</span>
            </div>
          )}
          {results.waistToHeightRatio !== undefined && (
            <div className="stat-card">
              <span className="stat-label">Waist-to-Height</span>
              <span className="stat-value">{results.waistToHeightRatio}</span>
            </div>
          )}
        </div>
      </section>

      {/* Suggestions */}
      <section className="suggestions-section">
        <h3 className="results-section-title">
          Suggestions to Discuss with Your Doctor
        </h3>

        {urgentSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title urgent">Requires Attention</h4>
            {urgentSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </div>
        )}

        {attentionSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title attention">Worth Discussing</h4>
            {attentionSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </div>
        )}

        {infoSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title info">For Your Information</h4>
            {infoSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </div>
        )}
      </section>

      {/* Disclaimer */}
      <div className="health-disclaimer">
        <strong>Disclaimer:</strong> This tool is for educational purposes only
        and is not a substitute for professional medical advice. Always consult
        with your healthcare provider before making any health decisions.
        Suggestions are based on general guidelines and may not apply to your
        individual situation.
      </div>
    </div>
  );
}
