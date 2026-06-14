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
  getHba1cStatus,
  getLipidStatus,
  getProteinRate,
  STAT_CARD_EVIDENCE,
  getIbwEvidence,
  getProteinEvidence,
  getBmiEvidence,
} from '@roadmap/health-core';
import { sendReportEmail, getReportHtml, sendGuestReport, trackABConversion, getABAssignments, getReportEmailCaptured, markReportEmailCaptured } from '../lib/api';
import type { ApiReminderPreference } from '../lib/api-types';
import { EMAIL_REGEX } from '../lib/email';
import { LOCAL_FIRST, SHOPIFY_SURFACE } from '../lib/build-flags';
import { ColumnHeader } from './ColumnHeader';
import { FeedbackForm } from './FeedbackForm';
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
  saveStatus?: 'idle' | 'saving' | 'saved' | 'first-saved' | 'duplicates' | 'error';
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
  guestReportData?: {
    inputs: Record<string, unknown>;
    medications?: Record<string, unknown>[];
    screenings?: Record<string, unknown>[];
  };
  formStage?: number;
  /** Standalone-only: replaces the Shopify AccountStatus block with the
   *  local-first sync control. undefined on the live widget (AccountStatus
   *  shows). Render-prop: receives whether the user has entered real data,
   *  so the "choose where to save" pitch can stay hidden for brand-new users. */
  syncControl?: (ctx: { hasData: boolean }) => React.ReactNode;
  /** Standalone-only: the local-first email-reminders section, rendered as its
   *  own block lower in the plan (not bolted onto the sync line at the top).
   *  undefined on the live Shopify widget (which has its own ReminderSettings). */
  remindersSection?: React.ReactNode;
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
  'Prediabetic': 'status-attention',
  'Very High': 'status-urgent', 'Severely Decreased': 'status-urgent', 'Kidney Failure': 'status-urgent',
  'Diabetic': 'status-urgent',
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

