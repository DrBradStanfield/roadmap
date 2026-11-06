// The plan's parts on My health (US-62 AC17-AC26): its cards by topic, a
// suggestion on its row, the tiles under the onboarding, and the foot. The plan
// has no column of its own since phase 5; usePlanView builds what InputPanel draws.
import React, { useState, useRef, useEffect, useId, useMemo } from 'react';
import { flushSync } from 'react-dom';
import type { HealthResults, Suggestion } from '@roadmap/health-core';
import {
  type SuggestionEvidence,
  statTileText,
  type StatTile,
  planSections,
  topicSections,
  type FormSection,
  type PlanCard,
  type TopicCard,
  type TopicLayout,
} from '@roadmap/health-core';
// US-61 AC5: called only under SHOPIFY_SURFACE, so the Pages build drops the module.
import { usProductSections, type UsPlanSection, type UsProduct, type UsProductBlock, type UsSuggestion } from '@roadmap/health-core/us-products';
import { getReportHtml, sendGuestReport, getReportEmailCaptured, markReportEmailCaptured } from '../lib/roadmap-data';
import { trackABConversion, trackProductEvent } from '../lib/server-api';
import { EMAIL_REGEX } from '../lib/email';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { getSkipEmailGate } from '../lib/assistant-config';
import { GuideLink } from './GuideLink';
import { FeedbackForm } from './FeedbackForm';
import { alcoholDismiss, type AlcoholQuestion } from './AlcoholQuestion';
import { CategoryIcon } from './icons';
import { getMarketCountry } from '../lib/market-country';
import { observeVisibility } from '../lib/observe-visibility';

/** A control that opens a card's evidence by mouse or keyboard (US-07 AC16):
 *  focusable, says whether it is open, and Enter or Space toggles it. Enter or
 *  Space on a link inside an open tile is left to the link. Without `toggle`, nothing. */
function evidenceToggle(open: boolean, toggle: (() => void) | undefined) {
  if (!toggle) return {};
  return {
    role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: toggle,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); // Space would scroll the page
      toggle();
    },
  };
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
         {...evidenceToggle(open, hasDetail ? () => setOpen(o => !o) : undefined)}>
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
          <span className="evidence-toggle" {...evidenceToggle(open, onToggle)}>{open ? '▾' : '▸'} Why this suggestion?</span>
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

function SuggestionCard({ suggestion, highlighted, fadingOut, alcoholQuestion, usBlock }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean; alcoholQuestion?: AlcoholQuestion; usBlock?: UsProductBlock }) {
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
          <span className="suggestion-header-lead">
            <CategoryIcon category={suggestion.category}/>
            <span className={`suggestion-badge ${priorityColors[suggestion.priority]}`}>
              {suggestion.priority === 'urgent' && '⚠️ '}
              {suggestion.category.replace(/_/g, ' ')}
            </span>
          </span>
          {alcoholDismiss(suggestion, alcoholQuestion)}
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

function GroupedSubsection({ suggestion, highlighted, fadingOut, alcoholQuestion }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean; alcoholQuestion?: AlcoholQuestion }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const dismiss = alcoholDismiss(suggestion, alcoholQuestion);
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

function GroupedSuggestionCard({ card, highlightedIds, fadingOutIds, alcoholQuestion }: { card: Pick<PlanCard, 'category' | 'priority' | 'suggestions'>; highlightedIds?: Set<string>; fadingOutIds?: Set<string>; alcoholQuestion?: AlcoholQuestion }) {
  const { suggestions, category, priority: highestPriority } = card;

  return (
    <div className={`suggestion-card grouped-card ${priorityColors[highestPriority]}`}>
      <div className="suggestion-header">
        <span className="suggestion-header-lead">
          <CategoryIcon category={category}/>
          <span className={`suggestion-badge ${priorityColors[highestPriority]}`}>
            {highestPriority === 'urgent' && '⚠️ '}
            {category.replace(/_/g, ' ')}
          </span>
        </span>
      </div>
      <div className="grouped-subsections">
        {suggestions.map((s) => (
          <GroupedSubsection key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} alcoholQuestion={alcoholQuestion} />
        ))}
      </div>
    </div>
  );
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
type PdfButton = 'bottom' | 'capture';

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
  // US-18 AC7: one send at a time. The button is disabled while sending, but
  // Enter in the box (either copy of it) reaches here too.
  const sending = useRef(false);

  const handleSubmit = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      await submit();
    } finally {
      sending.current = false;
    }
  };

  const submit = async () => {
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
    // button sits beside it in My health's foot instead.
    return null;
  }

  if (hook.gateSkipped) return <ReminderSignup hook={hook} />;

  return (
    <div className={`email-capture no-print${formStage === 4 ? ' field-attention' : ''}`}>
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
    </div>
  );
}

