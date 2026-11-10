// The plan's view on My health (US-62 AC17-AC26): usePlanView sorts its cards by
// topic, holds the print state, the new-card highlight, the PDF's hidden copy and the
// foot. The cards are PlanCards.tsx; the PDF box and the email capture are PlanPdf.tsx.
// The plan has no column of its own since phase 5; InputPanel draws what this builds.
import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { flushSync } from 'react-dom';
import type { HealthResults, Suggestion } from '@roadmap/health-core/types';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { planSections, topicSections, type TopicCard, type TopicLayout } from '@roadmap/health-core/plan-sections';
import type { FormSection } from '@roadmap/health-core/input-form';
// US-61 AC5: called only under SHOPIFY_SURFACE, so the Pages build drops the module.
import { usProductSections, type UsPlanSection, type UsProduct, type UsSuggestion } from '@roadmap/health-core/us-products';
import { getReportHtml } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { GuideLink } from './GuideLink';
import { FeedbackForm } from './FeedbackForm';
import type { AlcoholQuestion } from './AlcoholQuestion';
import { getMarketCountry } from '../lib/market-country';
import { observeVisibility } from '../lib/observe-visibility';
import { ColumnHeader } from './ColumnHeader';
import { GroupedSuggestionCard, NO_HIGHLIGHTS, QuickStats, SuggestionCard, type Highlights, type OpenEvidence } from './PlanCards';
import { PlanPdf, openPrintWindow, useEmailCaptureState, type PdfButton } from './PlanPdf';

// Stays until HealthTool imports OpenEvidenceContext from PlanCards.
export { OpenEvidenceContext } from './PlanCards';

/** The plan's view on My health (US-62 AC17-AC26): its cards by topic (health-core's
 *  `topicSections`, with US-61's overlay on Shopify), the new-card highlight, the urgent
 *  banner's target, and the foot. Built once, in HealthTool; InputPanel draws it. */
/** One topic's cards, the urgent ones apart: they lead the topic, over its rows (US-62 AC18). */
export interface TopicCards { urgent: TopicCard<UsSuggestion>[]; others: TopicCard<UsSuggestion>[]; ownershipLine?: string }

export interface PlanView {
  layout: TopicLayout<UsSuggestion>;
  /** Each topic's cards, split once (US-62 AC18). */
  topics: ReadonlyMap<string, TopicCards>;
  /** A valid plan is on hand. */
  planned: boolean;
  highlights: Highlights;
  alcoholQuestion?: AlcoholQuestion;
  /** The first urgent card in topic order, for the banner (US-62 AC19). */
  urgent: { title: string; cardId: string } | null;
  /** Each card's DOM id: its place on the page, never what it found (US-09 AC7d). */
  cardIds: ReadonlyMap<TopicCard<UsSuggestion>, string>;
  /** The reasons open on screen; the PDF prints them open (US-62 AC28). Provide it as OpenEvidenceContext. */
  evidence: OpenEvidence;
  /** US-61 AC8: on the Supplements section, so its products count once it is on screen. */
  supplementsRef: React.RefObject<HTMLElement>;
  /** The PDF box: the email box or Save as PDF, above the pills (Brad 2026-11-09, US-62 AC26). */
  pdf: React.ReactNode;
  /** The foot: the disclaimer, feedback, Supercharge, privacy. */
  foot: React.ReactNode;
  /** US-09 AC19: the guest has their PDF, so the storage card may pulse. */
  attention: boolean;
  /** An erase forgets the PDF this tab opened. */
  onErased: () => void;
  /** The plan as Save as PDF prints it (US-08): drawn, hidden, only while getReportHtml copies it. */
  report: React.ReactNode;
}

