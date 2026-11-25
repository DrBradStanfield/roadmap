/**
 * US-62 AC39 (lead I-4): planTopics over generated plans. A seeded PRNG (mulberry32), no
 * dependency: 400 plans, each a random set of suggestions at random priorities, random
 * medicine and screening forms and random row facts. The oracles never read planTopics' own
 * rules: they count where each input suggestion lands, read TOPICS' order, and transcribe the
 * web's My health selector (MyHealth.tsx:140-157, :177-228) as it stood when this rule was written.
 * A failure prints the seed.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, FormSection } from './input-form';
import { BLOOD_TEST_METRICS, METRIC_TO_FIELD } from './mappings';
import { planSections, TOPICS, type TopicId } from './plan-sections';
import { planTopics, type PlanTopic, type TopicRow, type TopicRowFacts } from './plan-topics';
import type { Suggestion } from './types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Real ids (suggestions.ts families) by category: every topic and placement can be reached. */
const POOL: Array<[Suggestion['category'], string[]]> = [
  ['nutrition', ['protein-target', 'fiber', 'low-salt', 'lipid-diet', 'reduce-alcohol']],
  ['exercise', ['exercise']], ['sleep', ['sleep']], ['general', ['measure-waist', 'measure-bp']],
  ['bloodwork', ['apob-high', 'ldl-high', 'hba1c-prediabetic', 'psa-raised', 'hdl-low']],
  ['medication', ['med-statin', 'med-statin-dose', 'med-ezetimibe', 'med-pcsk9i', 'weight-glp1', 'weight-med-sglt2i']],
  ['blood_pressure', ['bp-stage2']],
  ['screening', ['screening-colorectal-due', 'screening-lung-overdue', 'screening-cervical-due', 'screening-breast-due']],
  ['skin', ['skin-sunscreen']], ['supplements', ['supplement-omega3', 'supplement-creatine']],
];
const LIPID_KEYS = ['statin', 'statin_dose', 'ezetimibe', 'pcsk9i', 'bempedoic_acid'];
const WEIGHT_KEYS = ['glp1', 'glp1_dose', 'sglt2i', 'metformin'];
const SCREENING_GROUPS = ['colorectal', 'lung', 'cervical', 'breast'];
const LABS = ['egfr', 'vitamin_d', 'ferritin', 'tsh'];

const choice = (key: string): FormField => ({ kind: 'choice', key, label: key, options: [], value: '' });
const section = (id: string, groups: FormSection['groups']): FormSection => ({ id, title: '', intro: '', groups });

