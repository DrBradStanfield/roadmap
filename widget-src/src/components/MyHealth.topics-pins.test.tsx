// @vitest-environment jsdom
/**
 * US-62 AC40 (lead W1-5): pins of what the web's My health draws, through the rendered page, for the
 * generated worlds planTopics is tested on (plan-topics.fixtures.ts): the topics in order, each
 * topic's rows, its cards (urgent ones over the rows), its ownership line, its questions and the
 * suggestions placed on them. Written on main before My health moved onto planTopics; the move
 * must leave every snapshot as it was. The page snapshots are the whole My health container's
 * structure and text for a spread of records (not full, a note, urgent, placements).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import type { HealthResults } from '@roadmap/health-core/types';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { genWorld, SEEDS, type World } from '@roadmap/health-core/plan-topics.fixtures';
import { MyHealth, type FormSlots, type Placement } from './MyHealth';
import { OpenEvidenceContext } from './PlanCards';
import { usePlanView } from './ResultsPanel';
import type { ApiLabValue } from '../lib/api-types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);

const DAY = '2026-01-15';
const tile = (key: StatTile['key'], label: string, value: string, unit: string): StatTile => ({ key, label, value, unit, about: '' });

/** The form's question parts as the fixture's forms hold them: a part per medicine section and the
 *  screening section (none without one, as InputPanel's renderers), each showing what is placed on it. */
function slots(w: World): FormSlots {
  const medicine = (id: string) => (place: Placement) => {
    const section = w.forms.medications.find(s => s.id === id);
    if (!section) return null;
    const keys = section.groups.flatMap(g => g.fields.map(f => (f.kind === 'measurement' ? f.metric : f.key)));
    return <div data-q={id}>{keys.map(k => <div key={k} data-key={k}>{place.on(k)}</div>)}</div>;
  };
  // Fixture lab rows as the store hands them: active, never a core row (roadmap-store.ts loadLabValues).
  const labs = w.facts.labValues.filter(r => r.status === 'active' && !('core' in r && r.core === true))
    .map((r): ApiLabValue => ({ id: r.id, metricName: r.metricName, value: r.value, unit: r.unit, referenceLow: null, referenceHigh: null, recordedAt: r.recordedAt, source: 'lab', createdAt: r.recordedAt }));
  return {
    panelRef: createRef<HTMLDivElement>(), messages: null, aboutCard: null, aboutYouLow: true, unitPill: null,
    fullForm: w.facts.formFull, planReady: true, pageOpen: false, renderPage: () => null,
    rows: { ctx: { grading: null, plan: null, unitOf: () => 'si' }, open: () => {}, vitals: [], blood: [], labs, withoutWeight: w.facts.weightAskedWithHeight },
    vitalsCue: <i data-cue="vitals"/>, bloodCue: null, tableShown: false, showTable: () => {}, table: <div className="md-table" hidden/>, addTest: null,
    weightMedications: medicine('weight-medications'),
    lipidMedications: medicine('lipid-medications'),
    screening: place => {
      const section = w.forms.screenings.find(s => s.id === 'cancer-screening');
      return section ? <div data-q="cancer-screening">{section.groups.map(g => <div key={g.id} data-group={g.id} data-note={String(place.noteShown(g.id, 'x'))}>{place.in(g.id)}</div>)}</div> : null;
    },
    boneDensity: () => null,
    supplements: () => <div data-q="supplements"/>,
  };
}

