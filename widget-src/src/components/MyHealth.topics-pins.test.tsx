// @vitest-environment jsdom
/**
 * US-62 AC40 (lead W1-5): pins of what the web's My health draws, through the rendered page, for the
 * generated worlds planTopics is tested on (plan-topics.fixtures.ts): the topics in order, each
 * topic's rows, its cards (urgent ones over the rows), its ownership line, its questions and the
 * suggestions placed on them. Written on main before My health moved onto planTopics; the move
 * must leave every snapshot as it was. The page snapshots are the whole My health container's
 * structure and text for a spread of records (not full, a note, urgent, placements).
 * The varied worlds add what the plain ones lack: the Shopify surface (the US product overlay and
 * its ownership line), saved vitals and blood tests, conventional units, the blood-test table open,
 * a bone density section and the same suggestions repeated across topics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core/types';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { StatTile } from '@roadmap/health-core/stat-tiles';
import { choice, genWorld, mulberry32, section, SEEDS, type World } from '@roadmap/health-core/plan-topics.fixtures';
import { MyHealth, type FormSlots, type Placement } from './MyHealth';
import { OpenEvidenceContext } from './PlanCards';
import { usePlanView } from './ResultsPanel';
import { setMarketCountry } from '../lib/market-country';
import type { ApiLabValue } from '../lib/api-types';

const flags = vi.hoisted(() => ({ shopify: false }));
vi.mock('../lib/build-flags', async importOriginal => ({ ...await importOriginal<typeof import('../lib/build-flags')>(), get SHOPIFY_SURFACE() { return flags.shopify; } }));
vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);
afterEach(() => { flags.shopify = false; setMarketCountry(null); });

const DAY = '2026-01-15';
const tile = (key: StatTile['key'], label: string, value: string, unit: string): StatTile => ({ key, label, value, unit, about: '' });

/** What a world is drawn with beyond the fixture: none of it in the plain worlds. */
interface Variant {
  /** The Shopify build in the US: the product overlay on the supplement cards and its ownership line. */
  shopify: boolean;
  units: 'si' | 'conventional';
  /** Saved vitals and blood tests, two days of each. */
  values: boolean;
  tableShown: boolean;
  /** A bone density section (DEXA asked), sometimes with a DEXA suggestion placed on it. */
  bone: boolean;
  /** The same suggestions again, at another priority and in another topic. */
  repeated: boolean;
}
const PLAIN: Variant = { shopify: false, units: 'si', values: false, tableShown: false, bone: false, repeated: false };

/** Two days of SI values for every core row (fake numbers, inside each metric's range). */
const VALUES: Array<[string, number, number]> = [
  ['weight', 82, 84], ['waist', 94, 96], ['systolic_bp', 132, 138], ['diastolic_bp', 84, 86],
  ['hba1c', 39, 41], ['apob', 1.0, 1.1], ['ldl', 3.1, 3.4], ['total_cholesterol', 5.2, 5.6], ['hdl', 1.3, 1.2],
  ['triglycerides', 1.6, 1.9], ['lpa', 60, 62], ['creatinine', 88, 90],
];
const VITALS = new Set(['weight', 'waist', 'systolic_bp', 'diastolic_bp']);
const measurements = (vitals: boolean): ApiMeasurement[] => VALUES.filter(([m]) => VITALS.has(m) === vitals)
  .flatMap(([metricType, latest, previous]) => [[latest, '2026-01-10'], [previous, '2025-07-10']].map(([value, day], i): ApiMeasurement => ({
    id: `${metricType}-${i}`, metricType, value: value as number, recordedAt: `${day}T00:00:00Z`, createdAt: `${day}T00:00:00Z`,
  })));

/** The world as drawn under the variant. */
function vary(w: World, v: Variant, seed: number): World {
  const r = mulberry32(seed * 7919);
  let { suggestions } = w;
  const screenings = [...w.forms.screenings];
  if (v.bone) {
    screenings.push(section('bone-density', [{ id: 'dexa', title: '', notes: [], fields: r() < 0.7 ? [choice('dexa_screening')] : [] }]));
    if (r() < 0.7) suggestions = [...suggestions, { id: 'screening-dexa-overdue', category: 'screening', priority: r() < 0.3 ? 'urgent' : 'attention', title: 'screening-dexa-overdue', description: '' }];
  }
  if (v.repeated) {
    const other = (p: Suggestion['priority']): Suggestion['priority'] => (p === 'urgent' ? 'info' : p === 'info' ? 'attention' : 'urgent');
    const again = suggestions.slice(0, 3).flatMap((s): Suggestion[] => [{ ...s, priority: other(s.priority) }, { ...s, category: s.category === 'sleep' ? 'exercise' : 'sleep' }]);
    suggestions = [...suggestions, ...again];
  }
  return { ...w, suggestions, forms: { ...w.forms, screenings } };
}

