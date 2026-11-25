/**
 * US-62 AC39 (lead I-4). A characterisation, not a rule: what the web's My health draws today
 * (MyHealth.tsx:140-157 rows, :159-171 placements, :177-228 topics; ResultsPanel.tsx:156-159 cards,
 * transcribed when planTopics was written) against planTopics after the owner's rulings (2026-11-25).
 * The oracle runs the web's own selector (`topicSections` on the web's forms, split as usePlanView
 * splits it), never planTopics. Each remaining difference is named and expected; any other difference
 * fails. Then examples of each ruling. Since US-62 AC40 the web draws planTopics, and keeps today's
 * screen at each difference behind a constant in widget-src/src/components/MyHealth.tsx, pinned by
 * MyHealth.topics-pins.test.tsx: D3 (a topic with only the note) `WEB_DRAWS_NOTE_ONLY_SCREENING_TOPIC`,
 * D9 `WEB_DRAWS_WAITING_OTHER`. Each is false until the owner rules; turning one true makes that
 * difference visible. D3 (the note as questions under cards) needs no constant: the web has no note
 * words yet, and where the screening form is empty its renderers draw nothing.
 */
import { describe, expect, it } from 'vitest';
import { BLOOD_TEST_METRICS, METRIC_TO_FIELD } from './mappings';
import { labSeriesRows } from './lab-series';
import { planSections, TOPICS, topicSections, type TopicCard, type TopicId } from './plan-sections';
import { planTopics, type PlanTopic, type PlanTopicFacts } from './plan-topics';
import { choice, genWorld, layoutOf, rowName, run, section, SEEDS, type World } from './plan-topics.fixtures';
import type { Suggestion } from './types';

/** One topic as drawn: its rows, its cards (each card's ids), its questions and what sits on them. */
interface Drawn {
  topic: TopicId; rows: string[]; urgent: string[][]; cards: string[][]; ownershipLine?: string;
  questions: string | null; medicines: Array<[string, string[]]>; screenings: Array<[string, string[]]>;
}
const ids = (cards: readonly TopicCard[]) => cards.map((c) => c.suggestions.map((s) => s.id));
const placed = (xs: ReadonlyArray<{ suggestions: Suggestion[] }>, by: (x: never) => string) =>
  xs.map((x): [string, string[]] => [by(x as never), x.suggestions.map((s) => s.id)]);

/** The web today, for a full form. It has no device source and no screening note. Its cards:
 *  `topicSections` on its forms, urgent ones apart (ResultsPanel.tsx:156-159). Its placements: the
 *  layout's, drawn by the medicine section that asks the key and the screening form's groups
 *  (MyHealth.tsx:159-171). Its questions: each medicine section it holds, Cancer screening when the
 *  screening form draws (`screeningForm`, pinned by InputPanel.input-form-parity.test.tsx), Supplements'
 *  always. Its lab rows: `labSeriesRows` of the store's active non-core rows (roadmap-store.ts:274). */
function webToday(w: World): Drawn[] {
  const f = w.facts;
  const layout = topicSections(planSections(w.suggestions), w.forms);
  const egfr = f.derived.egfr ? ['egfr'] : [];
  const blood = BLOOD_TEST_METRICS.filter((m) => m !== 'psa' && METRIC_TO_FIELD[m]);
  const labs = labSeriesRows(f.labValues.filter((r) => r.status === 'active' && !('core' in r && r.core === true))).map((r) => r.seriesKey);
  const rows: Partial<Record<TopicId, string[]>> = {
    weight: [f.derived.whtr ? 'whtr' : 'waist', ...(f.weightAskedWithHeight ? [] : ['weight']), 'hba1c'],
    bloodPressure: ['bp', 'creatinine', ...egfr],
    cholesterol: ['apob', 'ldl', 'total_cholesterol', 'hdl', ...(f.derived.nonHdl ? ['nonHdl'] : []), 'triglycerides', 'lpa'],
    bloodTests: [...blood.flatMap((m) => (m === 'creatinine' ? [m, ...egfr] : [m])), ...(f.derived.egfr ? labs.filter((k) => k !== 'egfr') : labs).map((k) => `lab:${k}`)],
  };
  const medicineSection = (id: string) => w.forms.medications.find((m) => m.id === id);
  const medicinesIn = (id: string) => {
    const asked = new Set(medicineSection(id)?.groups.flatMap((g) => g.fields.map((x) => (x.kind === 'measurement' ? x.metric : x.key))) ?? []);
    return placed(layout.medicines.filter(({ key }) => asked.has(key)), (m: { key: string }) => m.key);
  };
  const questions: Partial<Record<TopicId, string>> = {
    ...(medicineSection('weight-medications') ? { weight: 'weight-medications' } : null),
    ...(medicineSection('lipid-medications') ? { cholesterol: 'lipid-medications' } : null),
    ...(w.forms.screenings.length > 0 ? { screening: 'cancer-screening' } : null),
    supplements: 'supplements',
  };
  return TOPICS.flatMap(({ topic }): Drawn[] => {
    const all = layout.sections.find((x) => x.topic === topic);
    const cards = all?.cards ?? [];
    if (topic !== 'bloodTests' && topic !== 'supplements' && !rows[topic] && !questions[topic] && !all) return [];
    return [{
      topic, rows: rows[topic] ?? [],
      urgent: ids(cards.filter((c) => c.priority === 'urgent')), cards: ids(cards.filter((c) => c.priority !== 'urgent')),
      ...(all?.ownershipLine ? { ownershipLine: all.ownershipLine } : null),
      questions: questions[topic] ?? null,
      medicines: topic === 'weight' ? medicinesIn('weight-medications') : topic === 'cholesterol' ? medicinesIn('lipid-medications') : [],
      screenings: topic === 'screening' ? placed(layout.screenings, (g: { group: string }) => g.group) : [],
    }];
  });
}

