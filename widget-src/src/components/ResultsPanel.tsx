import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { AlcoholAnswer, HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type UnitSystem,
  type MetricType,
  type SuggestionEvidence,
  statTiles,
  statTileText,
  planSections,
  medicinesShown,
  type PlanCard,
} from '@roadmap/health-core';
// US-61 AC5: called only under SHOPIFY_SURFACE, so the Pages build drops the module.
import { usProductBlocks, type UsProductBlock, type UsProductOverlay } from '@roadmap/health-core/us-products';
import { getReportHtml, sendGuestReport, getReportEmailCaptured, markReportEmailCaptured } from '../lib/roadmap-data';
import { trackABConversion, trackProductEvent } from '../lib/server-api';
import { EMAIL_REGEX } from '../lib/email';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { getSkipEmailGate } from '../lib/assistant-config';
import { ColumnHeader } from './ColumnHeader';
import { StorageNotice } from '../lib/storage-notice';
import { FeedbackForm } from './FeedbackForm';
import { alcoholDismiss } from './AlcoholQuestion';
import { getMarketCountry } from '../lib/market-country';
import { observeVisibility } from '../lib/observe-visibility';
interface ResultsPanelProps {
  results: HealthResults | null;
  isValid: boolean;
  unitSystem: UnitSystem;
  unitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => Promise<unknown>;
  /** Resolves true once the data is erased (false if cancelled or failed). */
  onDeleteData?: () => Promise<boolean>;
  isDeleting?: boolean;
  sex?: 'male' | 'female';
  showEmailCapture?: boolean;
  formStage?: number;
  /** Cloud connection controls shared by Shopify and Pages. Hidden for new users
   *  until they have entered real data. `attention` (US-09 AC19): the guest has
   *  their PDF, so the storage button may pulse. */
  syncControl?: (ctx: { hasData: boolean; attention: boolean }) => React.ReactNode;
  /** The local-first email-reminders section (US-17), rendered as its own block
   *  lower in the plan — not bolted onto the sync line at the top. */
  remindersSection?: React.ReactNode;
  /** The panel's height changed outside its usual triggers (the phone's tab Swiper re-measures). */
  onLayoutChange?: () => void;
  /** US-60: save the answer the "Reduce alcohol intake" card's Dismiss asks for; absent once answered. */
  onAlcoholAnswer?: (answer: AlcoholAnswer) => void;
}

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

type AlcoholAnswerFn = (answer: AlcoholAnswer) => void;

/** US-61 AC4: Brad's product on a US adult's supplement card, at the card's foot. Never printed. */
function UsProductBlockView({ block }: { block: UsProductBlock }) {
  return (
    <div className="us-product no-print">
      <p className="us-product-line">{block.line}</p>
      <a
        className="us-product-link"
        href={block.url}
        target="_blank"
        rel="noopener"
        onClick={() => trackProductEvent('us_product_link_clicked', { product: block.product })}
      >
        {block.name}<span aria-hidden="true"> ↗</span>
      </a>
    </div>
  );
}

const NO_US_OVERLAY: UsProductOverlay = { blocks: [], ownershipLine: null };

function SuggestionCard({ suggestion, highlighted, fadingOut, onAlcoholAnswer, usBlock }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean; onAlcoholAnswer?: AlcoholAnswerFn; usBlock?: UsProductBlock }) {
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
          {alcoholDismiss(suggestion, onAlcoholAnswer)}
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
        {suggestion.ingredients && suggestion.ingredients.length > 0 && (
          <ul className="suggestion-ingredients">
            {suggestion.ingredients.map(ing => (
              <li key={ing}>{ing}</li>
            ))}
          </ul>
        )}
      </div>
      {hasEvidence && <SuggestionEvidence suggestion={suggestion} open={evidenceOpen} onToggle={toggleEvidence!} />}
      {usBlock && <UsProductBlockView block={usBlock} />}
    </div>
  );
}