/** The plan's view on My health (US-62 AC17-AC26): its cards by topic (health-core's
 *  `topicSections`, with US-61's overlay on Shopify), the new-card highlight, the urgent
 *  banner's target, and the foot. Built once, in HealthTool; InputPanel draws it. */
export interface PlanView {
  layout: TopicLayout<UsSuggestion>;
  highlights: Highlights;
  alcoholQuestion?: AlcoholQuestion;
  /** The first urgent card in topic order, for the banner (US-62 AC19). */
  urgent: { title: string; cardId: string } | null;
  /** US-61 AC8: on the Supplements section, so its products count once it is on screen. */
  supplementsRef: React.RefObject<HTMLElement>;
  /** The foot: the PDF box and email, Save as PDF, the disclaimer, feedback, Supercharge, privacy. */
  foot: React.ReactNode;
  /** US-09 AC19: the guest has their PDF, so the storage card may pulse. */
  attention: boolean;
  /** An erase forgets the PDF this tab opened. */
  onErased: () => void;
  /** The plan as Save as PDF prints it (US-08): drawn, hidden, only while getReportHtml copies it. */
  report: React.ReactNode;
}

interface Highlights { highlighted: Set<string>; fadingOut: Set<string> }

/** A card's DOM id on My health: the banner scrolls to it (US-62 AC19). */
export const cardDomId = (card: { suggestions: Array<{ id: string }> }) => `hr-card-${card.suggestions.map(s => s.id).join('--')}`;

