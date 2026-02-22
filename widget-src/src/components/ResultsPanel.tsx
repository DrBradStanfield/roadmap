import React, { useState, useRef, useEffect } from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type UnitSystem,
  formatDisplayValue,
  getDisplayLabel,
  formatHeightDisplay,
  APOB_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  LDL_THRESHOLDS,
  REMINDER_CATEGORIES,
  REMINDER_CATEGORY_LABELS,
  EGFR_THRESHOLDS,
  LPA_THRESHOLDS,
  type ReminderCategory,
} from '@roadmap/health-core';
import { type ApiReminderPreference, sendReportEmail, getReportHtml } from '../lib/api';
import { FeedbackForm } from './FeedbackForm';

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
  saveStatus?: 'idle' | 'saving' | 'saved' | 'first-saved' | 'error';
  emailConfirmStatus?: 'idle' | 'sent' | 'error';
  unitSystem: UnitSystem;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => void;
  isSavingLongitudinal?: boolean;
  onDeleteData?: () => void;
  isDeleting?: boolean;
  redirectFailed?: boolean;
  reminderPreferences?: ApiReminderPreference[];
  onReminderPreferenceChange?: (category: string, enabled: boolean) => void;
  onGlobalReminderOptout?: () => void;
  sex?: 'male' | 'female';
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