function GroupedSubsection({ suggestion, highlighted, fadingOut, onAlcoholAnswer }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean; onAlcoholAnswer?: AlcoholAnswerFn }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const dismiss = alcoholDismiss(suggestion, onAlcoholAnswer);
  const toggleEvidence = hasEvidence ? () => setEvidenceOpen(o => !o) : undefined;

  return (
    <div className={`suggestion-subsection${highlightClass}${hasEvidence ? ' suggestion-subsection-clickable' : ''}`}>
      {dismiss && <div className="suggestion-subsection-actions">{dismiss}</div>}
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

function GroupedSuggestionCard({ card, highlightedIds, fadingOutIds, onAlcoholAnswer }: { card: PlanCard; highlightedIds?: Set<string>; fadingOutIds?: Set<string>; onAlcoholAnswer?: AlcoholAnswerFn }) {
  const { suggestions, category, priority: highestPriority } = card;

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
          <GroupedSubsection key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} onAlcoholAnswer={onAlcoholAnswer} />
        ))}
      </div>
    </div>
  );
}

/** US-61 AC2: a US card's own text and references, in place of the card's, when it has them. */
function withUsText(suggestion: Suggestion, block?: UsProductBlock): Suggestion {
  return block?.description ? { ...suggestion, description: block.description, references: block.references } : suggestion;
}

/** A section's cards: grouped ones as one card, the rest one card each (layout: planSections).
 *  `usBlocks` (US-61) sit on single cards only. */
function renderCards(cards: PlanCard[], highlightedIds: Set<string>, fadingOutIds: Set<string>, onAlcoholAnswer?: AlcoholAnswerFn, usBlocks?: ReadonlyMap<string, UsProductBlock>) {
  return cards.map((card) => {
    if (card.suggestions.length > 1) {
      return <GroupedSuggestionCard key={card.category} card={card} highlightedIds={highlightedIds} fadingOutIds={fadingOutIds} onAlcoholAnswer={onAlcoholAnswer} />;
    }
    const s = card.suggestions[0];
    const usBlock = usBlocks?.get(s.id);
    return <SuggestionCard key={s.id} suggestion={withUsText(s, usBlock)} highlighted={highlightedIds.has(s.id)} fadingOut={fadingOutIds.has(s.id)} onAlcoholAnswer={onAlcoholAnswer} usBlock={usBlock} />;
  });
}

// 'skipped' + 'reminded' are US-44's funnel-page states: the block skips the
// email gate, so the box only offers reminders; only a successful sign-up persists.
type GuestEmailState = 'idle' | 'sending' | 'captured' | 'skipped' | 'reminded';

// On local-first the capture button DELIVERS the plan by opening the browser
// save-as-PDF window; the email field only subscribes to Klaviyo (no plan is
// emailed). Copy reflects that (Brad, 2026-06-15) — no A/B helper variants on v2.
export const LOCAL_FIRST_EMAIL_HELPER = 'Get a PDF of your personalized plan, with detailed explanations and clinical references for every suggestion.';

/** Button label on the guest plan-capture CTA. On every live (LOCAL_FIRST)
 *  surface the click opens the browser save-as-PDF window, so the label is
 *  PDF-accurate (the email field only subscribes to Klaviyo). */
export const GUEST_CAPTURE_BUTTON_LABEL = 'Get My Health Plan';

/** US-44: the funnel page's optional reminders line (no email gate there). */
export const REMINDER_SIGNUP_LABEL = 'Email me when a check-up is due';
const REMINDER_SIGNUP_HELPER = "Optional. You don't need this to save your PDF.";
const REMINDER_SIGNUP_BUTTON = 'Remind me';
export const REMINDER_SIGNUP_DONE = "You're signed up. We'll email you when a check-up is due.";

/** US-18 AC6: shown beside the Save as PDF pressed when the browser refuses
 *  the print window. No claim the plan is saved here (a device that refused
 *  storage runs from memory), and never another browser: it would not hold
 *  this plan. */
export const PDF_WINDOW_BLOCKED = "The PDF window didn't open. Try Save as PDF again. Some apps' built-in browsers block it.";

