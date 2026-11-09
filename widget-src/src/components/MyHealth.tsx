// My health (US-62 phase 5): the iPhone's one tab of numbers and plan, by topic
// (US-73). The onboarding's form first; then the PDF box, the pills, the banner, the topics in
// health-core's order (TOPICS) with their rows, questions and the plan's cards,
// the desktop section list, the documents and the foot; the settings behind the
// person button. The form's parts come from InputPanel (`FormSlots`); the plan's
// from usePlanView.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { byNewestDocument, DOCUMENT_TYPE_LABELS, isLabArchiveDocument, TOPICS, type ApiMeasurement, type StatTile, type TopicId } from '@roadmap/health-core';
import { DocumentLightbox } from './DocumentLightbox';
import { formatDocumentDate } from '../lib/document-format';
import type { ApiDocument, ApiLabValue } from '../lib/api-types';
import { revealAndFocus, stickyTop } from '../lib/reveal';
import { trackProductEvent } from '../lib/server-api';
import { observeVisibility } from '../lib/observe-visibility';
import { BLOOD_ROWS, MetricRows, TopicHeading, coreRow, egfrRow, isLabEgfr, labRows, nonHdlRow, pressureRow, weightRow, whtrRow, type RowContext, type RowModel, type ValueSubject } from './MyDataRows';
import { PlanCardList, PlanEmptyPreview, QuickStats, RowSuggestions, type PlanView } from './ResultsPanel';
import { SettingsSheet } from './SettingsSheet';
import { SectionNav } from './SectionNav';
import type { DerivedSeries } from '../storage/roadmap-store';

/** Where the plan's suggestions sit on the form's questions (US-62 AC20). */
export interface Placement {
  /** A medicine question's suggestions; one control may answer two keys (a drug and its dose). */
  on(...keys: string[]): ReactNode;
  /** A screening test's suggestions, their text as the line. */
  in(group: string): ReactNode;
  /** A group's note, unless a suggestion in the group already says it (prostate's). */
  noteShown(group: string, note: string): boolean;
}

/** What the form (InputPanel) hands My health: its parts, its rows' data and its value page. */
export interface FormSlots {
  panelRef: RefObject<HTMLDivElement>;
  messages: ReactNode;
  aboutCard: ReactNode;
  aboutYouLow: boolean;
  unitPill: ReactNode;
  fullForm: boolean;
  planReady: boolean;
  pageOpen: boolean;
  renderPage: (tiles: StatTile[]) => ReactNode;
  rows: { ctx: RowContext; open: (s: ValueSubject, from?: Element) => void; vitals: ApiMeasurement[]; blood: ApiMeasurement[]; labs: ApiLabValue[]; vitalsAsRows: boolean; withoutWeight: boolean };
  legacyVitals: ReactNode;
  vitalsCue: ReactNode;
  bloodCue: ReactNode;
  tableShown: boolean;
  showTable: (open: boolean) => void;
  table: ReactNode;
  addTest: ReactNode;
  weightMedications: (place: Placement) => ReactNode;
  lipidMedications: (place: Placement) => ReactNode;
  screening: (place: Placement) => ReactNode;
  boneDensity: (place: Placement) => ReactNode;
  supplements: () => ReactNode;
}

