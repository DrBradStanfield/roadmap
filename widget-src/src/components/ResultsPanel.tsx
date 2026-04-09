import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type UnitSystem,
  type MetricType,
  type SuggestionEvidence,
  formatDisplayValue,
  getDisplayLabel,
  formatHeightDisplay,
  APOB_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  LDL_THRESHOLDS,
  REMINDER_CATEGORIES,
  REMINDER_CATEGORY_LABELS,
  type ReminderCategory,
  getEgfrStatus,
  getLpaStatus,
  getLipidStatus,
  getProteinRate,
  STAT_CARD_EVIDENCE,
  getIbwEvidence,
  getProteinEvidence,
  getBmiEvidence,
} from '@roadmap/health-core';
import { type ApiReminderPreference, sendReportEmail, getReportHtml, sendGuestReport, trackABConversion, getABAssignments } from '../lib/api';
import { FeedbackForm } from './FeedbackForm';
import { ChatSection } from './ChatSection';
// @ts-ignore — JSON import for blog post cards
import blogIndex from '../../../docs/blog/index.json';

const LATEST_BLOG_POSTS = (blogIndex as Array<{ title: string; url: string; tags: string[] }>).slice(0, 3);

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
  unitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => Promise<void>;
  isSavingLongitudinal?: boolean;
  onDeleteData?: () => void;
  isDeleting?: boolean;
  redirectFailed?: boolean;
  reminderPreferences?: ApiReminderPreference[];
  onReminderPreferenceChange?: (category: string, enabled: boolean) => void;
  onGlobalReminderOptout?: () => void;
  sex?: 'male' | 'female';
  hideInlineChat?: boolean;
  onInlineChatExpand?: () => void;
  guestReportData?: {
    inputs: Record<string, unknown>;
    medications?: Record<string, unknown>[];
    screenings?: Record<string, unknown>[];
  };
  formStage?: number;
}

function getBmiStatus(bmiCategory: string, waistToHeightRatio?: number): { label: string; className: string } {
  // When WHtR unknown for BMI 25-29.9, suppress label (prompt user to measure)
  if (bmiCategory === 'Overweight' && waistToHeightRatio === undefined) {
    return { label: '', className: '' };
  }
  if (bmiCategory.startsWith('Obese')) return { label: 'Obese', className: 'status-attention' };
  const classMap: Record<string, string> = {
    'Underweight': 'status-attention',
    'Normal': 'status-normal',
    'Overweight': 'status-info',
  };
  return { label: bmiCategory, className: classMap[bmiCategory] || '' };
}

function getWaistToHeightStatus(ratio: number): { label: string; className: string } | null {
  if (ratio >= 0.5) return { label: 'Elevated', className: 'status-attention' };
  return { label: 'Healthy', className: 'status-normal' };
}

const statusClassMap: Record<string, string> = {
  'Normal': 'status-normal', 'Optimal': 'status-normal', 'Healthy': 'status-normal',
  'Low Normal': 'status-info', 'Borderline': 'status-info', 'Overweight': 'status-info',
  'Mildly Decreased': 'status-attention', 'High': 'status-attention', 'Elevated': 'status-attention',
  'Moderately Decreased': 'status-attention', 'Underweight': 'status-attention',
  'Very High': 'status-urgent', 'Severely Decreased': 'status-urgent', 'Kidney Failure': 'status-urgent',
};