/** The button whose print window was refused: the note sits beside it. */
type PdfButton = 'header' | 'bottom' | 'capture';

/** US-18 AC6: always mounted and emptied before each try, so every refusal is announced. */
function PdfNote({ show }: { show: boolean }) {
  return <span className="hr-pdf-blocked no-print" role="status">{show ? PDF_WINDOW_BLOCKED : ''}</span>;
}

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

interface GuestEmailHook {
  email: string;
  setEmail: (v: string) => void;
  emailError: string;
  setEmailError: (v: string) => void;
  state: GuestEmailState;
  helperText: string;
  handleSubmit: () => void;
  /** US-44: this page's block skips the email gate (read from the page, never stored). */
  gateSkipped?: boolean;
}

function useGuestEmailCapture(printReport: () => Promise<void>): GuestEmailHook {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  // US-44: the page decides, once per mount. Never written to the record.
  const [gateSkipped] = useState(getSkipEmailGate);
  // Returning local-first users who already captured: skip the email box and
  // land straight on the "Save as PDF" view (the flag lives in their own cloud).
  const [state, setState] = useState<GuestEmailState>(
    () => (getReportEmailCaptured() ? 'captured' : gateSkipped ? 'skipped' : 'idle'),
  );
  const helperText = LOCAL_FIRST_EMAIL_HELPER;

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError('');
    setState('sending');

    if (gateSkipped) {
      // US-44 AC3: reminders only. The PDF has its own button, so no print
      // window. Same enrolment call as below. A successful sign-up marks the
      // record captured (Brad, 2026-10-03), so the plan-ready and reminder
      // emails' link back to /pages/roadmap doesn't ask for the email again.
      const result = await sendGuestReport(trimmed);
      if (result.success) {
        markReportEmailCaptured();
        setState('reminded');
      } else {
        setEmailError(result.error || 'Failed to send. Please try again.');
        setState('skipped');
      }
      return;
    }

    // Local-first: the button DELIVERS the plan — open the save-as-PDF window
    // FIRST (it builds client-side, so this stays inside the click's user
    // activation; opening after the network await would trip popup blockers),
    // then subscribe the email to Klaviyo in the background (no plan is emailed).
    await printReport();

    const result = await sendGuestReport(trimmed);

    if (result.success) {
      trackABConversion();
      // Local-first: the PDF window already opened (the delivery). Persist the
      // captured flag to the user's own cloud and switch to the "Save as PDF"
      // view — no email box on return, nothing extra (no articles screen).
      markReportEmailCaptured();
      setState('captured');
    } else {
      setEmailError(result.error || 'Failed to send. Please try again.');
      setState('idle');
    }
  };

  return { email, setEmail, emailError, setEmailError, state, helperText, handleSubmit, gateSkipped };
}

/** US-44: the funnel page's box. The gate is skipped (Save as PDF sits in the
 *  plan header), so this only enrols check-up reminders, and only if asked. */
function ReminderSignup({ hook }: { hook: GuestEmailHook }) {
  const { email, setEmail, emailError, setEmailError, state, handleSubmit } = hook;

  if (state === 'reminded') {
    return (
      <div className="email-capture no-print">
        <p className="email-guest-helper" role="status">{REMINDER_SIGNUP_DONE}</p>
      </div>
    );
  }

  return (
    <div className="email-capture no-print">
      <label htmlFor="reminderEmail" className="email-capture-label">{REMINDER_SIGNUP_LABEL}</label>
      <p className="email-guest-helper">{REMINDER_SIGNUP_HELPER}</p>
      <div className="email-capture-row">
        <input
          type="email"
          id="reminderEmail"
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
          {state === 'sending' ? 'Sending...' : REMINDER_SIGNUP_BUTTON}
        </button>
      </div>
      {emailError && <span className="email-capture-error">{emailError}</span>}
      {/* US-23 AC4 + AC11 — the same disclosure, worded for a sign-up that no
          longer stands between the visitor and their plan. */}
      <p className="email-capture-disclosure">
        Signing up adds you to the <strong>MicroVitamin mailing list</strong> (Dr Brad's
        supplement company), and we'll email you when a check-up or blood test is due. We store only
        check-up names and dates, never your results. Every email has a one-click unsubscribe.
      </p>
      <StorageNotice surface="email" className="email-guest-helper" />
    </div>
  );
}

