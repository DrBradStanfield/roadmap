/**
 * US-62 AC39 (lead I-4). A characterisation, not a rule: what the web's My health draws today
 * (MyHealth.tsx:140-157 rows, :177-228 topics, transcribed when planTopics was written) against
 * planTopics after the owner's rulings (2026-11-25). Each remaining difference is named and
 * expected, so the web screen PR knows what will visibly change; any other difference fails.
 * Then examples of each ruling.
 */
import { describe, expect, it } from 'vitest';
import { BLOOD_TEST_METRICS, METRIC_TO_FIELD } from './mappings';
import { labSeriesRows } from './lab-series';
import { planSections, TOPICS, type TopicId } from './plan-sections';
import { planTopics, type PlanTopicFacts } from './plan-topics';
import { choice, genWorld, layoutOf, rowName, run, section, SEEDS, type World } from './plan-topics.fixtures';
import type { Suggestion } from './types';

/** The web today, for a full form: its rows and which topics it draws. It has no device source and no
 *  screening note; it draws Cancer screening when the screening form draws (`screeningForm`, pinned by
 *  InputPanel.input-form-parity.test.tsx) or a card. Its lab rows: `labSeriesRows` of the store's active
 *  non-core rows (roadmap-store.ts:274). */
function webToday(w: World, cardTopics: Set<TopicId>): Array<[TopicId, string[]]> {
  const f = w.facts;
  const egfr = f.derived.egfr ? ['egfr'] : [];
  const blood = BLOOD_TEST_METRICS.filter((m) => m !== 'psa' && METRIC_TO_FIELD[m]);
  const labs = labSeriesRows(f.labValues.filter((r) => r.status === 'active' && !('core' in r && r.core === true))).map((r) => r.seriesKey);
  const rows: Partial<Record<TopicId, string[]>> = {
    weight: [f.derived.whtr ? 'whtr' : 'waist', ...(f.weightAskedWithHeight ? [] : ['weight']), 'hba1c'],
    bloodPressure: ['bp', 'creatinine', ...egfr],
    cholesterol: ['apob', 'ldl', 'total_cholesterol', 'hdl', ...(f.derived.nonHdl ? ['nonHdl'] : []), 'triglycerides', 'lpa'],
    bloodTests: [...blood.flatMap((m) => (m === 'creatinine' ? [m, ...egfr] : [m])), ...(f.derived.egfr ? labs.filter((k) => k !== 'egfr') : labs).map((k) => `lab:${k}`)],
  };
  const always: TopicId[] = ['bloodTests', 'supplements'];
  return TOPICS.map(({ topic }) => topic)
    .filter((t) => always.includes(t) || rows[t] || (t === 'screening' && w.forms.screenings.length > 0) || cardTopics.has(t))
    .map((t) => [t, rows[t] ?? []]);
}

/** A world as the web would describe it under the rulings: no device health source, and the note
 *  wherever the screening form is empty (the engine's rule, my-data-forms.ts:228). */
const asWeb = (w: World): World => ({ ...w, facts: { ...w.facts, deviceHealth: false, screeningNote: w.forms.screenings.length === 0 } });

describe("the web's screen against planTopics: the expected differences (US-62 AC39)", () => {
  it('D3: Cancer screening is added where the web draws none (no screening section, no screening card), with its note; D9: before the form is full the web draws no topics, the rule hands it every card in Other; nothing else differs', () => {
    let added = 0, waiting = 0;
    for (const seed of SEEDS) {
      const w = asWeb(genWorld(seed));
      const layout = layoutOf(w);
      if (!w.facts.formFull) {
        expect(layout.kind, `seed ${seed}`).toBe('waiting');
        waiting++;
        continue;
      }
      const topics = run(w);
      const cardTopics = new Set(topics.filter((t) => t.urgent.length + t.cards.length > 0).map((t) => t.topic));
      const web = webToday(w, cardTopics);
      const rule = topics.map((t): [TopicId, string[]] => [t.topic, t.rows.map(rowName)]);
      const extra = rule.filter(([t]) => !web.some(([u]) => u === t));
      const webHasScreening = web.some(([t]) => t === 'screening');
      expect(extra, `seed ${seed}`).toEqual(webHasScreening ? [] : [['screening', []]]);
      expect(rule.filter(([t]) => t !== 'screening' || webHasScreening), `seed ${seed}`).toEqual(web);
      if (!webHasScreening) added++;
    }
    // Both differences are reached.
    expect(added).toBeGreaterThan(0);
    expect(waiting).toBeGreaterThan(0);
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
});