/** New or changed suggestions glow for 3s, then fade, once the plan has settled (3s after mount). */
function useHighlights(suggestions: Suggestion[] | undefined): Highlights {
  const [highlighted, setHighlighted] = useState<Set<string>>(NO_HIGHLIGHTS);
  const [fadingOut, setFadingOut] = useState<Set<string>>(NO_HIGHLIGHTS);
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
    // Nothing new or changed: a change undone mid-glow ends the glow (the same empty set skips a re-render).
    if (next.size === 0) {
      setHighlighted(NO_HIGHLIGHTS);
      setFadingOut(NO_HIGHLIGHTS);
      baselineRef.current = currentMap;
      return;
    }
    // Cancel any fade-out in progress.
    if (fadeOutTimeoutRef.current) clearTimeout(fadeOutTimeoutRef.current);
    setFadingOut(NO_HIGHLIGHTS);
    setHighlighted(next);
    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    clearTimeoutRef.current = setTimeout(() => {
      setFadingOut(next);
      setHighlighted(NO_HIGHLIGHTS);
      fadeOutTimeoutRef.current = setTimeout(() => {
        setFadingOut(NO_HIGHLIGHTS);
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

/**
 * The plan as its PDF has always printed it (US-08, US-18, US-62 AC28): its
 * title, the tiles, the suggestions by priority (planSections) with the reasons
 * opened on screen, the disclaimer and the privacy link. Hidden, and drawn only
 * while getReportHtml copies it: My health shows the same cards by topic.
 */
function PlanReport({ tiles, sections, alcoholQuestion }: { tiles: StatTile[]; sections: UsPlanSection[]; alcoholQuestion?: AlcoholQuestion }) {
  return (
    <div className="health-results-panel hr-report" hidden>
      <ColumnHeader title="Your plan to discuss with your doctor"/>
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
      <PrivacyLink/>
    </div>
  );
}

function PrivacyLink() {
  return (
    <div className="privacy-notice-link">
      <a href="https://drstanfield.com/pages/connector-privacy" target="_blank" rel="noopener">
        How your health data is handled
      </a>
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

  const capture = useEmailCaptureState();
  const [opened, setOpened] = useState<ReadonlySet<string>>(NO_HIGHLIGHTS);
  const toggleEvidence = useCallback((key: string) => setOpened(was => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const evidence = useMemo(() => ({ opened, toggle: toggleEvidence }), [opened, toggleEvidence]);

  // US-61 AC5: Brad's products for a known adult in the US, on the Shopify build only.
  const sections = useMemo((): UsPlanSection[] => {
    if (!results) return [];
    const plain = planSections(results.suggestions);
    return (SHOPIFY_SURFACE && usProductSections(plain, results, getMarketCountry() === 'US', 'web')) || plain;
  }, [results]);
  const layout = useMemo(() => topicSections(sections, forms), [sections, forms]);
  const topics = useMemo(() => new Map(layout.sections.map(({ topic, cards, ownershipLine }) => [topic, {
    urgent: cards.filter(c => c.priority === 'urgent'), others: cards.filter(c => c.priority !== 'urgent'), ownershipLine,
  }])), [layout]);
  // A card's DOM id is its place on the page: Sentry's click paths keep ids (US-09 AC7d).
  const cardIds = useMemo(() => new Map(layout.sections.flatMap(s => s.cards).map((card, i) => [card, `mh-card-${i}`])), [layout]);
  // The banner names the first urgent card in topic order (US-62 AC19).
  const urgent = useMemo(() => {
    for (const section of layout.sections) {
      const card = section.cards.find(c => c.priority === 'urgent');
      if (card) return { title: (card.suggestions.find(s => s.priority === 'urgent') ?? card.suggestions[0]).title, cardId: cardIds.get(card)! };
    }
    return null;
  }, [layout, cardIds]);

  // US-61 AC8: once the Supplements section is on screen, one count per product
  // (trackProductEvent keeps one per product per tab session).
  const supplementsRef = useRef<HTMLElement>(null);
  const usProducts = useMemo(() => [...new Set(layout.sections.flatMap((section) => section.cards.flatMap((card) => card.suggestions.flatMap((s) => s.usProduct?.product ?? []))))].join(' '), [layout]);
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
  const { state: emailState, gateSkipped } = capture;
  // Pages has no email gate or funnel, even for a record captured on Shopify.
  const attention = SHOPIFY_SURFACE && (emailState === 'captured' || emailState === 'reminded' || ((!!gateSkipped || !!results?.knownMinor) && pdfOpened));

  const planned = isValid && !!results;
  // US-07 AC6: a known minor is never asked for an email (either box joins the
  // mailing list). Their PDF is the gate-skipped page's Save as PDF (US-44 AC2).
  const adult = planned && !results.knownMinor;
  const report = planned && printing && <PlanReport tiles={tiles} sections={sections} alcoholQuestion={alcoholQuestion}/>;
  const pdf = (
    <PlanPdf planned={planned} adult={adult} emailCapture={!!showEmailCapture && adult} formStage={formStage} capture={capture}
             printStatus={printStatus} pdfBlocked={pdfBlocked} onPrint={handlePrint} onCapturePrint={() => printReport('capture')}/>
  );
  const foot = <PlanFoot planned={planned}/>;

  return { layout, topics, planned, highlights, alcoholQuestion, urgent, cardIds, evidence, supplementsRef, pdf, foot, attention, onErased: () => { setPdfOpened(false); setOpened(NO_HIGHLIGHTS); }, report };
}


/** My health's foot (US-62 AC26): the disclaimer, feedback, Supercharge and the privacy link. */
function PlanFoot({ planned }: { planned: boolean }) {
  return (
    <div className="mh-foot">
      {planned && (
        <div className="health-disclaimer">
          <strong>Disclaimer:</strong> {DISCLAIMER}
        </div>
      )}

      {planned && SHOPIFY_SURFACE && <FeedbackForm />}

      {/* US-38 AC1: the open-source link, at the foot of the plan, before a plan exists too. */}
      <GuideLink />

      {planned && <PrivacyLink/>}
    </div>
  );
}