export interface MyHealthProps {
  form: FormSlots;
  plan: PlanView;
  /** The plan's tiles: under the onboarding, and on their rows' pages (US-62 AC25, AC26). */
  tiles: StatTile[];
  /** The worked-out rows' series: waist-to-height and eGFR (US-62 AC21). */
  series: DerivedSeries;
  /** The day and source of the plan's eGFR, for its row; null without one. */
  egfrCurrent: { day: string; source: 'lab' | 'calculated' } | null;
  /** US-09 AC30: the storage button, on the title line (US-62 AC24). */
  storageBar?: ReactNode;
  personButton?: ReactNode;
  settingsOpen: boolean;
  onSettingsClose: () => void;
  /** Settings' parts after About you and units: the reminders (none for a known minor), where the
   *  record lives (US-09) and Delete all my data. */
  reminders?: ReactNode;
  storageCard?: ReactNode;
  onDelete: () => void;
  isDeleting?: boolean;
  /** A guest's storage card shows at the foot while Settings are shut; a connected one waits
   *  there hidden, so the picker it hosts still opens from the title line (US-09 AC30). */
  storageAtFoot?: boolean;
  /** The topics' container: `results_viewed` watches it (US-62 AC5). */
  sectionsRef?: RefObject<HTMLDivElement>;
  healthDocuments?: ApiDocument[];
  onDocumentDeleted?: (docId: string) => void;
  setShowUploadModal?: (show: boolean) => void;
  /** US-62 AC31: set while "Your plan is ready." shows; its Got it calls it. */
  onPlanReadyDismiss?: () => void;
}

/** A topic's parts beyond its cards: rows, what follows (its medicines), its heading's action. */
interface TopicParts { rows?: ReactNode; after?: ReactNode; action?: ReactNode; always?: boolean; sectionRef?: RefObject<HTMLElement> }

/** The phone's jump pills (US-62 AC17): ids only, their words TOPICS'. */
const PILLS: readonly TopicId[] = ['bloodTests', 'cholesterol', 'supplements'];
const titleOf = (id: TopicId) => TOPICS.find(t => t.topic === id)!.title;

const RowsCard = memo(function RowsCard({ rows, onOpen, extra }: { rows: Array<RowModel | null>; onOpen: (s: ValueSubject, from?: Element) => void; extra?: ReactNode }) {
  return (
    <div className="section-card mh-rows-card">
      <MetricRows rows={rows.filter((r): r is RowModel => r !== null)} onOpen={onOpen}/>
      {extra}
    </div>
  );
});