/** A varied world for a seed: each part on about half the time, Shopify on whenever a product card can show. */
function variantOf(seed: number): Variant {
  const r = mulberry32(seed * 104729);
  return { shopify: r() < 0.5, units: r() < 0.5 ? 'conventional' : 'si', values: r() < 0.7, tableShown: r() < 0.3, bone: r() < 0.5, repeated: r() < 0.4 };
}

/** The form's question parts as the fixture's forms hold them: a part per medicine section and the
 *  screening sections (none without one, as InputPanel's renderers), each showing what is placed on it. */
function slots(w: World, v: Variant): FormSlots {
  const medicine = (id: string) => (place: Placement) => {
    const section = w.forms.medications.find(s => s.id === id);
    if (!section) return null;
    const keys = section.groups.flatMap(g => g.fields.map(f => (f.kind === 'measurement' ? f.metric : f.key)));
    return <div data-q={id}>{keys.map(k => <div key={k} data-key={k}>{place.on(k)}</div>)}</div>;
  };
  const screening = (id: string) => (place: Placement) => {
    const section = w.forms.screenings.find(s => s.id === id);
    return section ? <div data-q={id}>{section.groups.map(g => <div key={g.id} data-group={g.id} data-note={String(place.noteShown(g.id, 'x'))}>{place.in(g.id)}</div>)}</div> : null;
  };
  // Fixture lab rows as the store hands them: active, never a core row (roadmap-store.ts loadLabValues).
  const labs = w.facts.labValues.filter(r => r.status === 'active' && !('core' in r && r.core === true))
    .map((r): ApiLabValue => ({ id: r.id, metricName: r.metricName, value: r.value, unit: r.unit, referenceLow: null, referenceHigh: null, recordedAt: r.recordedAt, source: 'lab', createdAt: r.recordedAt }));
  return {
    panelRef: createRef<HTMLDivElement>(), messages: null, aboutCard: null, aboutYouLow: true, unitPill: null,
    fullForm: w.facts.formFull, planReady: true, pageOpen: false, renderPage: () => null,
    rows: {
      ctx: { grading: v.values ? { sex: 'female' } : null, plan: null, unitOf: () => v.units }, open: () => {},
      vitals: v.values ? measurements(true) : [], blood: v.values ? measurements(false) : [], labs, withoutWeight: w.facts.weightAskedWithHeight,
    },
    vitalsCue: <i data-cue="vitals"/>, bloodCue: null, tableShown: v.tableShown, showTable: () => {},
    table: <div className="md-table" hidden={!v.tableShown}>{v.tableShown && 'the blood-test table'}</div>, addTest: null,
    weightMedications: medicine('weight-medications'),
    lipidMedications: medicine('lipid-medications'),
    screening: screening('cancer-screening'),
    boneDensity: screening('bone-density'),
    supplements: () => <div data-q="supplements"/>,
  };
}

function Page({ w, v }: { w: World; v: Variant }) {
  const d = w.facts.derived;
  const tiles = [...(d.nonHdl ? [tile('nonHdl', 'Non-HDL', '3.1', 'mmol/L')] : []), ...(d.egfr ? [tile('egfr', 'eGFR', '82', 'mL/min')] : [])];
  const plan = usePlanView({ results: { suggestions: w.suggestions, knownMinor: false, age: 55 } as unknown as HealthResults, shownErase: '', isValid: true, tiles, forms: w.forms, cardsShown: true });
  return (
    <OpenEvidenceContext.Provider value={plan.evidence}>
      <MyHealth form={slots(w, v)} plan={plan} tiles={tiles} series={{ whtr: d.whtr ? [{ id: 'w', day: DAY, ratio: 0.52 }] : [], egfr: [] }}
                egfrCurrent={d.egfr ? { day: DAY, source: 'calculated' } : null} settingsOpen={false} onSettingsClose={() => {}} onDelete={() => {}} setShowUploadModal={() => {}}/>
    </OpenEvidenceContext.Provider>
  );
}

