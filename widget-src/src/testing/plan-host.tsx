// Test support: the plan's parts as My health draws them (US-62 phase 5),
// without the rest of the page, for the suites that test the plan alone: the
// real usePlanView, its cards by topic, the tiles, the foot, and Settings' plan
// parts (reminders, the record, Delete all my data) as HealthTool passes them.
// Imported by tests only.
import type { ReactNode } from 'react';
import type { HealthResults } from '@roadmap/health-core/types';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { OpenEvidenceContext, PlanCardList, QuickStats, usePlanView } from '../components/ResultsPanel';
import type { AlcoholQuestion } from '../components/AlcoholQuestion';

const NO_FORMS = { medications: [], screenings: [] };

export function PlanHost({ results, isValid, tiles = [], showEmailCapture, formStage, syncControl, remindersSection, onDeleteData, isDeleting, alcoholQuestion, hasUnsavedLongitudinal, onSaveLongitudinal }: {
  results: HealthResults | null;
  isValid: boolean;
  tiles?: StatTile[];
  showEmailCapture?: boolean;
  formStage?: number;
  syncControl?: (ctx: { hasData: boolean; attention: boolean }) => ReactNode;
  remindersSection?: ReactNode;
  onDeleteData?: () => Promise<boolean>;
  isDeleting?: boolean;
  alcoholQuestion?: AlcoholQuestion;
  hasUnsavedLongitudinal?: boolean;
  onSaveLongitudinal?: () => Promise<unknown>;
}) {
  const plan = usePlanView({ results, isValid, tiles, forms: NO_FORMS, showEmailCapture, formStage, alcoholQuestion, hasUnsavedLongitudinal, onSaveLongitudinal });
  const planned = isValid && !!results;
  return (
    <OpenEvidenceContext.Provider value={plan.evidence}>
      <div className="mh-page">
        {tiles.length > 0 && <QuickStats tiles={tiles}/>}
        {plan.layout.sections.map(section => (
          <section key={section.topic} data-topic={section.topic} ref={section.topic === 'supplements' ? plan.supplementsRef : undefined}>
            <h3>{section.title}</h3>
            <PlanCardList cards={section.cards} plan={plan}/>
            {section.ownershipLine && <p className="us-ownership no-print">{section.ownershipLine}</p>}
          </section>
        ))}
        {plan.pdf}
        {plan.foot}
        <div className="mh-settings">
          {planned && !results.knownMinor && remindersSection}
          {syncControl?.({ hasData: planned, attention: plan.attention })}
          {planned && onDeleteData && (
            <button className="delete-data-link" disabled={isDeleting}
                    onClick={async () => { if (await onDeleteData()) plan.onErased(); }}>Delete all my data</button>
          )}
        </div>
        {plan.report}
      </div>
    </OpenEvidenceContext.Provider>
  );
}
