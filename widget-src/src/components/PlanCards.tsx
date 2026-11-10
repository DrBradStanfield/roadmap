// The plan's cards (US-62 AC18, AC20, AC26, AC28): a suggestion's card and its evidence
// (US-07 AC16), the new-card glow (US-07 AC3), a row's suggestions, the tiles (US-25 AC22)
// and US-61 AC4's product block. ResultsPanel's usePlanView builds the plan they draw.
import React, { createContext, useContext, useState, useId } from 'react';
import type { Suggestion } from '@roadmap/health-core/types';
import type { SuggestionEvidence } from '@roadmap/health-core/evidence';
import { statTileText, type StatTile } from '@roadmap/health-core/stat-tiles';
import type { PlanCard, TopicCard } from '@roadmap/health-core/plan-sections';
import type { UsProductBlock, UsSuggestion } from '@roadmap/health-core/us-products';
import { trackProductEvent } from '../lib/server-api';
import { alcoholDismiss, type AlcoholQuestion } from './AlcoholQuestion';
import { CategoryIcon } from './icons';
import type { PlanView } from './ResultsPanel';

/** Which reasons are open, by suggestion or tile, shared by the screen and its PDF (US-62 AC28). */
export interface OpenEvidence { opened: ReadonlySet<string>; toggle: (key: string) => void }
export const OpenEvidenceContext = createContext<OpenEvidence | null>(null);
/** One reason's open state: the plan's shared one, or, outside a plan, its own. */
function useOpenEvidence(key: string): [boolean, () => void] {
  const shared = useContext(OpenEvidenceContext);
  const [own, setOwn] = useState(false);
  return shared ? [shared.opened.has(key), () => shared.toggle(key)] : [own, () => setOwn(o => !o)];
}

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