function SuggestionCard({ suggestion, highlighted, fadingOut }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean }) {
  const isSupplementCard = suggestion.category === 'supplements';
  const isSkinCard = suggestion.category === 'skin';
  const isSpecialCard = isSupplementCard || isSkinCard;
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  return (
    <div className={`suggestion-card ${priorityColors[suggestion.priority]}${isSupplementCard ? ' supplement-card' : ''}${isSkinCard ? ' skin-card' : ''}${highlightClass}`}>
      {!isSpecialCard && (
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

function GroupedSuggestionCard({ suggestions, category, highlightedIds, fadingOutIds }: { suggestions: Suggestion[]; category: string; highlightedIds?: Set<string>; fadingOutIds?: Set<string> }) {
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
        {suggestions.map((s) => {
          const highlightClass = fadingOutIds?.has(s.id) ? ' suggestion-highlight suggestion-fade-out'
            : highlightedIds?.has(s.id) ? ' suggestion-highlight' : '';
          return (
            <div key={s.id} className={`suggestion-subsection${highlightClass}`}>
              <h4 className="suggestion-title">{s.title}</h4>
              <p className="suggestion-desc">{s.description}</p>
            </div>
          );
        })}
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
function renderGroupedSuggestions(suggestions: Suggestion[], highlightedIds?: Set<string>, fadingOutIds?: Set<string>) {
  const grouped = groupSuggestionsByCategory(suggestions);
  const elements: React.ReactNode[] = [];

  // Render categories in defined order
  for (const cat of CATEGORY_ORDER) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;

    // Use grouped card for multi-item grouped categories, individual cards otherwise
    if (GROUPED_CATEGORIES.includes(cat) && items.length > 1) {
      elements.push(<GroupedSuggestionCard key={cat} suggestions={items} category={cat} highlightedIds={highlightedIds} fadingOutIds={fadingOutIds} />);
    } else {
      for (const s of items) {
        elements.push(<SuggestionCard key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} />);
      }
    }
  }

  // Render any remaining categories not in CATEGORY_ORDER
  for (const [cat, items] of grouped.entries()) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    for (const s of items) {
      elements.push(<SuggestionCard key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} />);
    }
  }

  return elements;
}

function AccountStatus({ authState, saveStatus, emailConfirmStatus, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, redirectFailed, onPrint, onEmail, emailStatus, printStatus }: {
  authState?: AuthState;
  saveStatus?: string;
  emailConfirmStatus?: 'idle' | 'sent' | 'error';
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => void;
  isSavingLongitudinal?: boolean;
  redirectFailed?: boolean;
  onPrint?: () => void;
  onEmail?: () => void;
  emailStatus?: 'idle' | 'sending' | 'sent' | 'error';
  printStatus?: 'idle' | 'loading' | 'error';
}) {
  const [showFeedback, setShowFeedback] = useState(false);

  if (!authState) return null;

  if (authState.isLoggedIn) {
    const statusText = saveStatus === 'saving' ? 'Saving...'
      : saveStatus === 'first-saved' ? '✓ Saved'
      : saveStatus === 'saved' ? '✓ Saved'
      : saveStatus === 'error' ? 'Failed to save'
      : 'Data synced';
    const statusClass = saveStatus === 'error' ? 'error' : saveStatus === 'saving' ? 'saving' : 'idle';

    const emailLabel = emailStatus === 'sending' ? 'Sending...'
      : emailStatus === 'sent' ? 'Sent!'
      : emailStatus === 'error' ? 'Failed'
      : 'Email';
    const printLabel = printStatus === 'loading' ? 'Loading...'
      : printStatus === 'error' ? 'Failed'
      : 'Print';

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
          <div className="account-actions no-print">
            {onPrint && (
              <button type="button" className="action-btn-small" onClick={onPrint} disabled={printStatus === 'loading'} title="Print report">
                {printLabel}
              </button>
            )}
            {onEmail && (
              <button type="button" className="action-btn-small" onClick={onEmail} disabled={emailStatus === 'sending'} title="Email report to yourself">
                {emailLabel}
              </button>
            )}
            <button
              type="button"
              className="feedback-btn-small"
              onClick={() => setShowFeedback(!showFeedback)}
            >
              Send feedback
            </button>
          </div>
        </div>
        {emailConfirmStatus === 'sent' && (
          <div className="email-confirm-message">✓ Check your email for your health report!</div>
        )}
        {emailConfirmStatus === 'error' && (
          <div className="email-confirm-message email-confirm-error">Sending your summary email failed. Please contact brad@drstanfield.com for help.</div>
        )}
        {showFeedback && (
          <FeedbackForm initialExpanded showSourceLink={false} onClose={() => setShowFeedback(false)} />
        )}
        {hasUnsavedLongitudinal && onSaveLongitudinal && (
          <button
            className="btn-primary save-top-btn"
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
    <div className="guest-cta no-print">
      <div className="guest-cta-text">
        {redirectFailed ? (
          <>
            <strong>Welcome back</strong>
            <span>Sign in to access your saved data and health history.</span>
          </>
        ) : (
          <>
            <strong>Get Your Personalized Health Report</strong>
            <span>Save your data and get an email summary to discuss with doctor.</span>
          </>
        )}
      </div>
      <a href={authState.loginUrl || "/account/login"} className="guest-cta-btn">
        {redirectFailed ? 'Sign In' : 'Create Free Account'}
      </a>
    </div>
  );
}

/** Filter reminder categories based on user's sex and age. */
function getVisibleCategories(sex?: 'male' | 'female', age?: number): ReminderCategory[] {
  return REMINDER_CATEGORIES.filter(cat => {
    // Breast/cervical: female only
    if (cat === 'screening_breast' || cat === 'screening_cervical') return sex === 'female';
    // Prostate: male only
    if (cat === 'screening_prostate') return sex === 'male';
    // DEXA: female ≥50, male ≥70
    if (cat === 'screening_dexa') {
      if (age === undefined) return false;
      return (sex === 'female' && age >= 50) || (sex === 'male' && age >= 70);
    }
    return true;
  });
}

function ReminderSettings({
  preferences,
  onPreferenceChange,
  onGlobalOptout,
  sex,
  age,
}: {
  preferences: ApiReminderPreference[];
  onPreferenceChange: (category: string, enabled: boolean) => void;
  onGlobalOptout?: () => void;
  sex?: 'male' | 'female';
  age?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const visibleCategories = getVisibleCategories(sex, age);
  const disabledSet = new Set(
    preferences.filter(p => !p.enabled).map(p => p.reminderCategory)
  );

  return (
    <div className="reminder-settings">
      <button
        className="reminder-settings-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        Email Reminders
        <span className="collapse-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
      </button>

      {expanded && (
        <div className="reminder-settings-content">
          <p className="reminder-settings-desc">
            Choose which health reminder emails you'd like to receive.
          </p>

          <div className="reminder-checkboxes">
            {visibleCategories.map(cat => {
              const isEnabled = !disabledSet.has(cat);
              return (
                <label key={cat} className="reminder-checkbox-label">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => onPreferenceChange(cat, e.target.checked)}
                  />
                  <span>{REMINDER_CATEGORY_LABELS[cat]}</span>
                </label>
              );
            })}
          </div>

          {onGlobalOptout && (
            <button
              className="reminder-unsubscribe-btn"
              onClick={onGlobalOptout}
              type="button"
            >
              Unsubscribe from all health notifications
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsPanel({ results, isValid, authState, saveStatus, emailConfirmStatus, unitSystem, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, onDeleteData, isDeleting, redirectFailed, reminderPreferences, onReminderPreferenceChange, onGlobalReminderOptout, sex }: ResultsPanelProps) {
  // Track highlighted (new/changed) suggestion IDs
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [fadingOutIds, setFadingOutIds] = useState<Set<string>>(new Set());
  const baselineRef = useRef<Map<string, { title: string; description: string }>>(new Map());
  const settledRef = useRef(false);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Report actions state (shared between top and bottom buttons)
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [printStatus, setPrintStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  const handleEmailReport = async () => {
    if (emailStatus === 'sending') return;
    setEmailStatus('sending');
    const result = await sendReportEmail();
    setEmailStatus(result.success ? 'sent' : 'error');
    setTimeout(() => setEmailStatus('idle'), 3000);
  };

  const handlePrint = async () => {
    if (printStatus === 'loading') return;
    setPrintStatus('loading');
    const result = await getReportHtml();
    if (result.success && result.html) {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(result.html);
        printWindow.document.close();
        printWindow.print();
      }
      setPrintStatus('idle');
    } else {
      setPrintStatus('error');
      setTimeout(() => setPrintStatus('idle'), 3000);
    }
  };

  // Settle after 3s — skip highlighting during initial load + Phase 2 API overwrite
  useEffect(() => {
    const timer = setTimeout(() => { settledRef.current = true; }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Detect new/changed suggestions
  useEffect(() => {
    const suggestions = results?.suggestions ?? [];
    const currentMap = new Map(suggestions.map(s => [s.id, { title: s.title, description: s.description }]));

    if (!settledRef.current) {
      baselineRef.current = currentMap;
      return;
    }

    const newHighlights = new Set<string>();
    for (const s of suggestions) {
      const prev = baselineRef.current.get(s.id);
      if (!prev) {
        newHighlights.add(s.id);
      } else if (prev.title !== s.title || prev.description !== s.description) {
        newHighlights.add(s.id);
      }
    }

    // Cancel any in-progress fade-out
    if (fadeOutTimeoutRef.current) clearTimeout(fadeOutTimeoutRef.current);
    setFadingOutIds(new Set());

    setHighlightedIds(newHighlights);

    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    clearTimeoutRef.current = setTimeout(() => {
      // Start fade-out animation
      setFadingOutIds(newHighlights);
      setHighlightedIds(new Set());
      // After animation completes, clean up and update baseline
      fadeOutTimeoutRef.current = setTimeout(() => {
        setFadingOutIds(new Set());
        baselineRef.current = currentMap;
      }, 500);
    }, 3000);

    return () => {
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
      if (fadeOutTimeoutRef.current) clearTimeout(fadeOutTimeoutRef.current);
    };
  }, [results?.suggestions]);

  if (!isValid || !results) {
    return (
      <div className="health-results-panel">
        <AccountStatus authState={authState} saveStatus={saveStatus} emailConfirmStatus={emailConfirmStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} redirectFailed={redirectFailed} />
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
  const infoSuggestions = results.suggestions.filter(s => s.priority === 'info' && s.category !== 'supplements' && s.category !== 'skin');
  const supplementSuggestions = results.suggestions.filter(s => s.category === 'supplements');
  const skinSuggestions = results.suggestions.filter(s => s.category === 'skin');

  return (
    <div className="health-results-panel">
      {/* Account Status */}
      <AccountStatus authState={authState} saveStatus={saveStatus} emailConfirmStatus={emailConfirmStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} onPrint={authState?.isLoggedIn ? handlePrint : undefined} onEmail={authState?.isLoggedIn ? handleEmailReport : undefined} emailStatus={emailStatus} printStatus={printStatus} />

      {/* Quick Stats */}
      <section className="quick-stats">
        <h3 className="results-section-title">Your Health Snapshot</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Ideal Body Weight</span>
            <span className="stat-value">{ibwDisplay} {weightUnit}</span>
            <span className="stat-status status-normal">for {formatHeightDisplay(results.heightCm, unitSystem)} height</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Protein Target</span>
            <span className="stat-value">{results.proteinTarget}g/day</span>
            <span className="stat-status status-normal">{results.eGFR !== undefined && results.eGFR < EGFR_THRESHOLDS.mildlyDecreased ? '1.0g per kg IBW' : '1.2g per kg IBW'}</span>
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
            const status = results.eGFR >= 70 ? { label: 'Normal', className: 'status-normal' }
              : results.eGFR >= 60 ? { label: 'Low Normal', className: 'status-info' }
              : results.eGFR >= 45 ? { label: 'Mildly Decreased', className: 'status-attention' }
              : results.eGFR >= 30 ? { label: 'Moderately Decreased', className: 'status-attention' }
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

          {results.lpa !== undefined && (() => {
            const status = results.lpa >= LPA_THRESHOLDS.elevated
              ? { label: 'Elevated', className: 'status-attention' }
              : results.lpa >= LPA_THRESHOLDS.normal
              ? { label: 'Borderline', className: 'status-info' }
              : { label: 'Normal', className: 'status-normal' };
            return (
              <div className="stat-card">
                <span className="stat-label">Lp(a)</span>
                <span className="stat-value">{Math.round(results.lpa)} nmol/L</span>
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
            {renderGroupedSuggestions(urgentSuggestions, highlightedIds, fadingOutIds)}
          </div>
        )}

        {attentionSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title attention">Next Steps</h4>
            {renderGroupedSuggestions(attentionSuggestions, highlightedIds, fadingOutIds)}
          </div>
        )}

        {infoSuggestions.length > 0 && (
          <div className="suggestions-group">
            <h4 className="suggestions-group-title info">Foundation</h4>
            {renderGroupedSuggestions(infoSuggestions, highlightedIds, fadingOutIds)}
          </div>
        )}

        {skinSuggestions.length > 0 && (
          <div className="suggestions-group skin-group">
            <h4 className="suggestions-group-title skin">Skin Health</h4>
            {skinSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} highlighted={highlightedIds.has(s.id)} fadingOut={fadingOutIds.has(s.id)} />
            ))}
          </div>
        )}

        {supplementSuggestions.length > 0 && (
          <div className="suggestions-group supplements-group">
            <h4 className="suggestions-group-title supplements">Supplements</h4>
            {supplementSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} highlighted={highlightedIds.has(s.id)} fadingOut={fadingOutIds.has(s.id)} />
            ))}
          </div>
        )}
      </section>

      {/* Report Actions (bottom) — logged-in users only */}
      {authState?.isLoggedIn && (
        <div className="report-actions no-print">
          <button type="button" className="action-btn" onClick={handlePrint} disabled={printStatus === 'loading'}>
            {printStatus === 'loading' ? 'Loading...' : printStatus === 'error' ? 'Failed' : 'Print Report'}
          </button>
          <button type="button" className="action-btn" onClick={handleEmailReport} disabled={emailStatus === 'sending'}>
            {emailStatus === 'sending' ? 'Sending...' : emailStatus === 'sent' ? 'Sent!' : emailStatus === 'error' ? 'Failed' : 'Email Report'}
          </button>
        </div>
      )}

      {/* Disclaimer */}
      <div className="health-disclaimer">
        <strong>Disclaimer:</strong> This tool is for educational purposes only
        and is not a substitute for professional medical advice. Always consult
        with your healthcare provider before making any health decisions.
        Suggestions are based on general guidelines and may not apply to your
        individual situation.
      </div>

      {/* Reminder Settings — logged-in users only */}
      {authState?.isLoggedIn && onReminderPreferenceChange && (
        <ReminderSettings
          preferences={reminderPreferences ?? []}
          onPreferenceChange={onReminderPreferenceChange}
          onGlobalOptout={onGlobalReminderOptout}
          sex={sex}
          age={results?.age}
        />
      )}

      {!authState?.isLoggedIn && (
        <div className="guest-cta-inline no-print">
          <span>{redirectFailed ? 'Sign in to access your saved data.' : 'Save your data and get an email summary to discuss with doctor.'}</span>
          <a href={authState?.loginUrl || "/account/login"} className="guest-cta-btn">
            {redirectFailed ? 'Sign In' : 'Create Free Account'}
          </a>
        </div>
      )}

      <FeedbackForm />

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