/** New or changed suggestions glow for 3s, then fade, once the plan has settled (3s after mount). */
function useHighlights(suggestions: Suggestion[] | undefined): Highlights {
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const baselineRef = useRef<Map<string, { title: string; description: string }>>(new Map());
  const settledRef = useRef(false);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Settle after 3s: skip highlighting during the initial load.
  useEffect(() => {
    const timer = setTimeout(() => { settledRef.current = true; }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const current = suggestions ?? [];
    const currentMap = new Map(current.map(s => [s.id, { title: s.title, description: s.description }]));
    // Before settling, and for the first batch, the plan is the baseline: nothing glows.
    if (!settledRef.current || (baselineRef.current.size === 0 && currentMap.size > 0)) {
      baselineRef.current = currentMap;
      return;
    }
    const next = new Set<string>();
    for (const s of current) {
      const prev = baselineRef.current.get(s.id);
      if (!prev || prev.title !== s.title || prev.description !== s.description) next.add(s.id);
    }
    // Cancel any fade-out in progress.
    if (fadeOutTimeoutRef.current) clearTimeout(fadeOutTimeoutRef.current);
    setFadingOut(new Set());
    setHighlighted(next);
    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    clearTimeoutRef.current = setTimeout(() => {
      setFadingOut(next);
      setHighlighted(new Set());
      fadeOutTimeoutRef.current = setTimeout(() => {
        setFadingOut(new Set());
        baselineRef.current = currentMap;
      }, 500);
    }, 3000);
    return () => {
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
      if (fadeOutTimeoutRef.current) clearTimeout(fadeOutTimeoutRef.current);
    };
  }, [suggestions]);
  return { highlighted, fadingOut };
}

/** One topic's cards, each with its DOM id; a grouped card as one card (US-62 AC18). */
export function PlanCardList({ cards, plan }: { cards: ReadonlyArray<TopicCard<UsSuggestion>>; plan: PlanView }) {
  const { highlighted, fadingOut } = plan.highlights;
  return (
    <>
      {cards.map((card) => {
        const id = cardDomId(card);
        const s = card.suggestions[0];
        return (
          <div key={id} id={id} tabIndex={-1} className="mh-card">
            {card.suggestions.length > 1
              ? <GroupedSuggestionCard card={card} highlightedIds={highlighted} fadingOutIds={fadingOut} alcoholQuestion={plan.alcoholQuestion} />
              : <SuggestionCard suggestion={s} highlighted={highlighted.has(s.id)} fadingOut={fadingOut.has(s.id)} alcoholQuestion={plan.alcoholQuestion} usBlock={s.usProduct} />}
          </div>
        );
      })}
    </>
  );
}

/**
 * The plan's suggestions on a row (US-62 AC20): a medicine's title as one line,
 * a screening's text (`describes`); the info button opens the rest (the text, or
 * the title) and the evidence. Coloured by priority, so an urgent one reads as one here too.
 */
export function RowSuggestions({ suggestions, describes = false }: { suggestions: readonly Suggestion[]; describes?: boolean }) {
  return <>{suggestions.map(s => <RowSuggestion key={s.id} suggestion={s} describes={describes}/>)}</>;
}

function RowSuggestion({ suggestion, describes }: { suggestion: Suggestion; describes: boolean }) {
  const [open, setOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const detailId = useId();
  return (
    <div className={`mh-row-suggestion ${priorityColors[suggestion.priority]}`} data-suggestion={suggestion.id}>
      <div className="mh-row-suggestion-line">
        <span className="mh-row-suggestion-text">{describes ? suggestion.description : suggestion.title}</span>
        <button type="button" className="mh-info-btn" aria-expanded={open} aria-controls={detailId}
                aria-label={`About: ${suggestion.title}`} onClick={() => setOpen(o => !o)}>
          <span aria-hidden="true">i</span>
        </button>
      </div>
      {open && (
        <div id={detailId} className="mh-row-suggestion-detail">
          {describes ? <p className="mh-row-suggestion-title">{suggestion.title}</p> : <p className="suggestion-desc">{suggestion.description}</p>}
          <SuggestionEvidence suggestion={suggestion} open={evidenceOpen} onToggle={() => setEvidenceOpen(o => !o)} />
        </div>
      )}
    </div>
  );
}

/** The plan's tiles (US-25 AC22), under the onboarding while it runs (US-62 AC25). */
export function QuickStats({ tiles }: { tiles: StatTile[] }) {
  return (
    <section className="quick-stats">
      <div className="stats-grid">
        {tiles.map((tile) => <PlanTile key={tile.key} tile={tile}/>)}
      </div>
    </section>
  );
}

/** One tile, its evidence a press away: in the tiles, and on its row's page (US-62 AC26). */
export function PlanTile({ tile }: { tile: StatTile }) {
  return (
    <StatCard
      label={tile.label}
      value={statTileText(tile)}
      status={tile.status && { label: tile.status.label, className: tile.status.tone ? `status-${tile.status.tone}` : '' }}
      evidence={tile.evidence}
    />
  );
}

/** What the plan looks like before there is one (no valid height yet). */
export function PlanEmptyPreview() {
  return (
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
  );
}

const NO_HIGHLIGHTS = new Set<string>();

/**
 * The plan as its PDF has always printed it (US-08, US-18): the tiles, then the
 * suggestions by priority (planSections), then the disclaimer. Hidden, and drawn
 * only while getReportHtml copies it: My health shows the same cards by topic.
 */
function PlanReport({ tiles, sections, alcoholQuestion }: { tiles: StatTile[]; sections: UsPlanSection[]; alcoholQuestion?: AlcoholQuestion }) {
  return (
    <div className="health-results-panel hr-report" hidden>
      <QuickStats tiles={tiles}/>
      <section className="suggestions-section">
        {sections.map((section) => (
          <div key={section.key} className={`suggestions-group${section.key === 'skin' || section.key === 'supplements' ? ` ${section.key}-group` : ''}`}>
            <h4 className={`suggestions-group-title ${section.key}`}>{section.title}</h4>
            {section.cards.map((card) => (card.suggestions.length > 1
              ? <GroupedSuggestionCard key={card.category} card={card} highlightedIds={NO_HIGHLIGHTS} fadingOutIds={NO_HIGHLIGHTS} alcoholQuestion={alcoholQuestion} />
              : <SuggestionCard key={card.suggestions[0].id} suggestion={card.suggestions[0]} alcoholQuestion={alcoholQuestion} />))}
          </div>
        ))}
      </section>
      <div className="health-disclaimer">
        <strong>Disclaimer:</strong> {DISCLAIMER}
      </div>
    </div>
  );
}

/** The plan's disclaimer, on the page's foot and in its PDF. */
const DISCLAIMER = 'This tool is for educational purposes only and is not a substitute for professional medical advice. '
  + 'Always consult with your healthcare provider before making any health decisions. '
  + 'Suggestions are based on general guidelines and may not apply to your individual situation.';

interface PlanViewOptions {
  results: HealthResults | null;
  isValid: boolean;
  /** The plan's tiles, for the PDF. */
  tiles: StatTile[];
  /** The form's questions, so a medicine or screening suggestion sits on the row that asks it. */
  forms: { medications: readonly FormSection[]; screenings: readonly FormSection[] };
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => Promise<unknown>;
  showEmailCapture?: boolean;
  formStage?: number;
  alcoholQuestion?: AlcoholQuestion;
}

export function usePlanView({ results, isValid, tiles, forms, hasUnsavedLongitudinal, onSaveLongitudinal, showEmailCapture, formStage, alcoholQuestion }: PlanViewOptions): PlanView {
  const highlights = useHighlights(results?.suggestions);

  const [printStatus, setPrintStatus] = useState<'idle' | 'loading'>('idle');
  // US-18 AC6: where the last print window was refused (or its report could
  // not be built). A window that opens clears it, and so does an erase.
  const [pdfBlocked, setPdfBlocked] = useState<PdfButton | null>(null);
  if (!results && pdfBlocked) setPdfBlocked(null);
  // US-09 AC19: a print window opened in this tab (the gate-skipped page's PDF).
  // Only an erase forgets it: the plan also goes blank mid-edit.
  const [pdfOpened, setPdfOpened] = useState(false);
  // The PDF's copy of the plan is drawn only while it is copied (PlanReport).
  const [printing, setPrinting] = useState(false);
  // Emptied first (inside the click) so a repeat refusal is announced again.
  const printReport = async (at: PdfButton) => {
    setPdfBlocked(null);
    // Drawn synchronously, inside the click, so getReportHtml copies it before its first await.
    flushSync(() => setPrinting(true));
    const pending = getReportHtml();
    setPrinting(false);
    const report = await pending;
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

  const guestEmailHook = useGuestEmailCapture(() => printReport('capture'));

  // US-61 AC5: Brad's products for a known adult in the US, on the Shopify build only.
  const sections = useMemo((): UsPlanSection[] => {
    if (!results) return [];
    const plain = planSections(results.suggestions);
    return (SHOPIFY_SURFACE && usProductSections(plain, results, getMarketCountry() === 'US', 'web')) || plain;
  }, [results]);
  const layout = useMemo(() => topicSections(sections, forms), [sections, forms]);
  // The banner names the first urgent card in topic order (US-62 AC19).
  const urgent = useMemo(() => {
    for (const section of layout.sections) {
      const card = section.cards.find(c => c.priority === 'urgent');
      if (card) return { title: (card.suggestions.find(s => s.priority === 'urgent') ?? card.suggestions[0]).title, cardId: cardDomId(card) };
    }
    return null;
  }, [layout]);

  // US-61 AC8: once the Supplements section is on screen, one count per product
  // (trackProductEvent keeps one per product per tab session).
  const supplementsRef = useRef<HTMLElement>(null);
  const usProducts = [...new Set(layout.sections.flatMap((section) => section.cards.flatMap((card) => card.suggestions.flatMap((s) => s.usProduct?.product ?? []))))].join(' ');
  useEffect(() => {
    const el = supplementsRef.current;
    if (!el || !usProducts) return;
    let counted = false; // without IntersectionObserver the callback runs before observeVisibility returns
    return observeVisibility(el, (visible) => {
      if (!visible || counted) return;
      counted = true;
      for (const product of usProducts.split(' ') as UsProduct[]) trackProductEvent('us_product_shown', { product });
    });
  }, [usProducts]);

  // US-09 AC19: the guest has their PDF (or, on the gate-skipped page, signed up
  // for reminders, which marks the record captured). Never before, so the storage
  // button's pulse never competes with the email box. A known minor has no email
  // box: their Save as PDF counts, as on the gate-skipped page (US-07 AC6).
  const { state: emailState, gateSkipped } = guestEmailHook;
  // Pages has no email gate or funnel, even for a record captured on Shopify.
  const attention = SHOPIFY_SURFACE && (emailState === 'captured' || emailState === 'reminded' || ((!!gateSkipped || !!results?.knownMinor) && pdfOpened));

  const planned = isValid && !!results;
  // US-07 AC6: a known minor is never asked for an email (either box joins the
  // mailing list). Their PDF is the gate-skipped page's Save as PDF (US-44 AC2).
  const adult = planned && !results.knownMinor;
  const emailCapture = !!showEmailCapture && adult;
  const printLabel = printStatus === 'loading' ? 'Loading...' : 'Save as PDF';
  // Save as PDF: always on Pages. On Shopify the email capture is the PDF path,
  // so the ungated button shows once captured, on US-44's gate-skipped page, or
  // for a known minor.
  const ungatedPdf = planned && (!SHOPIFY_SURFACE || guestEmailHook.state === 'captured' || !!guestEmailHook.gateSkipped || !adult);

  const foot = (
    <div className="mh-foot">
      {emailCapture && <GuestEmailCapture hook={guestEmailHook} formStage={formStage} pdfBlocked={pdfBlocked === 'capture'} />}
      {ungatedPdf && (
        <div className="report-actions no-print">
          <button type="button" className="action-btn" onClick={() => handlePrint('bottom')} disabled={printStatus === 'loading'} title="Save your plan as a PDF">
            {printLabel}
          </button>
          <PdfNote show={pdfBlocked === 'bottom' || pdfBlocked === 'capture'} />
        </div>
      )}

      {planned && (
        <div className="health-disclaimer">
          <strong>Disclaimer:</strong> {DISCLAIMER}
        </div>
      )}

      {planned && SHOPIFY_SURFACE && <FeedbackForm />}

      {/* US-38 AC1: the open-source link, at the foot of the plan, before a plan exists too. */}
      <GuideLink />

      {planned && (
        <div className="privacy-notice-link">
          <a href="https://drstanfield.com/pages/connector-privacy" target="_blank" rel="noopener">
            How your health data is handled
          </a>
        </div>
      )}
    </div>
  );

  const report = planned && printing && <PlanReport tiles={tiles} sections={sections} alcoholQuestion={alcoholQuestion}/>;
  return { layout, highlights, alcoholQuestion, urgent, supplementsRef, foot, attention, onErased: () => setPdfOpened(false), report };
}