function StatCard({ openKey, label, value, status, evidence }: {
  openKey: string;
  label: string;
  value: React.ReactNode;
  status?: { label: string; className: string };
  evidence?: SuggestionEvidence;
}) {
  const [open, toggle] = useOpenEvidence(openKey);
  const hasDetail = !!evidence;
  return (
    <div className={`stat-card${hasDetail ? ' stat-card-clickable' : ''}${open ? ' stat-card-open' : ''}`}
         {...evidenceToggle(open, hasDetail ? toggle : undefined)}>
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

/** My health's card head (US-62 AC18, design review 2026-11-06): no category icon or chip; the
 *  status alone, in words and one restrained colour, only where there is one. */
const STATUS_WORDS: Partial<Record<Suggestion['priority'], string>> = { urgent: 'Urgent', attention: 'Next step' };
function CalmStatus({ priority }: { priority: Suggestion['priority'] }) {
  const words = STATUS_WORDS[priority];
  return words ? <span className={`mh-status mh-status--${priority}`}>{words}</span> : null;
}

export function SuggestionCard({ suggestion, highlighted, fadingOut, alcoholQuestion, usBlock, calm }: { suggestion: Suggestion; highlighted?: boolean; fadingOut?: boolean; alcoholQuestion?: AlcoholQuestion; usBlock?: UsProductBlock; calm?: boolean }) {
  const [evidenceOpen, toggleOpen] = useOpenEvidence(suggestion.id);
  const dismiss = alcoholDismiss(suggestion, alcoholQuestion);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const isSupplementCard = suggestion.category === 'supplements';
  const isSkinCard = suggestion.category === 'skin';
  const isSpecialCard = isSupplementCard || isSkinCard;
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const toggleEvidence = hasEvidence ? toggleOpen : undefined;

  return (
    <div className={`suggestion-card ${priorityColors[suggestion.priority]}${isSupplementCard ? ' supplement-card' : ''}${isSkinCard ? ' skin-card' : ''}${highlightClass}${hasEvidence ? ' suggestion-card-clickable' : ''}${calm ? ' suggestion-card--calm' : ''}`}>
      {calm ? (
        (STATUS_WORDS[suggestion.priority] || dismiss) && (
          <div className="suggestion-header">
            <CalmStatus priority={suggestion.priority}/>
            {dismiss}
          </div>
        )
      ) : !isSpecialCard && (
        <div className="suggestion-header">
          <span className="suggestion-header-lead">
            <CategoryIcon category={suggestion.category}/>
            <span className={`suggestion-badge ${priorityColors[suggestion.priority]}`}>
              {suggestion.priority === 'urgent' && '⚠️ '}
              {suggestion.category.replace(/_/g, ' ')}
            </span>
          </span>
          {dismiss}
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
  const [evidenceOpen, toggleOpen] = useOpenEvidence(suggestion.id);
  const hasEvidence = suggestionHasEvidence(suggestion);
  const highlightClass = fadingOut ? ' suggestion-highlight suggestion-fade-out'
    : highlighted ? ' suggestion-highlight' : '';

  const dismiss = alcoholDismiss(suggestion, alcoholQuestion);
  const toggleEvidence = hasEvidence ? toggleOpen : undefined;

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

export function GroupedSuggestionCard({ card, highlightedIds, fadingOutIds, alcoholQuestion, calm }: { card: Pick<PlanCard, 'category' | 'priority' | 'suggestions'>; highlightedIds?: Set<string>; fadingOutIds?: Set<string>; alcoholQuestion?: AlcoholQuestion; calm?: boolean }) {
  const { suggestions, category, priority: highestPriority } = card;

  return (
    <div className={`suggestion-card grouped-card ${priorityColors[highestPriority]}${calm ? ' suggestion-card--calm' : ''}`}>
      {calm ? STATUS_WORDS[highestPriority] && <div className="suggestion-header"><CalmStatus priority={highestPriority}/></div> : (
      <div className="suggestion-header">
        <span className="suggestion-header-lead">
          <CategoryIcon category={category}/>
          <span className={`suggestion-badge ${priorityColors[highestPriority]}`}>
            {highestPriority === 'urgent' && '⚠️ '}
            {category.replace(/_/g, ' ')}
          </span>
        </span>
      </div>
      )}
      <div className="grouped-subsections">
        {suggestions.map((s) => (
          <GroupedSubsection key={s.id} suggestion={s} highlighted={highlightedIds?.has(s.id)} fadingOut={fadingOutIds?.has(s.id)} alcoholQuestion={alcoholQuestion} />
        ))}
      </div>
    </div>
  );
}

export interface Highlights { highlighted: Set<string>; fadingOut: Set<string> }
/** A suggestion's glow classes (US-07 AC3). */
const highlightClass = (id: string, { highlighted, fadingOut }: Highlights) =>
  fadingOut.has(id) ? ' suggestion-highlight suggestion-fade-out' : highlighted.has(id) ? ' suggestion-highlight' : '';
export const NO_HIGHLIGHTS: Set<string> = new Set();

/** One topic's cards, each with its DOM id; a grouped card as one card (US-62 AC18). */
export function PlanCardList({ cards, plan }: { cards: ReadonlyArray<TopicCard<UsSuggestion>>; plan: PlanView }) {
  const { highlighted, fadingOut } = plan.highlights;
  return (
    <>
      {cards.map((card) => {
        const id = plan.cardIds.get(card)!;
        const s = card.suggestions[0];
        return (
          <div key={id} id={id} tabIndex={-1} className="mh-card">
            {card.suggestions.length > 1
              ? <GroupedSuggestionCard card={card} highlightedIds={highlighted} fadingOutIds={fadingOut} alcoholQuestion={plan.alcoholQuestion} calm />
              : <SuggestionCard suggestion={s} highlighted={highlighted.has(s.id)} fadingOut={fadingOut.has(s.id)} alcoholQuestion={plan.alcoholQuestion} usBlock={s.usProduct} calm />}
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
export function RowSuggestions({ suggestions, highlights, describes = false }: { suggestions: readonly Suggestion[]; highlights: Highlights; describes?: boolean }) {
  return <>{suggestions.map(s => <RowSuggestion key={s.id} suggestion={s} describes={describes} glow={highlightClass(s.id, highlights)}/>)}</>;
}

function RowSuggestion({ suggestion, describes, glow }: { suggestion: Suggestion; describes: boolean; glow: string }) {
  const [open, setOpen] = useState(false);
  const [evidenceOpen, toggleEvidence] = useOpenEvidence(suggestion.id);
  const detailId = useId();
  return (
    <div className={`mh-row-suggestion ${priorityColors[suggestion.priority]}${glow}`}>
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
          <SuggestionEvidence suggestion={suggestion} open={evidenceOpen} onToggle={toggleEvidence} />
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
      openKey={`tile:${tile.key}`}
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