function draw(w: World, v: Variant) {
  flags.shopify = v.shopify;
  setMarketCountry(v.shopify ? 'US' : null);
  return render(<Page w={w} v={v}/>).container;
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Each topic as drawn, in order: its parts top to bottom. */
function topics(w: World, v: Variant): string[][] {
  const container = draw(w, v);
  return [...container.querySelectorAll('section.mh-topic')].map(section => [
    `${section.getAttribute('data-topic')}: ${text(section.querySelector('h3'))}`,
    ...[...section.children].slice(1).map(part => {
      if (part.classList.contains('mh-card')) return `card ${part.id}: ${[...part.querySelectorAll('.suggestion-title, h4, strong')].map(text).filter(Boolean)[0] ?? text(part).slice(0, 40)}`;
      if (part.classList.contains('mh-rows-card')) {
        const table = part.querySelector('.md-table:not([hidden])') ? ' + table' : '';
        return `rows: ${[...part.querySelectorAll('.md-row')].map(text).join(' | ')}${table}`;
      }
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

const full = (w: World) => w.facts.formFull;
const PRODUCT_CARDS = ['supplement-creatine'];
/** The varied kinds: each variant on a record that shows it (the full form; a product card for Shopify). */
const VARIED: Array<[string, Variant, (w: World) => boolean]> = [
  ['Shopify in the US, a product card and its ownership line', { ...PLAIN, shopify: true }, w => full(w) && w.suggestions.some(s => PRODUCT_CARDS.includes(s.id))],
  ['Shopify, the form not full', { ...PLAIN, shopify: true }, w => !full(w) && w.suggestions.some(s => PRODUCT_CARDS.includes(s.id))],
  ['saved vitals and blood tests, SI', { ...PLAIN, values: true }, w => full(w) && w.facts.derived.nonHdl && !w.facts.weightAskedWithHeight],
  ['saved vitals and blood tests, conventional units', { ...PLAIN, values: true, units: 'conventional' }, w => full(w) && w.facts.derived.nonHdl && !w.facts.weightAskedWithHeight],
  ['the blood-test table open', { ...PLAIN, values: true, tableShown: true }, w => full(w) && w.facts.labValues.some(r => r.status === 'active')],
  ['bone density beside cancer screening', { ...PLAIN, bone: true }, w => full(w) && w.forms.screenings.length > 0],
  ['bone density alone', { ...PLAIN, bone: true }, w => full(w) && w.forms.screenings.length === 0],
  ['the same suggestions in two topics and at two priorities', { ...PLAIN, repeated: true, shopify: true }, w => full(w) && w.suggestions.length >= 3],
];
const variedSpread = VARIED.map(([kind, v, is]) => {
  const seed = SEEDS.find(s => is(genWorld(s)));
  return [kind, seed!, v] as const;
});

describe("US-62 AC40: the web's My health, pinned before and after it draws planTopics", () => {
  it('reaches every kind of record', () => {
    expect(spread.every(([, seed]) => seed !== undefined), JSON.stringify(spread)).toBe(true);
    expect(variedSpread.every(([, seed]) => seed !== undefined), JSON.stringify(variedSpread)).toBe(true);
  });

  it('the varied worlds reach every variant', () => {
    const vs = SEEDS.slice(60, 120).map(variantOf);
    for (const key of ['shopify', 'values', 'tableShown', 'bone', 'repeated'] as const) expect(vs.some(v => v[key]), key).toBe(true);
    expect(vs.some(v => v.units === 'conventional')).toBe(true);
    // The overlay draws: some varied world shows the ownership line.
    expect(SEEDS.slice(60, 120).some(seed => {
      const v = variantOf(seed);
      const shown = v.shopify && draw(vary(genWorld(seed), v, seed), v).querySelector('.us-ownership') !== null;
      cleanup();
      return shown;
    })).toBe(true);
  });

  it.each(SEEDS.slice(0, 60))('seed %i: topics, their order, rows, cards, questions and placements', seed => {
    expect(topics(genWorld(seed), PLAIN)).toMatchSnapshot();
  });

  it.each(SEEDS.slice(60, 120))('seed %i varied: topics, rows, cards, questions and placements', seed => {
    const v = variantOf(seed);
    expect([JSON.stringify(v), ...topics(vary(genWorld(seed), v, seed), v).map(t => t.join('\n'))]).toMatchSnapshot();
  });

  it.each(spread)('the page for %s (seed %i)', (_, seed) => {
    expect(serialise(draw(genWorld(seed), PLAIN).querySelector('.mh-page')!)).toMatchSnapshot();
  });

  it.each(variedSpread)('the page for %s (seed %i)', (_, seed, v) => {
    expect(serialise(draw(vary(genWorld(seed), v, seed), v).querySelector('.mh-page')!)).toMatchSnapshot();
  });
});