export function MyHealth({ form, plan, tiles, series, egfrCurrent, storageBar, personButton, settingsOpen, onSettingsClose, reminders, storageCard, onDelete, isDeleting, storageAtFoot,
  sectionsRef, healthDocuments, onDocumentDeleted, setShowUploadModal, onPlanReadyDismiss }: MyHealthProps) {
  // The form's row opener changes every render; the rows take a stable one, so memo'd rows stay put.
  const openRef = useRef(form.rows.open);
  openRef.current = form.rows.open;
  const onOpen = useCallback((s: ValueSubject, from?: Element) => openRef.current(s, from), []);

  const { ctx, vitals, blood, labs: labValues, vitalsAsRows, withoutWeight } = form.rows;
  // Rows (US-62 AC21), worked out only when their data changes (one long page, 40+ labs).
  const rows = useMemo(() => {
    const tileOf = (key: string) => tiles.find(t => t.key === key);
    const row = (metric: Parameters<typeof coreRow>[0]) => coreRow(metric, blood, ctx);
    const labs = labRows(labValues);
    const egfr = egfrRow(series.egfr, tileOf('egfr'), egfrCurrent, labs.some(r => isLabEgfr(r.subject)));
    const creatinine = row('creatinine');
    const total = row('total_cholesterol');
    return {
      weight: [vitalsAsRows ? whtrRow(series.whtr, tileOf('whtr')) ?? coreRow('waist', vitals, ctx) : null,
        vitalsAsRows && !withoutWeight ? weightRow(vitals, ctx, tileOf('bmi')) : null, row('hba1c')],
      pressure: [vitalsAsRows ? pressureRow(vitals, ctx) : null, creatinine, egfr],
      lipids: (['apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa'] as const)
        .flatMap(m => (m === 'total_cholesterol' ? [total] : m === 'hdl' ? [row('hdl'), nonHdlRow(tileOf('nonHdl'), total)] : [row(m)])),
      // The lab's own eGFR row leaves Blood tests while the eGFR row stands for it (US-73 AC7).
      blood: [...BLOOD_ROWS.flatMap(m => (m === 'creatinine' ? [creatinine, egfr] : [row(m)])),
        ...(egfr ? labs.filter(r => !isLabEgfr(r.subject)) : labs)],
    };
  }, [tiles, blood, vitals, labValues, ctx, series, egfrCurrent, vitalsAsRows, withoutWeight]);

  const placedMedicines = useMemo(() => new Map(plan.layout.medicines.map(m => [m.key, m.suggestions])), [plan.layout]);
  const placedScreenings = useMemo(() => new Map(plan.layout.screenings.map(g => [g.group, g.suggestions])), [plan.layout]);
  const place: Placement = {
    on: (...keys) => {
      const suggestions = keys.flatMap(key => placedMedicines.get(key) ?? []);
      return suggestions.length > 0 && <RowSuggestions suggestions={suggestions} highlights={plan.highlights}/>;
    },
    in: group => {
      const suggestions = placedScreenings.get(group) ?? [];
      return suggestions.length > 0 && <RowSuggestions suggestions={suggestions} highlights={plan.highlights} describes/>;
    },
    noteShown: (group, note) => !(placedScreenings.get(group) ?? []).some(s => s.description.includes(note)),
  };

  const jump = (id: string) => revealAndFocus(document.getElementById(`mh-topic-${id}`), 'start');
  const toUrgent = () => revealAndFocus(plan.urgent && document.getElementById(plan.urgent.cardId), 'center');

  // Each topic's parts; every topic in TOPICS' order is drawn by `topicSection`.
  const parts: Partial<Record<TopicId, TopicParts>> = !form.fullForm ? {} : (() => {
    const screening = form.screening(place);
    const bone = form.boneDensity(place);
    return {
      weight: { rows: <>{form.legacyVitals}<RowsCard rows={rows.weight} onOpen={onOpen} extra={form.vitalsCue}/></>, after: form.weightMedications(place) },
      bloodPressure: { rows: <RowsCard rows={rows.pressure} onOpen={onOpen}/> },
      cholesterol: { rows: <RowsCard rows={rows.lipids} onOpen={onOpen}/>, after: form.lipidMedications(place) },
      screening: { rows: (screening || bone) ? <>{screening}{bone}</> : undefined },
      bloodTests: {
        always: true,
        action: setShowUploadModal && (
          <button type="button" className="mh-head-icon-btn" aria-label="Upload lab results" title="Upload lab results" onClick={() => setShowUploadModal(true)}>
            <span aria-hidden="true">+</span>
          </button>
        ),
        rows: (
          <div className="section-card section-card--bt mh-rows-card">
            {!form.tableShown && (
              <div className="md-section">
                <MetricRows rows={rows.blood.filter((r): r is RowModel => r !== null)} onOpen={onOpen}/>
                {form.bloodCue}
                {form.addTest && <div className="mh-add-test">{form.addTest}</div>}
                <div className="md-foot">
                  <button type="button" className="md-foot-btn" onClick={() => form.showTable(true)}>All results as a table</button>
                </div>
              </div>
            )}
            {form.table}
          </div>
        ),
      },
      supplements: { always: true, after: form.supplements(), sectionRef: plan.supplementsRef },
    };
  })();

  /** A topic: its heading, its urgent cards over its rows, its rows, its other cards, then what follows. Null when empty. */
  const topicSection = (id: TopicId) => {
    const p = parts[id] ?? {};
    const cards = plan.topics.get(id);
    if (!p.always && !p.rows && !p.after && !cards) return null;
    return (
      <section key={id} className="mh-topic" data-topic={id} aria-labelledby={`mh-topic-${id}`} ref={p.sectionRef}>
        <TopicHeading title={titleOf(id)} icon={id} id={`mh-topic-${id}`} action={p.action}/>
        {cards && cards.urgent.length > 0 && <PlanCardList cards={cards.urgent} plan={plan}/>}
        {p.rows}
        {cards && cards.others.length > 0 && <PlanCardList cards={cards.others} plan={plan}/>}
        {cards?.ownershipLine && <p className="us-ownership no-print">{cards.ownershipLine}</p>}
        {p.after}
      </section>
    );
  };
  const shown = form.fullForm ? TOPICS.flatMap(({ topic }) => { const node = topicSection(topic); return node ? [{ id: topic, node }] : []; }) : [];
  // Scan results and letters; blood-test reports are left out, their values are the rows (US-62 AC33).
  const documents = (healthDocuments ?? []).filter(d => !isLabArchiveDocument(d));
  const navTopics = [...shown.map(({ id }) => ({ id: id as string, title: titleOf(id), urgent: (plan.topics.get(id)?.urgent.length ?? 0) > 0 })),
    ...(documents.length > 0 ? [{ id: 'documents', title: 'Documents', urgent: false }] : [])];

  return (
    <div ref={form.panelRef} className={`health-input-panel mh-page${form.pageOpen || settingsOpen ? ' md-page-open' : ''}`}>
      <div className="mh-header">
        <h2 className="mh-title" tabIndex={-1}>My health</h2>
        {(personButton || storageBar) && <div className="mh-header-actions">{storageBar}{personButton}</div>}
      </div>
      {settingsOpen && (
        <SettingsSheet onClose={onSettingsClose}>
          {form.aboutYouLow ? form.aboutCard : (
            <div className="section-card">
              <div className="basic-info-units">
                <span className="basic-info-units-label">Units</span>
                {form.unitPill}
              </div>
            </div>
          )}
          {reminders}
          {/* Where the record lives (US-09). Hidden for new users until they have entered real data. */}
          {storageCard}
          {plan.planned && (
            <div className="delete-data-section">
              <button className="delete-data-link" onClick={onDelete} disabled={isDeleting}>
                {isDeleting ? 'Deleting...' : 'Delete all my data'}
              </button>
            </div>
          )}
        </SettingsSheet>
      )}
      {/* Settings cover an open value page; it stays mounted, so its typing waits (US-62 AC10). */}
      <div className="mh-page-host" hidden={settingsOpen}>{form.renderPage(tiles)}</div>
      {form.messages}
      {/* Where Starting info was, once the onboarding ends here (US-62 AC31). */}
      {onPlanReadyDismiss && <PlanReadyCard onDismiss={onPlanReadyDismiss} settled={form.aboutYouLow}/>}
      {/* The onboarding, as before, until About you goes low (US-62 AC25); then About you sits in Settings. */}
      {!form.aboutYouLow && form.aboutCard}
      {/* Under the onboarding, the plan's tiles as they come (US-62 AC13, AC25); with no plan yet, what it will look like. */}
      {!form.planReady ? <PlanEmptyPreview/> : !form.aboutYouLow && <QuickStats tiles={tiles}/>}
      {form.fullForm && (
        // Desktop: the section list beside the topics (US-62 AC27); a phone: the three pills under the title.
        <div className="mh-sections" ref={sectionsRef}>
          <SectionNav topics={navTopics} onJump={jump}/>
          <div className="mh-topics">
            {/* The PDF box above the pills (Brad 2026-11-09); on desktop, atop the topics. */}
            {plan.pdf}
            <div className="mh-pills no-print">
              {PILLS.map(id => <button key={id} type="button" className="mh-pill" onClick={() => jump(id)}>{titleOf(id)}</button>)}
            </div>
            {plan.urgent && (
              <button type="button" className="mh-banner" onClick={toUrgent}>
                <svg className="mh-banner-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
                  <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M10 5.5v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <circle cx="10" cy="14.2" r="1.1" fill="currentColor"/>
                </svg>
                Needs attention: {plan.urgent.title}
              </button>
            )}
            {shown.map(({ node }) => node)}
            {/* In the topics' column, so the desktop list beside it reaches it (US-62 AC33). */}
            {documents.length > 0 && <HealthRecordsSection documents={documents} onDeleted={onDocumentDeleted} />}
          </div>
        </div>
      )}
      {!form.fullForm && documents.length > 0 && <HealthRecordsSection documents={documents} onDeleted={onDocumentDeleted} />}
      {!settingsOpen && storageCard && <div className="mh-foot-storage" hidden={!storageAtFoot}>{storageCard}</div>}
      {!form.fullForm && plan.pdf}
      {plan.foot}
      {plan.report}
    </div>
  );
}

