/**
 * Generated My health worlds for planTopics' tests (US-62 AC39, lead I-4). A seeded PRNG
 * (mulberry32), no dependency: random suggestions at random priorities, random medicine and
 * screening forms, random lab rows (core ones, struck ones) and random client facts.
 */
import type { FormField, FormSection } from './input-form';
import type { LabValueRow } from './lab-series';
import { planSections, TOPICS } from './plan-sections';
import { planTopics, type MyHealthLayout, type PlanTopic, type PlanTopicFacts, type TopicRow } from './plan-topics';
import type { Suggestion } from './types';

export function mulberry32(seed: number): () => number {
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
/** Lab tests by name; `core` ones are a blood test's own row (US-66 AC7), never a lab-test row. */
const LABS = ['egfr', 'vitamin_d', 'ferritin', 'tsh'];
const CORE_LABS = ['hba1c', 'ldl'];

export const choice = (key: string): FormField => ({ kind: 'choice', key, label: key, options: [], value: '' });
export const section = (id: string, groups: FormSection['groups']): FormSection => ({ id, title: '', intro: '', groups });

export interface World {
  suggestions: Suggestion[];
  forms: { medications: FormSection[]; screenings: FormSection[] };
  facts: PlanTopicFacts;
}

export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function genWorld(seed: number): World {
  const r = mulberry32(seed);
  const coin = (p: number) => r() < p;
  const some = (xs: readonly string[], p: number) => xs.filter(() => coin(p));
  const priority = (): Suggestion['priority'] => (coin(0.15) ? 'urgent' : coin(0.4) ? 'attention' : 'info');
  const suggestions = shuffle(r, POOL.flatMap(([category, ids]) => some(ids, 0.4).map((id): Suggestion => ({ id, category, priority: priority(), title: id, description: '' }))));
  const medications: FormSection[] = [];
  if (coin(0.6)) medications.push(section('lipid-medications', [{ id: 'lipid', title: '', notes: [], fields: some(LIPID_KEYS, 0.6).map(choice) }]));
  if (coin(0.6)) medications.push(section('weight-medications', [{ id: 'weight', title: '', notes: [], fields: some(WEIGHT_KEYS, 0.6).map(choice) }]));
  const groups = coin(0.25) ? [] : SCREENING_GROUPS.filter(() => coin(0.7)).map((id) => ({ id, title: id, notes: [], fields: coin(0.6) ? [choice(`${id}_method`)] : [] }));
  const screenings = groups.length > 0 ? [section('cancer-screening', groups)] : [];
  const labValues: Array<LabValueRow & { core?: boolean }> = [...some(LABS, 0.5), ...some(CORE_LABS, 0.5).map((m) => `core:${m}`)].flatMap((name, i) => {
    const metricName = name.replace('core:', '');
    const row = { id: `lab-${i}`, metricName, value: 1 + i, unit: 'u', recordedAt: `2026-0${1 + (i % 9)}-15T00:00:00Z`, status: coin(0.15) ? 'entered-in-error' : 'active' };
    return [name.startsWith('core:') ? { ...row, core: true } : row];
  });
  const facts: PlanTopicFacts = {
    formFull: coin(0.85),
    derived: { whtr: coin(0.5), nonHdl: coin(0.5), egfr: coin(0.5) },
    weightAskedWithHeight: coin(0.3),
    labValues: shuffle(r, labValues),
    deviceHealth: coin(0.5),
    // The engine shows a note when no screening question can be offered; now and then beside one too.
    screeningNote: screenings.length === 0 ? coin(0.6) : coin(0.15),
  };
  return { suggestions, forms: { medications, screenings }, facts };
}

export const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
export const layoutOf = (w: World, suggestions = w.suggestions): MyHealthLayout => planTopics(planSections(suggestions), w.forms, w.facts);
/** The topics; a world whose form is not full is drawn as full, for the properties about topics. */
export const run = (w: World, suggestions = w.suggestions): PlanTopic[] => {
  const layout = layoutOf({ ...w, facts: { ...w.facts, formFull: true } }, suggestions);
  if (layout.kind !== 'topics') throw new Error('a full form has topics');
  return layout.topics;
};
export const cardIds = (t: PlanTopic) => [...t.urgent, ...t.cards].flatMap((c) => c.suggestions.map((s) => s.id));
export const placedIds = (t: PlanTopic) => [...t.medicines, ...t.screenings].flatMap((p) => p.suggestions.map((s) => s.id));
export const rowName = (row: TopicRow) => (row.kind === 'core' ? row.metric : row.kind === 'lab' ? `lab:${row.seriesKey}` : row.kind);
export const TOPIC_ORDER = TOPICS.map(({ topic }) => topic);