function AccountStatus({ authState, saveStatus, emailConfirmStatus, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, redirectFailed }: {
  authState?: AuthState;
  saveStatus?: string;
  emailConfirmStatus?: 'idle' | 'sent' | 'error';
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => Promise<void>;
  isSavingLongitudinal?: boolean;
  redirectFailed?: boolean;
}) {
  if (!authState) return null;

  if (authState.isLoggedIn) {
    const statusText = saveStatus === 'saving' ? 'Saving...'
      : saveStatus === 'first-saved' ? '✓ Saved'
      : saveStatus === 'saved' ? '✓ Saved'
      : saveStatus === 'duplicates' ? '✓ Already saved'
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
        </div>
        {emailConfirmStatus === 'sent' && (
          <div className="email-confirm-message">✓ Check your email for your health report!</div>
        )}
        {emailConfirmStatus === 'error' && (
          <div className="email-confirm-message email-confirm-error">Sending your summary email failed. Please contact brad@drstanfield.com for help.</div>
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

type GuestEmailState = 'idle' | 'sending' | 'prompt-account' | 'blog-posts' | 'captured';

const DEFAULT_EMAIL_HELPER = 'Get your personalized plan emailed to you, with detailed explanations and clinical references for every suggestion.';

// On local-first the capture button DELIVERS the plan (opens the save-as-PDF
// window immediately); the emailed copy is the bonus. Copy reflects that
// (Brad, 2026-06-11) — no A/B helper variants on v2.
const LOCAL_FIRST_EMAIL_HELPER = 'Get your personalized plan, with detailed explanations and clinical references for every suggestion.';

/** Open the print/save-as-PDF window for a built report (shared by the Print
 *  button and, on local-first, the email-capture button). */
function openPrintWindow(html: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.print();
  return true;
}

function getEmailHelperText(): string {
  const assignments = getABAssignments();
  for (const [testId, variantId] of Object.entries(assignments)) {
    const el = document.querySelector(`.ab-email-helper[data-variant="${variantId}"][data-test="${testId}"]`);
    if (el?.textContent) return el.textContent;
  }
  return DEFAULT_EMAIL_HELPER;
}

type GuestReportData = { inputs: Record<string, unknown>; medications?: Record<string, unknown>[]; screenings?: Record<string, unknown>[] };

interface GuestEmailHook {
  email: string;
  setEmail: (v: string) => void;
  emailError: string;
  setEmailError: (v: string) => void;
  state: GuestEmailState;
  setState: (s: GuestEmailState) => void;
  helperText: string;
  handleSubmit: () => void;
}

function useGuestEmailCapture(guestReportData: GuestReportData): GuestEmailHook {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  // Returning local-first users who already captured: skip the email box and
  // land straight on the "Save as PDF" view (the flag lives in their own cloud).
  const [state, setState] = useState<GuestEmailState>(
    () => (LOCAL_FIRST && getReportEmailCaptured() ? 'captured' : 'idle'),
  );
  const helperText = useMemo(() => (LOCAL_FIRST ? LOCAL_FIRST_EMAIL_HELPER : getEmailHelperText()), []);

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError('');
    setState('sending');

    // Local-first: the button DELIVERS the plan — open the save-as-PDF window
    // FIRST (it builds client-side, so this stays inside the click's user
    // activation; opening after the network await would trip popup blockers),
    // then send the emailed copy in the background.
    if (LOCAL_FIRST) {
      const report = await getReportHtml();
      if (report.success && report.html) openPrintWindow(report.html);
    }

    const result = await sendGuestReport(
      trimmed,
      guestReportData.inputs,
      guestReportData.medications,
      guestReportData.screenings,
    );

    if (result.success) {
      trackABConversion();
      // Local-first: the PDF window already opened (the delivery). Persist the
      // captured flag to the user's own cloud and switch to the "Save as PDF"
      // view — no email box on return, nothing extra (no articles screen).
      if (LOCAL_FIRST) {
        markReportEmailCaptured();
        setState('captured');
      } else {
        setState('prompt-account');
      }
    } else {
      setEmailError(result.error || 'Failed to send. Please try again.');
      setState('idle');
    }
  };

  return { email, setEmail, emailError, setEmailError, state, setState, helperText, handleSubmit };
}

function GuestEmailCapture({ hook, loginUrl, formStage }: {
  hook: GuestEmailHook;
  loginUrl?: string;
  formStage?: number;
}) {
  const { email, setEmail, emailError, setEmailError, state, setState, helperText, handleSubmit } = hook;

  if (state === 'captured') {
    // Already captured (this submit, or a prior visit via the persisted flag):
    // the email box is gone and nothing renders here. The ungated "Save as PDF"
    // button lives inline in the "Your plan…" header (planHeaderMeta) instead.
    return null;
  }

  if (state === 'prompt-account') {
    // Production widget only — local-first routes success straight to
    // 'blog-posts' (no accounts; the cloud pitch lives on the SyncControl banner).
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
    <div className={`email-capture no-print${formStage === 3 ? ' field-attention' : ''}`}>
      <p className="email-guest-helper">{helperText}</p>
      <div className="email-capture-row">
        <input
          type="email"
          id={formStage !== undefined ? 'guestEmail' : undefined}
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

export function ResultsPanel({ results, isValid, authState, saveStatus, emailConfirmStatus, unitSystem, unitOverrides, hasUnsavedLongitudinal, onSaveLongitudinal, isSavingLongitudinal, onDeleteData, isDeleting, redirectFailed, reminderPreferences, onReminderPreferenceChange, onGlobalReminderOptout, sex, guestReportData, formStage, syncControl, remindersSection }: ResultsPanelProps) {
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
      openPrintWindow(result.html);
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

  // Shared state for guest email capture (top + bottom instances stay in sync)
  const guestEmailHook = useGuestEmailCapture(guestReportData ?? { inputs: {} });

  if (!isValid || !results) {
    return (
      <div className="health-results-panel">
        <ColumnHeader step={2} title="Your plan to discuss with your doctor" meta={null} muted />
        {syncControl ? syncControl({ hasData: false }) : <AccountStatus authState={authState} saveStatus={saveStatus} emailConfirmStatus={emailConfirmStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} redirectFailed={redirectFailed} />}
        <div className="plan-empty-preview">
          <p className="plan-empty-intro">
            <strong>Here's what your plan will look like.</strong> Real suggestions appear once you fill in your details.
          </p>
          <div className="stats-grid plan-empty-stats">
            <div className="stat-card stat-card--awaiting">
              <span className="stat-label">BMI</span>
              <span className="stat-value">—</span>
              <span className="stat-status">Awaiting</span>
            </div>
            <div className="stat-card stat-card--awaiting">
              <span className="stat-label">Ideal Body Weight</span>
              <span className="stat-value">—</span>
              <span className="stat-status">Awaiting</span>
            </div>
            <div className="stat-card stat-card--awaiting">
              <span className="stat-label">Protein Target</span>
              <span className="stat-value">—</span>
              <span className="stat-status">Awaiting</span>
            </div>
          </div>
          <div className="plan-empty-example">
            <span className="plan-empty-example-label">Example suggestion</span>
            <div className="suggestion-card priority-low plan-empty-example-card">
              <div className="suggestion-body">
                <h4 className="suggestion-title">Increase potassium-rich foods</h4>
                <p className="suggestion-desc">Aim for 3,500–5,000mg of potassium daily from fruits, vegetables, and legumes. High potassium intake supports healthy blood pressure and cardiovascular function.</p>
              </div>
            </div>
          </div>
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

  const emailLabel = emailStatus === 'sending' ? 'Sending...'
    : emailStatus === 'sent' ? 'Sent!'
    : emailStatus === 'error' ? 'Failed'
    : 'Email';
  const printLabel = printStatus === 'loading' ? 'Loading...'
    : printStatus === 'error' ? 'Failed'
    : LOCAL_FIRST ? 'Save as PDF'
    : 'Print';

  // Report actions: on the Shopify v2 surface the email-capture button IS the
  // PDF path (gated behind the email — Brad), so no standalone buttons. Pages
  // keeps an ungated Save-as-PDF; the mailto "Email Report" is gone on both v2
  // surfaces (degraded plain-text self-compose — the capture email is better).
  const planHeaderMeta = authState?.isLoggedIn && !SHOPIFY_SURFACE ? (
    <>
      <button type="button" className="action-btn-small no-print" onClick={handlePrint} disabled={printStatus === 'loading'} title={LOCAL_FIRST ? 'Save your plan as a PDF' : 'Print report'}>
        {printLabel}
      </button>
      {!LOCAL_FIRST && (
        <button type="button" className="action-btn-small no-print" onClick={handleEmailReport} disabled={emailStatus === 'sending'} title="Email report to yourself">
          {emailLabel}
        </button>
      )}
    </>
  ) : (SHOPIFY_SURFACE && guestEmailHook.state === 'captured') ? (
    // Shopify v2, post-capture: the email box is gone; the ungated Save-as-PDF
    // lives inline in this header (Brad). handlePrint = getReportHtml + print.
    <button type="button" className="action-btn-small no-print" onClick={handlePrint} disabled={printStatus === 'loading'} title="Save your plan as a PDF">
      {printLabel}
    </button>
  ) : null;

  return (
    <div className="health-results-panel">
      <ColumnHeader step={2} title="Your plan to discuss with your doctor" meta={planHeaderMeta} />
      {/* Account Status */}
      {syncControl ? syncControl({ hasData: true }) : <AccountStatus authState={authState} saveStatus={saveStatus} emailConfirmStatus={emailConfirmStatus} hasUnsavedLongitudinal={hasUnsavedLongitudinal} onSaveLongitudinal={onSaveLongitudinal} isSavingLongitudinal={isSavingLongitudinal} redirectFailed={redirectFailed} />}
      {guestReportData && <GuestEmailCapture hook={guestEmailHook} loginUrl={authState?.loginUrl} formStage={formStage} />}

      {/* Quick Stats */}
      <section className="quick-stats">
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

          {results.hba1c !== undefined && (() => {
            const s = getHba1cStatus(results.hba1c);
            return <StatCard label="HbA1c" value={<>{formatDisplayValue('hba1c', results.hba1c, usFor('hba1c'))} {getDisplayLabel('hba1c', usFor('hba1c'))}</>} status={{ label: s, className: statusClassMap[s] || '' }} evidence={STAT_CARD_EVIDENCE['hba1c']} />;
          })()}
        </div>
      </section>

      {/* Suggestions */}
      <section className="suggestions-section">
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

      {/* Report Actions (bottom) — logged-in users only. Hidden on the Shopify
          v2 surface (the email-capture button is the PDF path there). */}
      {authState?.isLoggedIn && !SHOPIFY_SURFACE && (
        <div className="report-actions no-print">
          <button type="button" className="action-btn" onClick={handlePrint} disabled={printStatus === 'loading'}>
            {printStatus === 'loading' ? 'Loading...' : printStatus === 'error' ? 'Failed' : LOCAL_FIRST ? 'Save as PDF' : 'Print Report'}
          </button>
          {!LOCAL_FIRST && (
            <button type="button" className="action-btn" onClick={handleEmailReport} disabled={emailStatus === 'sending'}>
              {emailStatus === 'sending' ? 'Sending...' : emailStatus === 'sent' ? 'Sent!' : emailStatus === 'error' ? 'Failed' : 'Email Report'}
            </button>
          )}
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

      {/* Email reminders. The local-first builds pass remindersSection (the cloud
          opt-in) and own the reminders UI; the server-backed ReminderSettings
          (per-category prefs via the Shopify proxy) is the live Shopify widget's
          version and would be a dead no-op on local-first, so the two are
          mutually exclusive. */}
      {remindersSection ? (
        remindersSection
      ) : authState?.isLoggedIn && onReminderPreferenceChange ? (
        <ReminderSettings
          preferences={reminderPreferences ?? []}
          onPreferenceChange={onReminderPreferenceChange}
          onGlobalOptout={onGlobalReminderOptout}
          sex={sex}
          age={results?.age}
        />
      ) : null}

      {guestReportData && <GuestEmailCapture hook={guestEmailHook} loginUrl={authState?.loginUrl} />}

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
