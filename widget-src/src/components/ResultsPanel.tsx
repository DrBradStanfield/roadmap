import React from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type UnitSystem,
  formatDisplayValue,
  getDisplayLabel,
  APOB_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  LDL_THRESHOLDS,
} from '@roadmap/health-core';

// Auth state type (matches HealthTool)
interface AuthState {
  isLoggedIn: boolean;
  loginUrl?: string;
  accountUrl?: string;
}

interface ResultsPanelProps {
  results: HealthResults | null;
  isValid: boolean;
  authState?: AuthState;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  unitSystem: UnitSystem;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => void;
  isSavingLongitudinal?: boolean;
  onDeleteData?: () => void;
  isDeleting?: boolean;
}

function getBmiStatus(bmi: number): { label: string; className: string } {
  if (bmi < 18.5) return { label: 'Underweight', className: 'status-attention' };
  if (bmi < 25) return { label: 'Normal', className: 'status-normal' };
  if (bmi < 30) return { label: 'Overweight', className: 'status-info' };
  return { label: 'Obese', className: 'status-attention' };
}

function getWaistToHeightStatus(ratio: number): { label: string; className: string } | null {
  if (ratio >= 0.5) return { label: 'Elevated', className: 'status-attention' };
  return { label: 'Healthy', className: 'status-normal' };
}

function getLipidStatus(value: number, thresholds: { borderline: number; high: number; veryHigh: number }): { label: string; className: string } {
  if (value >= thresholds.veryHigh) return { label: 'Very High', className: 'status-urgent' };
  if (value >= thresholds.high) return { label: 'High', className: 'status-attention' };
  if (value >= thresholds.borderline) return { label: 'Borderline', className: 'status-info' };
  return { label: 'Optimal', className: 'status-normal' };
}

// Categories that should be consolidated into grouped cards
const GROUPED_CATEGORIES = ['nutrition', 'screening', 'bloodwork', 'medication'];

// Display order for all categories (nutrition, exercise, sleep first, then others)
const CATEGORY_ORDER = ['nutrition', 'exercise', 'sleep', 'screening', 'bloodwork', 'medication', 'blood_pressure', 'general'];

const priorityColors = {
  info: 'suggestion-info',
  attention: 'suggestion-attention',
  urgent: 'suggestion-urgent',
};

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const isSupplementCard = suggestion.category === 'supplements';

  return (
    <div className={`suggestion-card ${priorityColors[suggestion.priority]}${isSupplementCard ? ' supplement-card' : ''}`}>
      {!isSupplementCard && (
        <div className="suggestion-header">
          <span className={`suggestion-badge ${priorityColors[suggestion.priority]}`}>
            {suggestion.priority === 'urgent' && '⚠️ '}
            {suggestion.category.replace(/_/g, ' ')}
          </span>
        </div>
      )}
      <h4 className="suggestion-title">
        {suggestion.link ? (
          <a href={suggestion.link} target="_blank" rel="noopener noreferrer">
            {suggestion.title}
          </a>
        ) : (
          suggestion.title
        )}
      </h4>
      <p className="suggestion-desc">{suggestion.description}</p>
    </div>
  );
}