export function GuestEmailCapture({ hook, formStage, pdfBlocked }: {
  hook: GuestEmailHook;
  formStage?: number;
  /** US-18 AC6: this capture's print window was refused. */
  pdfBlocked?: boolean;
}) {
  const { email, setEmail, emailError, setEmailError, state, helperText, handleSubmit } = hook;

  if (state === 'captured') {
    // Already captured (this submit, or a prior visit via the persisted flag):
    // the email box is gone and nothing renders here. The ungated "Save as PDF"
    // button lives inline in the "Your plan…" header (planHeaderMeta) instead.
    return null;
  }

  if (hook.gateSkipped) return <ReminderSignup hook={hook} />;

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
          {state === 'sending' ? 'Sending...' : GUEST_CAPTURE_BUTTON_LABEL}
        </button>
      </div>
      {emailError && <span className="email-capture-error">{emailError}</span>}
      <PdfNote show={!!pdfBlocked && !!emailError} />
      {/* US-23 AC4 — typing the email IS the reminders enrolment (opt-out
          model), so the disclosure sits beside the box, not behind a click.
          Names what crosses (check-up names + dates) and the way out.
          US-23 AC11 — it also names the list: the server records marketing
          consent, and every sign-up joins MicroVitamin's list. */}
      <p className="email-capture-disclosure">
        Getting your plan adds you to the <strong>MicroVitamin mailing list</strong> (Dr Brad's
        supplement company), and we'll email you when a check-up or blood test is due. We store only
        check-up names and dates, never your results. Every email has a one-click unsubscribe.
      </p>
      <StorageNotice surface="email" className="email-guest-helper" />
    </div>
  );
}