interface World {
  suggestions: Suggestion[];
  forms: { medications: FormSection[]; screenings: FormSection[] };
  facts: TopicRowFacts;
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function genWorld(seed: number): World {
  const r = mulberry32(seed);
  const coin = (p: number) => r() < p;
  const some = (xs: readonly string[], p: number) => xs.filter(() => coin(p));
  const priority = (): Suggestion['priority'] => (coin(0.15) ? 'urgent' : coin(0.4) ? 'attention' : 'info');
  const suggestions = shuffle(r, POOL.flatMap(([category, ids]) => some(ids, 0.4).map((id): Suggestion => ({ id, category, priority: priority(), title: id, description: '' }))));
  const medications: FormSection[] = [];
  if (coin(0.6)) medications.push(section('lipid-medications', [{ id: 'lipid', title: '', notes: [], fields: some(LIPID_KEYS, 0.6).map(choice) }]));
  if (coin(0.6)) medications.push(section('weight-medications', [{ id: 'weight', title: '', notes: [], fields: some(WEIGHT_KEYS, 0.6).map(choice) }]));
  const groups = SCREENING_GROUPS.filter(() => coin(0.7)).map((id) => ({ id, title: id, notes: [], fields: coin(0.6) ? [choice(`${id}_method`)] : [] }));
  const screenings = groups.length > 0 ? [section('cancer-screening', groups)] : [];
  const facts: TopicRowFacts = {
    whtr: coin(0.5), weight: coin(0.7), egfr: coin(0.5), nonHdl: coin(0.5), labs: shuffle(r, some(LABS, 0.5)),
    // The form draws a screening question when one of its groups asks one (a consistent world: see the PR's questions).
    screeningAsked: groups.some((g) => g.fields.length > 0) || coin(0.2),
  };
  return { suggestions, forms: { medications, screenings }, facts };
}

const run = (w: World, suggestions = w.suggestions) => planTopics(planSections(suggestions), w.forms, w.facts);
const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const cardIds = (t: PlanTopic) => [...t.urgent, ...t.cards].flatMap((c) => c.suggestions.map((s) => s.id));
const placedIds = (t: PlanTopic) => [...t.medicines, ...t.screenings].flatMap((p) => p.suggestions.map((s) => s.id));
const rowName = (row: TopicRow) => (row.kind === 'core' ? row.metric : row.kind === 'lab' ? `lab:${row.seriesKey}` : row.kind);

/** The web's selector, transcribed from MyHealth.tsx:140-157 (rows) and :177-228 (which topics), for a full form. */
function webOracle(w: World, cardTopics: Set<TopicId>): Array<[TopicId, string[]]> {
  const f = w.facts;
  const egfr = f.egfr ? ['egfr'] : [];
  const blood = BLOOD_TEST_METRICS.filter((m) => m !== 'psa' && METRIC_TO_FIELD[m]);
  const rows: Partial<Record<TopicId, string[]>> = {
    weight: [f.whtr ? 'whtr' : 'waist', ...(f.weight ? ['weight'] : []), 'hba1c'],
    bloodPressure: ['bp', 'creatinine', ...egfr],
    cholesterol: ['apob', 'ldl', 'total_cholesterol', 'hdl', ...(f.nonHdl ? ['nonHdl'] : []), 'triglycerides', 'lpa'],
    bloodTests: [...blood.flatMap((m) => (m === 'creatinine' ? [m, ...egfr] : [m])), ...(f.egfr ? f.labs.filter((k) => k !== 'egfr') : f.labs).map((k) => `lab:${k}`)],
  };
  const always: TopicId[] = ['bloodTests', 'supplements'];
  return TOPICS.map(({ topic }) => topic)
    .filter((t) => always.includes(t) || rows[t] || (t === 'screening' && f.screeningAsked) || cardTopics.has(t))
    .map((t) => [t, rows[t] ?? []]);
}

describe('planTopics over generated plans (US-62 AC39)', () => {
  it('every suggestion is drawn: once as a card, or once on a question; an urgent placed one as both, in one topic', () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const cards = topics.flatMap(cardIds);
      const placed = topics.flatMap(placedIds);
      for (const s of w.suggestions) {
        const inCards = cards.filter((id) => id === s.id).length;
        const onRows = placed.filter((id) => id === s.id).length;
        const where = `seed ${seed}, ${s.id} (${s.priority})`;
        expect(inCards + onRows, where).toBeGreaterThan(0);
        expect(inCards, where).toBeLessThanOrEqual(1);
        expect(onRows, where).toBeLessThanOrEqual(1);
        if (onRows === 1) expect(inCards, where).toBe(s.priority === 'urgent' ? 1 : 0);
        if (inCards + onRows === 2) expect(topics.filter((t) => cardIds(t).includes(s.id) && placedIds(t).includes(s.id)), where).toHaveLength(1);
      }
      expect(new Set([...cards, ...placed]), `seed ${seed}`).toEqual(new Set(w.suggestions.map((s) => s.id)));
    }
  });

  it('no topic comes back empty, and an urgent card sits over the rows, the rest under them', () => {
    for (const seed of SEEDS) {
      for (const t of run(genWorld(seed))) {
        expect(t.urgent.length + t.cards.length + t.rows.length + (t.questions ? 1 : 0), `seed ${seed}, ${t.topic}`).toBeGreaterThan(0);
        expect(t.urgent.every((c) => c.priority === 'urgent') && t.cards.every((c) => c.priority !== 'urgent'), `seed ${seed}, ${t.topic}`).toBe(true);
      }
    }
  });