function Page({ w }: { w: World }) {
  const d = w.facts.derived;
  const tiles = [...(d.nonHdl ? [tile('nonHdl', 'Non-HDL', '3.1', 'mmol/L')] : []), ...(d.egfr ? [tile('egfr', 'eGFR', '82', 'mL/min')] : [])];
  const plan = usePlanView({ results: { suggestions: w.suggestions, knownMinor: false } as unknown as HealthResults, shownErase: '', isValid: true, tiles, forms: w.forms, cardsShown: true });
  return (
    <OpenEvidenceContext.Provider value={plan.evidence}>
      <MyHealth form={slots(w)} plan={plan} tiles={tiles} series={{ whtr: d.whtr ? [{ id: 'w', day: DAY, ratio: 0.52 }] : [], egfr: [] }}
                egfrCurrent={d.egfr ? { day: DAY, source: 'calculated' } : null} settingsOpen={false} onSettingsClose={() => {}} onDelete={() => {}} setShowUploadModal={() => {}}/>
    </OpenEvidenceContext.Provider>
  );
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Each topic as drawn, in order: its parts top to bottom. */
function topics(w: World): string[][] {
  const { container } = render(<Page w={w}/>);
  return [...container.querySelectorAll('section.mh-topic')].map(section => [
    `${section.getAttribute('data-topic')}: ${text(section.querySelector('h3'))}`,
    ...[...section.children].slice(1).map(part => {
      if (part.classList.contains('mh-card')) return `card ${part.id}: ${[...part.querySelectorAll('.suggestion-title, h4, strong')].map(text).filter(Boolean)[0] ?? text(part).slice(0, 40)}`;
      if (part.classList.contains('mh-rows-card')) return `rows: ${[...part.querySelectorAll('.md-row-label')].map(text).join(', ')}`;
      if (part.hasAttribute('data-q')) return `questions ${part.getAttribute('data-q')}: ${[...part.querySelectorAll('[data-key], [data-group]')].map(x => `${x.getAttribute('data-key') ?? x.getAttribute('data-group')}=[${text(x)}]${x.hasAttribute('data-note') ? ` note ${x.getAttribute('data-note')}` : ''}`).join('; ')}`;
      return `${part.tagName.toLowerCase()}.${part.className}: ${text(part)}`;
    }),
  ]);
}

/** The container's structure and text, attribute by attribute: what a reader and a screen reader get. */
function serialise(el: Element, depth = 0): string {
  const attrs = [...el.attributes].map(a => `${a.name}="${a.value}"`).join(' ');
  const pad = '  '.repeat(depth);
  const kids = [...el.childNodes].map(n => (n.nodeType === 3 ? (n.textContent?.trim() ? `${pad}  "${n.textContent.trim()}"` : '') : n.nodeType === 1 ? serialise(n as Element, depth + 1) : '')).filter(Boolean);
  return [`${pad}<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ''}>`, ...kids].join('\n');
}

/** A spread of records: the first seed of each kind, so the page snapshots reach every part. */
const KINDS: Array<[string, (w: World) => boolean]> = [
  ['form not full', w => !w.facts.formFull],
  ['no screening form, no screening card', w => w.facts.formFull && w.forms.screenings.length === 0 && !w.suggestions.some(s => s.category === 'screening')],
  ['no screening form, a screening card', w => w.facts.formFull && w.forms.screenings.length === 0 && w.suggestions.some(s => s.category === 'screening')],
  ['an urgent card', w => w.facts.formFull && w.suggestions.some(s => s.priority === 'urgent')],
  ['a medicine placed', w => w.facts.formFull && w.suggestions.some(s => s.id === 'med-statin') && w.forms.medications.some(m => m.groups.some(g => g.fields.some(f => f.kind !== 'measurement' && f.key === 'statin')))],
  ['a screening placed', w => w.facts.formFull && w.forms.screenings.some(s => s.groups.some(g => g.fields.length > 0 && w.suggestions.some(x => x.id.startsWith(`screening-${g.id}`))))],
  ['every derived row and lab rows', w => w.facts.formFull && w.facts.derived.whtr && w.facts.derived.nonHdl && w.facts.derived.egfr && w.facts.labValues.some(r => r.metricName === 'egfr')],
  ['weight asked with height, sleep and fitness cards', w => w.facts.formFull && w.facts.weightAskedWithHeight && w.suggestions.some(s => s.category === 'sleep') && w.suggestions.some(s => s.category === 'exercise')],
];
const spread = KINDS.map(([kind, is]) => [kind, SEEDS.find(seed => is(genWorld(seed)))!] as const);

describe("US-62 AC40: the web's My health, pinned before and after it draws planTopics", () => {
  it('reaches every kind of record', () => {
    expect(spread.every(([, seed]) => seed !== undefined), JSON.stringify(spread)).toBe(true);
  });

  it.each(SEEDS.slice(0, 60))('seed %i: topics, their order, rows, cards, questions and placements', seed => {
    expect(topics(genWorld(seed))).toMatchSnapshot();
  });

  it.each(spread)('the page for %s (seed %i)', (_, seed) => {
    const { container } = render(<Page w={genWorld(seed)}/>);
    expect(serialise(container.querySelector('.mh-page')!)).toMatchSnapshot();
  });
});