export function ResultsPanel({ results, isValid, unitSystem, unitOverrides, hasUnsavedLongitudinal, onSaveLongitudinal, onDeleteData, isDeleting, sex, showEmailCapture, formStage, syncControl, remindersSection, onLayoutChange, onAlcoholAnswer }: ResultsPanelProps) {
  // Track highlighted (new/changed) suggestion IDs
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [fadingOutIds, setFadingOutIds] = useState<Set<string>>(new Set());
  const baselineRef = useRef<Map<string, { title: string; description: string }>>(new Map());
  const settledRef = useRef(false);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Report actions state (shared between top and bottom buttons)
  const [printStatus, setPrintStatus] = useState<'idle' | 'loading'>('idle');
  // US-18 AC6: where the last print window was refused (or its report could
  // not be built). A window that opens clears it, and so does an erase.
  const [pdfBlocked, setPdfBlocked] = useState<PdfButton | null>(null);
  if (!results && pdfBlocked) setPdfBlocked(null);
  // US-09 AC19: a print window opened in this tab (the gate-skipped page's PDF).
  // Only an erase forgets it: the plan also goes blank mid-edit.
  const [pdfOpened, setPdfOpened] = useState(false);
  // Emptied first (inside the click) so a repeat refusal is announced again.
  const printReport = async (at: PdfButton) => {
    setPdfBlocked(null);
    const report = await getReportHtml();
    const opened = report.success && !!report.html && openPrintWindow(report.html);
    setPdfBlocked(opened ? null : at);
    if (opened) setPdfOpened(true);
    else trackProductEvent('pdf_window_blocked');
  };

  const handlePrint = async (at: PdfButton) => {
    if (printStatus === 'loading') return;
    setPrintStatus('loading');
    setPdfBlocked(null); // before the save's await, for the same reason
    // Include pending longitudinal values in the locally generated report.
    if (hasUnsavedLongitudinal && onSaveLongitudinal) {
      try { await onSaveLongitudinal(); } catch { /* proceed with saved data */ }
    }
    await printReport(at);
    setPrintStatus('idle');
  };

  // Settle after 3s — skip highlighting during initial load + Phase 2 API overwrite
  useEffect(() => {
    const timer = setTimeout(() => { settledRef.current = true; }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Funnel signal: the user reached actual results (suggestions rendered).
  // trackProductEvent self-throttles to once per tab session.
  const hasSuggestions = (results?.suggestions?.length ?? 0) > 0;
  useEffect(() => {
    if (hasSuggestions) trackProductEvent('results_viewed');
  }, [hasSuggestions]);

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
  const guestEmailHook = useGuestEmailCapture(() => printReport('capture'));

  // The note (and the capture box it can sit in) changes the plan's height.
  useEffect(() => { onLayoutChange?.(); }, [pdfBlocked, guestEmailHook.emailError, guestEmailHook.state]);
  // Above the early return, as hooks must be; worked out again only when their inputs change.
  const tiles = useMemo(() => (results ? statTiles(results, { unitSystem, unitOverrides, sex }) : []), [results, unitSystem, unitOverrides, sex]);

  // US-61 AC5: Brad's products for a known adult in the US, on the Shopify build only.
  const usOverlay = useMemo(() => (SHOPIFY_SURFACE && results
    ? usProductBlocks(results.suggestions, medicinesShown(results), getMarketCountry() === 'US', 'web')
    : NO_US_OVERLAY), [results]);
  const usBlocks = useMemo(() => new Map(usOverlay.blocks.map((b) => [b.suggestionId, b])), [usOverlay]);
  // US-61 AC8: once the Supplements section is on screen, one count per product
  // (trackProductEvent keeps one per product per tab session).
  const supplementsRef = useRef<HTMLDivElement>(null);
  const usProducts = [...new Set(usOverlay.blocks.map((b) => b.product))].join(' ');
  useEffect(() => {
    const el = supplementsRef.current;
    if (!el || !usProducts) return;
    let counted = false; // without IntersectionObserver the callback runs before observeVisibility returns
    return observeVisibility(el, (visible) => {
      if (!visible || counted) return;
      counted = true;
      for (const product of usProducts.split(' ') as UsProductBlock['product'][]) trackProductEvent('us_product_shown', { product });
    });
  }, [usProducts]);

  // US-09 AC19: the guest has their PDF (or, on the gate-skipped page, signed up
  // for reminders, which marks the record captured). Never before, so the storage
  // button's pulse never competes with the email box. A known minor has no email
  // box: their header Save as PDF counts, as on the gate-skipped page (US-07 AC6).
  const { state: emailState, gateSkipped } = guestEmailHook;
  // Pages has no email gate or funnel, even for a record captured on Shopify.
  const attention = SHOPIFY_SURFACE && (emailState === 'captured' || emailState === 'reminded' || ((!!gateSkipped || !!results?.knownMinor) && pdfOpened));

  if (!isValid || !results) {
    return (
      <div className="health-results-panel">
        <ColumnHeader step={2} title="Your plan to discuss with your doctor" meta={null} muted />
        {syncControl?.({ hasData: false, attention })}
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

  // US-07 AC6: a known minor's tiles keep the values and drop every adult
  // reading of them (health-core statTiles); here, no email and no reminders.
  const adult = !results.knownMinor;
  // US-07 AC6: a known minor is never asked for an email (either box joins the
  // mailing list). Their PDF is the gate-skipped page's Save as PDF (US-44 AC2).
  const emailCapture = showEmailCapture && adult;


  const printLabel = printStatus === 'loading' ? 'Loading...' : 'Save as PDF';
  const headerNote = <PdfNote show={pdfBlocked === 'header' || pdfBlocked === 'capture'} />;

  // Report actions: on the Shopify v2 surface the email-capture button IS the
  // PDF path (gated behind the email — Brad), so no standalone buttons. Pages
  // keeps an ungated Save-as-PDF; the mailto "Email Report" is gone on both v2
  // surfaces (degraded plain-text self-compose — the capture email is better).
  const planHeaderMeta = !SHOPIFY_SURFACE ? (
    <>
      <button type="button" className="action-btn-small no-print" onClick={() => handlePrint('header')} disabled={printStatus === 'loading'} title="Save your plan as a PDF">
        {printLabel}
      </button>
      {headerNote}
    </>
  ) : (SHOPIFY_SURFACE && (guestEmailHook.state === 'captured' || guestEmailHook.gateSkipped || !adult)) ? (
    // Shopify v2, post-capture (or US-44's gate-skipped page, or a known minor): the ungated
    // Save-as-PDF lives inline in this header (Brad). handlePrint = getReportHtml + print.
    <>
      <button type="button" className="action-btn-small no-print" onClick={() => handlePrint('header')} disabled={printStatus === 'loading'} title="Save your plan as a PDF">
        {printLabel}
      </button>
      {headerNote}
    </>
  ) : null;

  return (
    <div className="health-results-panel">
      <ColumnHeader step={2} title="Your plan to discuss with your doctor" meta={planHeaderMeta} actions={planHeaderMeta !== null} />
      {/* Cloud connection */}
      {syncControl?.({ hasData: true, attention })}
      {emailCapture && <GuestEmailCapture hook={guestEmailHook} formStage={formStage} pdfBlocked={pdfBlocked === 'capture'} />}

      {/* Quick Stats */}
      <section className="quick-stats">
        <div className="stats-grid">
          {tiles.map((tile) => (
            <StatCard
              key={tile.key}
              label={tile.label}
              value={statTileText(tile)}
              status={tile.status && { label: tile.status.label, className: tile.status.tone ? `status-${tile.status.tone}` : '' }}
              evidence={tile.evidence}
            />
          ))}
        </div>
      </section>

      {/* Suggestions */}
      <section className="suggestions-section">
        {planSections(results.suggestions).map((section) => (
          <div key={section.key} ref={section.key === 'supplements' ? supplementsRef : undefined} className={`suggestions-group${section.key === 'skin' || section.key === 'supplements' ? ` ${section.key}-group` : ''}`}>
            <h4 className={`suggestions-group-title ${section.key}`}>{section.title}</h4>
            {renderCards(section.cards, highlightedIds, fadingOutIds, onAlcoholAnswer, section.key === 'supplements' ? usBlocks : undefined)}
            {section.key === 'supplements' && usOverlay.ownershipLine && <p className="us-ownership no-print">{usOverlay.ownershipLine}</p>}
          </div>
        ))}
      </section>

      {/* Health Records — documents from uploads */}

      {/* Report Actions (bottom). Hidden on the Shopify
          v2 surface (the email-capture button is the PDF path there). */}
      {!SHOPIFY_SURFACE && (
        <div className="report-actions no-print">
          <button type="button" className="action-btn" onClick={() => handlePrint('bottom')} disabled={printStatus === 'loading'}>
            {printLabel}
          </button>
          <PdfNote show={pdfBlocked === 'bottom'} />
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

      {/* Email reminders (US-17 cloud opt-in). The server-backed per-category
          ReminderSettings that used to share this slot died with the v1 CRUD
          layer — both v2 builds always pass remindersSection, so it was
          unreachable (deleted 2026-08-13). US-07 AC6: none for a known minor,
          who is never enrolled and must see no mailing-list box. */}
      {adult && remindersSection}

      {/* US-44: the gate-skipped reminders box renders once, at the top. */}
      {emailCapture && !guestEmailHook.gateSkipped && <GuestEmailCapture hook={guestEmailHook} pdfBlocked={pdfBlocked === 'capture'} />}

      {SHOPIFY_SURFACE && <FeedbackForm />}

      <div className="privacy-notice-link">
        <a
          href="https://drstanfield.com/pages/connector-privacy"
          target="_blank"
          rel="noopener"
        >
          How your health data is handled
        </a>
      </div>

      {onDeleteData && (
        <div className="delete-data-section">
          <button
            className="delete-data-link"
            onClick={async () => { if (await onDeleteData()) setPdfOpened(false); }}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete All My Data'}
          </button>
        </div>
      )}
    </div>
  );
}