  it("topics follow TOPICS' order, and the topics, rows and each topic's suggestions do not move when the plan's suggestions arrive in another order", () => {
    const order = TOPICS.map(({ topic }) => topic);
    const shape = (topics: PlanTopic[]) => topics.map((t) => [t.topic, t.rows.map(rowName), [...cardIds(t)].sort(), [...placedIds(t)].sort()]);
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const at = topics.map((t) => order.indexOf(t.topic));
      expect(at, `seed ${seed}`).toEqual([...at].sort((a, b) => a - b));
      expect(new Set(at).size, `seed ${seed}`).toBe(at.length);
      expect(shape(run(w, shuffle(mulberry32(seed * 7919), w.suggestions))), `seed ${seed}`).toEqual(shape(topics));
    }
  });

  it("the topics and every topic's rows are the web's My health selector's", () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const cardTopics = new Set(topics.filter((t) => t.urgent.length + t.cards.length > 0).map((t) => t.topic));
      expect(topics.map((t): [TopicId, string[]] => [t.topic, t.rows.map(rowName)]), `seed ${seed}`).toEqual(webOracle(w, cardTopics));
    }
  });
});

describe('planTopics examples (US-62 AC39)', () => {
  const s = (id: string, priority: Suggestion['priority'], category: Suggestion['category']): Suggestion => ({ id, priority, category, title: id, description: '' });
  const forms = {
    medications: [section('lipid-medications', [{ id: 'statin', title: '', notes: [], fields: [choice('statin')] }]),
      section('weight-medications', [{ id: 'glp1', title: '', notes: [], fields: [choice('glp1')] }])],
    screenings: [section('cancer-screening', [{ id: 'lung', title: 'Lung', notes: [], fields: [choice('lung_method')] }])],
  };
  const facts: TopicRowFacts = { whtr: true, weight: true, egfr: true, nonHdl: true, labs: ['egfr', 'ferritin'], screeningAsked: true };

  it('places each medicine in the topic whose form section asks it, the screening one in Cancer screening, and leaves the lab eGFR to the eGFR row', () => {
    const topics = planTopics(planSections([s('med-statin', 'attention', 'medication'), s('weight-glp1', 'urgent', 'medication'), s('screening-lung-overdue', 'attention', 'screening')]), forms, facts);
    const by = new Map(topics.map((t) => [t.topic, t]));
    expect(topics.map((t) => t.topic)).toEqual(['weight', 'bloodPressure', 'cholesterol', 'screening', 'bloodTests', 'supplements']);
    expect(by.get('cholesterol')!.medicines).toEqual([{ key: 'statin', suggestions: [expect.objectContaining({ id: 'med-statin' })] }]);
    expect(by.get('weight')!.medicines.map((m) => m.key)).toEqual(['glp1']);
    expect(by.get('weight')!.urgent.flatMap((c) => c.suggestions.map((x) => x.id))).toEqual(['weight-glp1']);
    expect(by.get('screening')!.screenings.map((g) => g.group)).toEqual(['lung']);
    expect(by.get('bloodTests')!.rows.map(rowName)).toEqual(['hba1c', 'creatinine', 'egfr', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa', 'lab:ferritin']);
    expect(by.get('cholesterol')!.rows.map(rowName)).toEqual(['apob', 'ldl', 'total_cholesterol', 'hdl', 'nonHdl', 'triglycerides', 'lpa']);
    expect(topics.map((t) => [t.topic, t.questions])).toEqual([['weight', 'weight-medications'], ['bloodPressure', null], ['cholesterol', 'lipid-medications'],
      ['screening', 'cancer-screening'], ['bloodTests', null], ['supplements', 'supplements']]);
  });

  it('with no ratio, no eGFR row and the weight asked elsewhere: waist leads, the lab eGFR stays in Blood tests', () => {
    const topics = planTopics([], { medications: [], screenings: [] }, { whtr: false, weight: false, egfr: false, nonHdl: false, labs: ['egfr'], screeningAsked: false });
    expect(topics.map((t) => [t.topic, t.rows.map(rowName)])).toEqual([
      ['weight', ['waist', 'hba1c']], ['bloodPressure', ['bp', 'creatinine']],
      ['cholesterol', ['apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa']],
      ['bloodTests', ['hba1c', 'creatinine', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa', 'lab:egfr']],
      ['supplements', []],
    ]);
  });
});