/** "Your plan is ready." (US-62 AC31, Brad's words): shown once the onboarding ends in this tab,
 *  until Got it. Once Starting info has gone (`settled`), it scrolls only if it is out of view. */
function PlanReadyCard({ onDismiss, settled }: { onDismiss: () => void; settled: boolean }) {
  const ref = useRef<HTMLElement>(null);
  // Counted once it is on screen: never in a hidden tab (a phone on Chat), never scrolled off.
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    let stop = () => {};
    stop = observeVisibility(card, visible => { if (visible) { trackProductEvent('plan_ready_shown'); stop(); } });
    return () => stop();
  }, []);
  useEffect(() => {
    const card = ref.current;
    if (!settled || !card) return;
    card.style.scrollMarginTop = `${stickyTop() + 12}px`;
    card.scrollIntoView?.({ behavior: 'instant', block: 'nearest' });
  }, [settled]);
  return (
    <section ref={ref} className="section-card mh-ready" aria-labelledby="mh-ready-title">
      <h3 id="mh-ready-title" className="mh-ready-title" tabIndex={-1}>Your plan is ready.</h3>
      <p className="mh-ready-text">
        Each section below shows where you stand and one next step to discuss with your doctor. Add more numbers,
        like blood pressure or blood tests, and the suggestions get more specific.
      </p>
      <button type="button" className="mh-ready-btn" onClick={onDismiss}>Got it</button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Health Records (scan results, clinic letters, etc.) — raw data display
// ---------------------------------------------------------------------------

function HealthRecordsSection({ documents, onDeleted }: { documents: ApiDocument[]; onDeleted?: (docId: string) => void }) {
  const [selectedDoc, setSelectedDoc] = useState<ApiDocument | null>(null);

  // Handed only what it lists: blood-test reports are left out by My health (their values are the rows).
  const scanResults = documents.filter(d => d.documentType === 'scan_result');
  const otherDocs = documents.filter(d => d.documentType !== 'scan_result');
  // The first heading is the area's anchor, which the desktop section list jumps to (US-62 AC33).
  const anchor = { id: 'mh-topic-documents', tabIndex: -1 };

  return (
    <>
      {scanResults.length > 0 && (
        <section className="health-records-section">
          <h3 className="results-section-title" {...anchor}>Scan Results</h3>
          <div className="health-records-list">
            {[...scanResults].sort(byNewestDocument).map(doc => (
              <button
                key={doc.id}
                className="health-record-item"
                onClick={() => setSelectedDoc(doc)}
              >
                <span className="health-record-date">{formatDocumentDate(doc.documentDate)}</span>
                <span className="health-record-title">{doc.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {otherDocs.length > 0 && (
        <section className="health-records-section">
          <h3 className="results-section-title" {...(scanResults.length > 0 ? {} : anchor)}>Documents</h3>
          <div className="health-records-list">
            {[...otherDocs].sort(byNewestDocument).map(doc => (
              <button
                key={doc.id}
                className="health-record-item"
                onClick={() => setSelectedDoc(doc)}
              >
                <span className="health-record-date">{formatDocumentDate(doc.documentDate)}</span>
                <span className="health-record-info">
                  <span className={`health-record-type-badge health-record-type--${doc.documentType}`}>
                    {DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType}
                  </span>
                  <span className="health-record-title">{doc.title}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedDoc && (
        <DocumentLightbox
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