const drawn = (t: PlanTopic): Drawn => ({
  topic: t.topic, rows: t.rows.map(rowName), urgent: ids(t.urgent), cards: ids(t.cards),
  ...(t.ownershipLine ? { ownershipLine: t.ownershipLine } : null), questions: t.questions,
  medicines: placed(t.medicines, (m: { key: string }) => m.key),
  screenings: placed(t.screenings, (g: { group: string }) => g.group),
});

/** A world as the web would describe it under the rulings: no device health source, and the note
 *  wherever the screening form is empty (the engine's rule, my-data-forms.ts:228). */
const asWeb = (w: World): World => ({ ...w, facts: { ...w.facts, deviceHealth: false, screeningNote: w.forms.screenings.length === 0 } });

/** D3: where the web draws no screening form, the rule draws the note as Cancer screening's questions:
 *  on the web's topic when a card draws it (where the web's renderers draw nothing), else on a
 *  topic of its own with nothing else (held back by `WEB_DRAWS_NOTE_ONLY_SCREENING_TOPIC`). */
const D3 = (web: Drawn | undefined): Drawn => ({ ...(web ?? { topic: 'screening', rows: [], urgent: [], cards: [], medicines: [], screenings: [] }), questions: 'cancer-screening' });

describe("the web's screen against planTopics: the expected differences (US-62 AC39)", () => {
  it('topics, rows, cards, questions and placements match the web but for D3 (the note as the Cancer screening questions where the web draws no screening form, the topic added if the web draws none) and D9 (before the form is full the web draws no topics, the rule hands it every card in Other)', () => {
    let added = 0, noted = 0, waiting = 0;
    const compared = { cards: 0, medicines: 0, screenings: 0 };
    for (const seed of SEEDS) {
      const w = asWeb(genWorld(seed));
      const layout = layoutOf(w);
      if (!w.facts.formFull) {
        // D9: the web draws nothing here (MyHealth's `WEB_DRAWS_WAITING_OTHER`); the rule's Other holds every suggestion.
        expect(layout.kind, `seed ${seed}`).toBe('waiting');
        if (layout.kind === 'waiting') expect([...layout.urgent, ...layout.other].flatMap((c) => c.suggestions.map((x) => x.id)).sort(), `seed ${seed}`).toEqual(w.suggestions.map((x) => x.id).sort());
        waiting++;
        continue;
      }
      const web = webToday(w);
      const webScreening = web.find((t) => t.topic === 'screening');
      const note = w.forms.screenings.length === 0;
      const expected = !note ? web : TOPICS.flatMap(({ topic }) => (topic === 'screening' ? [D3(webScreening)] : web.filter((t) => t.topic === topic)));
      expect(run(w).map(drawn), `seed ${seed}`).toEqual(expected);
      if (note && webScreening) noted++;
      if (note && !webScreening) added++;
      for (const t of web) {
        compared.cards += t.urgent.length + t.cards.length;
        compared.medicines += t.medicines.length;
        compared.screenings += t.screenings.length;
      }
    }
    // Both differences are reached, and every part is compared somewhere.
    expect([added, noted].every((n) => n > 0), `added ${added}, noted ${noted}`).toBe(true);
    expect(waiting).toBeGreaterThan(0);
    expect(Object.values(compared).every((n) => n > 0), JSON.stringify(compared)).toBe(true);
  });
});