function GroupedSuggestionCard({ suggestions, category }: { suggestions: Suggestion[]; category: string }) {
  // Get highest priority for the card badge
  const highestPriority = suggestions.some(s => s.priority === 'urgent') ? 'urgent'
    : suggestions.some(s => s.priority === 'attention') ? 'attention' : 'info';

  return (
    <div className={`suggestion-card grouped-card ${priorityColors[highestPriority]}`}>
      <div className="suggestion-header">
        <span className={`suggestion-badge ${priorityColors[highestPriority]}`}>
          {highestPriority === 'urgent' && '⚠️ '}
          {category.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="grouped-subsections">
        {suggestions.map((s) => (
          <div key={s.id} className="suggestion-subsection">
            <h4 className="suggestion-title">{s.title}</h4>
            <p className="suggestion-desc">{s.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Group suggestions by category for consolidation
function groupSuggestionsByCategory(suggestions: Suggestion[]): Map<string, Suggestion[]> {
  const groups = new Map<string, Suggestion[]>();
  for (const s of suggestions) {
    const key = s.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return groups;
}

// Render suggestions with grouping for specified categories
function renderGroupedSuggestions(suggestions: Suggestion[]) {
  const grouped = groupSuggestionsByCategory(suggestions);
  const elements: React.ReactNode[] = [];

  // Render categories in defined order
  for (const cat of CATEGORY_ORDER) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;

    // Use grouped card for multi-item grouped categories, individual cards otherwise
    if (GROUPED_CATEGORIES.includes(cat) && items.length > 1) {
      elements.push(<GroupedSuggestionCard key={cat} suggestions={items} category={cat} />);
    } else {
      for (const s of items) {
        elements.push(<SuggestionCard key={s.id} suggestion={s} />);
      }
    }
  }

  // Render any remaining categories not in CATEGORY_ORDER
  for (const [cat, items] of grouped.entries()) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    for (const s of items) {
      elements.push(<SuggestionCard key={s.id} suggestion={s} />);
    }
  }

  return elements;
}

function AccountStatus({ authState, saveStatus, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal }: {
  authState?: AuthState;
  saveStatus?: string;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => void;
  isSavingLongitudinal?: boolean;
}) {
  if (!authState) return null;

  if (authState.isLoggedIn) {
    const statusText = saveStatus === 'saving' ? 'Saving...'
      : saveStatus === 'saved' ? '✓ Saved'
      : saveStatus === 'error' ? 'Failed to save'
      : 'Data synced';
    const statusClass = saveStatus === 'error' ? 'error' : saveStatus === 'saving' ? 'saving' : 'idle';
    return (
      <div className="account-status logged-in">
        <div className="account-status-row">
          <span className="account-info-inline">
            <span className="account-icon">👤</span>
            <a
              href={authState.accountUrl || '/account'}
              target="_blank"
              rel="noopener noreferrer"
              className="logged-in-link"
            >Logged in</a> · <span className={`save-indicator-inline ${statusClass}`}>{statusText}</span>
          </span>
          <a
            href="https://github.com/DrBradStanfield/roadmap/issues/new/choose"
            target="_blank"
            rel="noopener noreferrer"
            className="feedback-btn-small"
          >
            Send feedback
          </a>
        </div>
        {hasUnsavedLongitudinal && onSaveLongitudinal && (
          <button
            className="save-top-btn"
            onClick={onSaveLongitudinal}
            disabled={isSavingLongitudinal}
          >
            {isSavingLongitudinal ? 'Saving...' : 'Save New Values'}
          </button>
        )}
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
        <a href={authState.loginUrl || "/account/login"} className="login-link">Log in</a> to save your data across devices
      </p>
    </div>
  );
}

export function ResultsPanel({ results, isValid, authState, saveStatus, unitSystem, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, onDeleteData, isDeleting }: ResultsPanelProps) {
  if (!isValid || !results) {
    return (
      <div className="health-results-panel">
        <AccountStatus authState={authState} saveStatus={saveStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} />
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
  const infoSuggestions = results.suggestions.filter(s => s.priority === 'info' && s.category !== 'supplements');
  const supplementSuggestions = results.suggestions.filter(s => s.category === 'supplements');

  return (
    <div className="health-results-panel">
      {/* Account Status */}
      <AccountStatus authState={authState} saveStatus={saveStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} />

      {/* Quick Stats */}
      <section className="quick-stats">
        <h3 className="results-section-title">Your Health Snapshot</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Ideal Body Weight</span>
            <span className="stat-value">{ibwDisplay} {weightUnit}</span>
            <span className="stat-status status-normal">for {formatDisplayValue('height', results.heightCm, unitSystem)} {getDisplayLabel('height', unitSystem)} height</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Protein Target</span>
            <span className="stat-value">{results.proteinTarget}g/day</span>
            <span className="stat-status status-normal">1.2g per kg IBW</span>
          </div>
          {results.bmi !== undefined && (() => {
            const status = getBmiStatus(results.bmi);
            return (
              <div className="stat-card">
                <span className="stat-label">BMI</span>
                <span className="stat-value">{results.bmi}</span>
                <span className={`stat-status ${status.className}`}>{status.label}</span>
              </div>
            );
          })()}

          {/* Lipid tile: ApoB → Non-HDL → LDL cascade */}
          {results.apoB !== undefined ? (() => {
            const status = getLipidStatus(results.apoB, APOB_THRESHOLDS);
            return (
              <div className="stat-card">
                <span className="stat-label">ApoB</span>
                <span className="stat-value">{formatDisplayValue('apob', results.apoB, unitSystem)} {getDisplayLabel('apob', unitSystem)}</span>
                <span className={`stat-status ${status.className}`}>{status.label}</span>
              </div>
            );
          })() : results.nonHdlCholesterol !== undefined ? (() => {
            const status = getLipidStatus(results.nonHdlCholesterol, NON_HDL_THRESHOLDS);
            return (
              <div className="stat-card">
                <span className="stat-label">Non-HDL Cholesterol</span>
                <span className="stat-value">{formatDisplayValue('ldl', results.nonHdlCholesterol, unitSystem)} {getDisplayLabel('ldl', unitSystem)}</span>
                <span className={`stat-status ${status.className}`}>{status.label}</span>
              </div>
            );
          })() : results.ldlC !== undefined ? (() => {
            const status = getLipidStatus(results.ldlC, LDL_THRESHOLDS);
            return (
              <div className="stat-card">
                <span className="stat-label">LDL Cholesterol</span>
                <span className="stat-value">{formatDisplayValue('ldl', results.ldlC, unitSystem)} {getDisplayLabel('ldl', unitSystem)}</span>
                <span className={`stat-status ${status.className}`}>{status.label}</span>
              </div>
            );
          })() : null}

          {results.eGFR !== undefined && (() => {
            const status = results.eGFR >= 90 ? { label: 'Normal', className: 'status-normal' }
              : results.eGFR >= 60 ? { label: 'Mildly Decreased', className: 'status-info' }
              : results.eGFR >= 45 ? { label: 'Mild-Moderate Decrease', className: 'status-attention' }
              : results.eGFR >= 30 ? { label: 'Moderate-Severe Decrease', className: 'status-attention' }
              : results.eGFR >= 15 ? { label: 'Severely Decreased', className: 'status-urgent' }
              : { label: 'Kidney Failure', className: 'status-urgent' };
            return (
              <div className="stat-card">
                <span className="stat-label">eGFR</span>
                <span className="stat-value">{results.eGFR} mL/min</span>
                <span className={`stat-status ${status.className}`}>{status.label}</span>
              </div>
            );
          })()}

          {results.waistToHeightRatio !== undefined && (() => {
            const status = getWaistToHeightStatus(results.waistToHeightRatio);
            return (
              <div className="stat-card">
                <span className="stat-label">Waist-to-Height</span>
                <span className="stat-value">{results.waistToHeightRatio}</span>
                {status && <span className={`stat-status ${status.className}`}>{status.label}</span>}
              </div>
            );
          })()}
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
            {renderGroupedSuggestions(urgentSuggestions)}
          </div>
        )}

        {attentionSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title attention">Next Steps</h4>
            {renderGroupedSuggestions(attentionSuggestions)}
          </div>
        )}

        {infoSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title info">Foundation</h4>
            {renderGroupedSuggestions(infoSuggestions)}
          </div>
        )}

        {infoSuggestions.length > 0 && supplementSuggestions.length > 0 && (
          <div className="suggestions-group supplements-group">
            <h4 className="suggestions-group-title supplements">Supplements</h4>
            {supplementSuggestions.map((s) => (
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

      <div className="feedback-section">
        <a
          href="https://github.com/DrBradStanfield/roadmap/issues/new/choose"
          target="_blank"
          rel="noopener noreferrer"
          className="feedback-btn"
        >
          Send feedback
        </a>
      </div>

      {authState?.isLoggedIn && onDeleteData && (
        <div className="delete-data-section">
          <button
            className="delete-data-link"
            onClick={onDeleteData}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete All My Data'}
          </button>
        </div>
      )}
    </div>
  );
}