function StatCard({ label, value, status, evidence }: {
  label: string;
  value: React.ReactNode;
  status?: { label: string; className: string };
  evidence?: SuggestionEvidence;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!evidence;
  return (
    <div className={`stat-card${hasDetail ? ' stat-card-clickable' : ''}${open ? ' stat-card-open' : ''}`}
         onClick={hasDetail ? () => setOpen(o => !o) : undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {status?.label && <span className={`stat-status ${status.className}`}>{status.label}</span>}
      {hasDetail && open && (
        <div className="stat-detail">
          <p className="stat-detail-text">{evidence.reason}</p>
          {evidence.guidelines.length > 0 && (
            <div className="stat-detail-guidelines">
              {evidence.guidelines.map(g => <span key={g} className="guideline-tag">{g}</span>)}
            </div>
          )}
          {evidence.references.length > 0 && (
            <div className="evidence-refs">
              {evidence.references.map(ref => (
                <a key={ref.url} href={ref.url} target="_blank" rel="noopener noreferrer">{ref.label}</a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
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

function suggestionHasEvidence(suggestion: Suggestion): boolean {
  return !!(suggestion.reason || (suggestion.references && suggestion.references.length > 0));
}

function SuggestionEvidence({ suggestion, open, onToggle }: { suggestion: Suggestion; open: boolean; onToggle: () => void }) {
  const hasEvidence = suggestionHasEvidence(suggestion);
  const hasGuidelines = suggestion.guidelines && suggestion.guidelines.length > 0;

  if (!hasGuidelines && !hasEvidence) return null;

  return (
    <div className="suggestion-evidence-section">
      <div className="suggestion-evidence-row">
        {hasGuidelines && suggestion.guidelines!.map(g => (
          <span key={g} className={`guideline-tag${hasEvidence ? ' guideline-tag-clickable' : ''}`} onClick={hasEvidence ? onToggle : undefined}>{g}</span>
        ))}
        {hasEvidence && (
          <span className="evidence-toggle" onClick={onToggle}>{open ? '▾' : '▸'} Why this suggestion?</span>
        )}
      </div>
      {open && hasEvidence && (
        <div className="evidence-content">
          {suggestion.reason && <p className="evidence-reason">{suggestion.reason}</p>}
          {suggestion.references && suggestion.references.length > 0 && (
            <div className="evidence-refs">
              {suggestion.references.map(ref => (
                <a key={ref.url} href={ref.url} target="_blank" rel="noopener noreferrer">
                  {ref.label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ suggestion, highlighted, fadingOut }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const isSupplementCard = suggestion.category === 'supplements';
  const isSkinCard = suggestion.category === 'skin';
  const isSpecialCard = isSupplementCard || isSkinCard;
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const toggleEvidence = hasEvidence ? () => setEvidenceOpen(o => !o) : undefined;

  return (
    <div className={`suggestion-card ${priorityColors[suggestion.priority]}${isSupplementCard ? ' supplement-card' : ''}${isSkinCard ? ' skin-card' : ''}${highlightClass}${hasEvidence ? ' suggestion-card-clickable' : ''}`}>
      {!isSpecialCard && (
        <div className="suggestion-header">
          <span className={`suggestion-badge ${priorityColors[suggestion.priority]}`}>
            {suggestion.priority === 'urgent' && '⚠️ '}
            {suggestion.category.replace(/_/g, ' ')}
          </span>
        </div>
      )}
      <div className="suggestion-body" onClick={toggleEvidence}>
        <h4 className="suggestion-title">
          {suggestion.link ? (
            <a href={suggestion.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
              {suggestion.title}
            </a>
          ) : (
            suggestion.title
          )}
        </h4>
        <p className="suggestion-desc">{suggestion.description}</p>
      </div>
      {hasEvidence && <SuggestionEvidence suggestion={suggestion} open={evidenceOpen} onToggle={toggleEvidence!} />}
    </div>
  );
}

function GroupedSubsection({ suggestion, highlighted, fadingOut }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const toggleEvidence = hasEvidence ? () => setEvidenceOpen(o => !o) : undefined;

  return (
    <div className={`suggestion-subsection${highlightClass}${hasEvidence ? ' suggestion-subsection-clickable' : ''}`}>
      <div className="suggestion-body" onClick={toggleEvidence}>
        <h4 className="suggestion-title">
          {suggestion.link ? (
            <a href={suggestion.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
              {suggestion.title}
            </a>
          ) : (
            suggestion.title
          )}
        </h4>
        <p className="suggestion-desc">{suggestion.description}</p>
      </div>
      {hasEvidence && <SuggestionEvidence suggestion={suggestion} open={evidenceOpen} onToggle={toggleEvidence!} />}
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
        {suggestions.map((s) => (
          <GroupedSubsection key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} />
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
  onSaveLongitudinal?: () => Promise<void>;
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

  if (redirectFailed) {
    return (
      <a href={authState.loginUrl || "/account/login"} className="guest-cta no-print">
        <div className="guest-cta-text">
          <strong>Welcome back</strong>
          <span>Sign in to access your saved data and health history.</span>
        </div>
        <span className="guest-cta-btn">Sign In</span>
      </a>
    );
  }

  return null; // Guest email capture is rendered separately via GuestEmailCapture
}

type GuestEmailState = 'idle' | 'sending' | 'prompt-account' | 'blog-posts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_EMAIL_HELPER = 'Get your personalized plan emailed to you, with detailed explanations and clinical references for every suggestion.';

function getEmailHelperText(): string {
  const assignments = getABAssignments();
  for (const [testId, variantId] of Object.entries(assignments)) {
    const el = document.querySelector(`.ab-email-helper[data-variant="${variantId}"][data-test="${testId}"]`);
    if (el?.textContent) return el.textContent;
  }
  return DEFAULT_EMAIL_HELPER;
}

function GuestEmailCapture({ guestReportData, loginUrl, formStage }: {
  guestReportData: { inputs: Record<string, unknown>; medications?: Record<string, unknown>[]; screenings?: Record<string, unknown>[] };
  loginUrl?: string;
  formStage?: number;
}) {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [state, setState] = useState<GuestEmailState>('idle');
  const helperText = useMemo(() => getEmailHelperText(), []);

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError('');
    setState('sending');

    const result = await sendGuestReport(
      trimmed,
      guestReportData.inputs,
      guestReportData.medications,
      guestReportData.screenings,
    );

    if (result.success) {
      trackABConversion();
      setState('prompt-account');
    } else {
      setEmailError(result.error || 'Failed to send. Please try again.');
      setState('idle');
    }
  };

  if (state === 'prompt-account') {
    return (
      <div className="email-capture no-print">
        <div className="email-capture-success">
          <strong>Check your inbox! Your personalized health plan has been sent.</strong>
        </div>
        <div className="email-capture-account-prompt">
          <p>Want to save your data and track changes over time?</p>
          <a href={loginUrl || '/account/login'} className="btn-primary email-capture-account-btn">Create Free Account</a>
          <button type="button" className="email-capture-dismiss" onClick={() => setState('blog-posts')}>Maybe later</button>
        </div>
      </div>
    );
  }

  if (state === 'blog-posts') {
    return (
      <div className="email-capture no-print">
        <div className="email-capture-blog-posts">
          <strong>Latest articles</strong>
          {LATEST_BLOG_POSTS.map(post => (
            <a key={post.url} href={post.url} className="blog-post-card" target="_blank" rel="noopener noreferrer">
              <span className="blog-post-title">{post.title}</span>
              {post.tags?.[0] && <span className="blog-post-tag">{post.tags[0]}</span>}
            </a>
          ))}
        </div>
        <button type="button" className="email-capture-dismiss" onClick={() => setState('idle')}>Send to another email</button>
      </div>
    );
  }

  return (
    <div className={`email-capture no-print${formStage === 4 ? ' field-attention' : ''}`}>
      <p className="email-guest-helper">{helperText}</p>
      <div className="email-capture-row">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          className={emailError ? 'error' : ''}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={state === 'sending'}
        >
          {state === 'sending' ? 'Sending...' : 'Get Your Personalized Plan'}
        </button>
      </div>
      {emailError && <span className="email-capture-error">{emailError}</span>}
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

export function ResultsPanel({ results, isValid, authState, saveStatus, emailConfirmStatus, unitSystem, unitOverrides, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, onDeleteData, isDeleting, redirectFailed, reminderPreferences, onReminderPreferenceChange, onGlobalReminderOptout, sex, hideInlineChat, onInlineChatExpand, guestReportData, formStage }: ResultsPanelProps) {
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
    // Save any unsaved longitudinal values first so the server has the same data
    if (hasUnsavedLongitudinal && onSaveLongitudinal) {
      try { await onSaveLongitudinal(); } catch { /* proceed with saved data */ }
    }
    const result = await sendReportEmail();
    setEmailStatus(result.success ? 'sent' : 'error');
    setTimeout(() => setEmailStatus('idle'), 3000);
  };

  const handlePrint = async () => {
    if (printStatus === 'loading') return;
    setPrintStatus('loading');
    // Save any unsaved longitudinal values first so the server has the same data
    if (hasUnsavedLongitudinal && onSaveLongitudinal) {
      try { await onSaveLongitudinal(); } catch { /* proceed with saved data */ }
    }
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

    // First batch of suggestions — accept as baseline without highlighting
    if (baselineRef.current.size === 0 && currentMap.size > 0) {
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
            Fill in your height and sex to see the beginning of your personalized health
            suggestions. The more information you provide, the more tailored
            your suggestions will be.
          </p>
        </div>
      </div>
    );
  }

  /** Resolve effective unit system for a metric (per-field override or global default). */
  const usFor = (metric: MetricType): UnitSystem => unitOverrides?.[metric] ?? unitSystem;

  const weightUnit = getDisplayLabel('weight', usFor('weight'));
  const ibwDisplay = formatDisplayValue('weight', results.idealBodyWeight, usFor('weight'));

  const urgentSuggestions = results.suggestions.filter(s => s.priority === 'urgent');
  const attentionSuggestions = results.suggestions.filter(s => s.priority === 'attention');
  const infoSuggestions = results.suggestions.filter(s => s.priority === 'info' && s.category !== 'supplements' && s.category !== 'skin');
  const supplementSuggestions = results.suggestions.filter(s => s.category === 'supplements');
  const skinSuggestions = results.suggestions.filter(s => s.category === 'skin');

  return (
    <div className="health-results-panel">
      {/* Account Status */}
      <AccountStatus authState={authState} saveStatus={saveStatus} emailConfirmStatus={emailConfirmStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} redirectFailed={redirectFailed} onPrint={authState?.isLoggedIn ? handlePrint : undefined} onEmail={authState?.isLoggedIn ? handleEmailReport : undefined} emailStatus={emailStatus} printStatus={printStatus} />
      {guestReportData && <GuestEmailCapture guestReportData={guestReportData} loginUrl={authState?.loginUrl} formStage={formStage} />}

      {/* Quick Stats */}
      <section className="quick-stats">
        <h3 className="results-section-title">Your Health Snapshot</h3>
        <div className="stats-grid">
          {results.waistToHeightRatio !== undefined && (() => {
            const status = getWaistToHeightStatus(results.waistToHeightRatio);
            return status ? <StatCard label="Waist-to-Height" value={results.waistToHeightRatio} status={status} evidence={STAT_CARD_EVIDENCE['whtr']} /> : null;
          })()}
          {results.bmi !== undefined && (
            <StatCard
              label="BMI"
              value={results.bmi}
              status={getBmiStatus(results.bmiCategory!, results.waistToHeightRatio)}
              evidence={sex ? getBmiEvidence(results.bmiCategory!, sex, results.waistToHeightRatio) : undefined}
            />
          )}
          <StatCard
            label="Ideal Body Weight"
            value={<>{ibwDisplay} {weightUnit}</>}
            status={{ label: `for ${formatHeightDisplay(results.heightCm, unitSystem)} height`, className: 'status-normal' }}
            evidence={sex ? getIbwEvidence(sex) : undefined}
          />
          <StatCard
            label="Protein Target"
            value={<>{results.proteinTarget}g/day</>}
            status={{ label: `${getProteinRate(results.eGFR).toFixed(1)}g per kg IBW`, className: 'status-normal' }}
            evidence={getProteinEvidence(results.idealBodyWeight, getProteinRate(results.eGFR), results.eGFR)}
          />

          {/* Lipid tile: ApoB → Non-HDL → LDL cascade */}
          {results.apoB !== undefined ? (() => {
            const s = getLipidStatus(results.apoB, APOB_THRESHOLDS);
            return <StatCard label="ApoB" value={<>{formatDisplayValue('apob', results.apoB, usFor('apob'))} {getDisplayLabel('apob', usFor('apob'))}</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['apob']} />;
          })() : results.nonHdlCholesterol !== undefined ? (() => {
            const s = getLipidStatus(results.nonHdlCholesterol, NON_HDL_THRESHOLDS);
            return <StatCard label="Non-HDL Cholesterol" value={<>{formatDisplayValue('ldl', results.nonHdlCholesterol, usFor('ldl'))} {getDisplayLabel('ldl', usFor('ldl'))}</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['non-hdl']} />;
          })() : results.ldlC !== undefined ? (() => {
            const s = getLipidStatus(results.ldlC, LDL_THRESHOLDS);
            return <StatCard label="LDL Cholesterol" value={<>{formatDisplayValue('ldl', results.ldlC, usFor('ldl'))} {getDisplayLabel('ldl', usFor('ldl'))}</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['ldl']} />;
          })() : null}

          {results.eGFR !== undefined && (() => {
            const s = getEgfrStatus(results.eGFR);
            return <StatCard label="eGFR" value={<>{results.eGFR} mL/min</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['egfr']} />;
          })()}

          {results.lpa !== undefined && (() => {
            const s = getLpaStatus(results.lpa);
            return <StatCard label="Lp(a)" value={<>{Math.round(results.lpa)} nmol/L</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['lpa']} />;
          })()}
        </div>
      </section>

      {/* Chat CTA — inline card between stats and suggestions (hidden when floating FAB chat is open) */}
      {!hideInlineChat && (
        <ChatSection
          isLoggedIn={authState?.isLoggedIn ?? false}
          loginUrl={authState?.loginUrl}
          onExpand={onInlineChatExpand}
        />
      )}

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

      {/* Health Records — documents from uploads */}

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