describe('planTopics examples (US-62 AC39)', () => {
  const s = (id: string, priority: Suggestion['priority'], category: Suggestion['category']): Suggestion => ({ id, priority, category, title: id, description: '' });
  const forms = {
    medications: [section('lipid-medications', [{ id: 'statin', title: '', notes: [], fields: [choice('statin')] }]),
      section('weight-medications', [{ id: 'glp1', title: '', notes: [], fields: [choice('glp1')] }])],
    screenings: [section('cancer-screening', [{ id: 'lung', title: 'Lung', notes: [], fields: [choice('lung_method')] }])],
  };
  const lab = (id: string, metricName: string, core = false) => ({ id, metricName, value: 1, unit: 'u', recordedAt: '2026-01-15T00:00:00Z', status: 'active', ...(core ? { core } : null) });
  const facts: PlanTopicFacts = {
    formFull: true, derived: { whtr: true, nonHdl: true, egfr: true }, weightAskedWithHeight: false,
    labValues: [lab('a', 'egfr'), lab('b', 'ferritin'), lab('c', 'hba1c', true)], deviceHealth: false, screeningNote: false,
  };
  const topicsOf = (...args: Parameters<typeof planTopics>) => {
    const layout = planTopics(...args);
    if (layout.kind !== 'topics') throw new Error('expected topics');
    return layout.topics;
  };

  it('places each medicine in the topic whose form section asks it, the screening one in Cancer screening, and leaves the lab eGFR and core rows out of the lab rows', () => {
    const topics = topicsOf(planSections([s('med-statin', 'attention', 'medication'), s('weight-glp1', 'urgent', 'medication'), s('screening-lung-overdue', 'attention', 'screening')]), forms, facts);
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

  it('with no derived values and the weight asked beside the height: waist leads, no non-HDL or eGFR row, the lab eGFR stays in Blood tests', () => {
    const topics = topicsOf([], { medications: [], screenings: [] }, { ...facts, derived: { whtr: false, nonHdl: false, egfr: false }, weightAskedWithHeight: true, labValues: [lab('a', 'egfr')] });
    expect(topics.map((t) => [t.topic, t.rows.map(rowName)])).toEqual([
      ['weight', ['waist', 'hba1c']], ['bloodPressure', ['bp', 'creatinine']],
      ['cholesterol', ['apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa']],
      ['bloodTests', ['hba1c', 'creatinine', 'apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa', 'lab:egfr']],
      ['supplements', []],
    ]);
  });

  it.each([
    ['no card, no device source', [], false, []],
    ['a sleep card, no device source', [s('sleep', 'info', 'sleep')], false, ['sleep']],
    ['a device source, no card', [], true, ['sleep', 'fitness']],
  ] as const)('Sleep and Fitness (ruling 1): %s', (_, suggestions, deviceHealth, shown) => {
    const topics = topicsOf(planSections([...suggestions]), { medications: [], screenings: [] }, { ...facts, deviceHealth });
    expect(topics.map((t) => t.topic).filter((t) => t === 'sleep' || t === 'fitness')).toEqual(shown);
  });

  it('a screening note (ruling 3) draws Cancer screening with its questions and nothing placed: the suggestion is a card', () => {
    const topics = topicsOf(planSections([s('screening-lung-overdue', 'attention', 'screening')]), forms, { ...facts, screeningNote: true });
    const screening = topics.find((t) => t.topic === 'screening')!;
    expect([screening.questions, screening.screenings, screening.cards.flatMap((c) => c.suggestions.map((x) => x.id))]).toEqual(['cancer-screening', [], ['screening-lung-overdue']]);
    expect(topicsOf([], { medications: [], screenings: [] }, { ...facts, screeningNote: true }).map((t) => t.topic)).toContain('screening');
  });

  it('before the form is full (ruling 9): no topics, every card in Other, the medicine one too', () => {
    const layout = planTopics(planSections([s('med-statin', 'attention', 'medication'), s('sleep', 'info', 'sleep')]), forms, { ...facts, formFull: false });
    expect(layout.kind).toBe('waiting');
    expect(layout.kind === 'waiting' && layout.other.flatMap((c) => c.suggestions.map((x) => x.id)).sort()).toEqual(['med-statin', 'sleep']);
  });

  it('before the form is full (ruling 9): an urgent card leads Other, whatever its topic', () => {
    const layout = planTopics(planSections([s('sleep', 'info', 'sleep'), s('bp-stage2', 'urgent', 'blood_pressure')]), forms, { ...facts, formFull: false });
    expect(layout.kind === 'waiting' && [ids(layout.urgent), ids(layout.other)]).toEqual([[['bp-stage2']], [['sleep']]]);
  });
});
