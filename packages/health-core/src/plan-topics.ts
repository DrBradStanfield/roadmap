/**
 * My health as the clients draw it (US-62 AC39, lead I-4): which topics show, in
 * which order, and in each its urgent cards, its rows, its other cards and the
 * form's questions that follow, with the suggestions placed on those questions.
 * One rule, so the web, the iPhone and a later client only draw. It encodes the
 * web's My health (MyHealth.tsx) as it is today; the cards come from
 * `topicSections` unchanged. Layout only: it changes no suggestion and no word.
 */
import type { FormSection } from './input-form';
import { BLOOD_TEST_METRICS, METRIC_TO_FIELD } from './mappings';
import { TOPICS, topicSections, type PlanSectionKey, type TopicCard, type TopicId } from './plan-sections';
import type { Suggestion } from './types';

/** A row a topic draws. The client draws its value; this names which row, by key. */
export type TopicRow =
  | { kind: 'core'; metric: string }
  | { kind: 'bp' }
  /** Waist-to-height (`whtrSeries`), opening the waist's page. */
  | { kind: 'whtr' }
  /** Non-HDL (the plan's tile), opening total cholesterol's page. */
  | { kind: 'nonHdl' }
  /** The plan's one eGFR row (US-73 AC7). */
  | { kind: 'egfr' }
  /** A lab test beyond the core ones, by its series key (`labSeriesRows`). */
  | { kind: 'lab'; seriesKey: string };

/** The form's questions a topic draws after its rows; Cancer screening's stand as its rows. */
export type TopicQuestions = 'weight-medications' | 'lipid-medications' | 'cancer-screening' | 'supplements';

/** What the clients already know that decides the rows. */
export interface TopicRowFacts {
  /** A waist-to-height point exists (`whtrSeries`); else the waist row leads. */
  whtr: boolean;
  /** The weight row shows (the web leaves it out while the weight is asked beside the height). */
  weight: boolean;
  /** The plan's eGFR row stands: an eGFR tile and its day and source. */
  egfr: boolean;
  /** The plan works out non-HDL (its tile). */
  nonHdl: boolean;
  /** The lab tests beyond the core ones, by series key, in `labSeriesRows` order. */
  labs: readonly string[];
  /** The form draws a cancer screening or bone density question. */
  screeningAsked: boolean;
}

export interface PlanTopic<S extends Suggestion = Suggestion> {
  topic: TopicId;
  title: string;
  /** The topic's urgent cards, over its rows. */
  urgent: TopicCard<S>[];
  rows: TopicRow[];
  /** The rest of its cards, under its rows. */
  cards: TopicCard<S>[];
  /** US-61 AC7: under the supplement cards. */
  ownershipLine?: string;
  questions: TopicQuestions | null;
  /** Suggestions on this topic's medicine questions (by key) or screening groups (by id), in engine order. */
  medicines: Array<{ key: string; suggestions: S[] }>;
  screenings: Array<{ group: string; suggestions: S[] }>;
}

/** The core blood tests, in the grid's order (PSA is asked under prostate screening); the web's `BLOOD_ROWS`. */
export const BLOOD_ROW_METRICS: readonly string[] = BLOOD_TEST_METRICS.filter((m) => m !== 'psa' && METRIC_TO_FIELD[m]);
const LIPID_ROW_METRICS = ['apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa'] as const;
/** The lab eGFR's series key: its own row, left out while the plan's eGFR row stands for it (US-73 AC7). */
const LAB_EGFR = 'egfr';

/** The medicine form's sections and the topic that draws each. */
const MEDICATION_TOPIC: Readonly<Record<string, TopicId>> = { 'weight-medications': 'weight', 'lipid-medications': 'cholesterol' };

const core = (metric: string): TopicRow => ({ kind: 'core', metric });

/** Each topic's rows (US-62 AC21), as MyHealth.tsx lists them. */
export function topicRows(facts: TopicRowFacts): Partial<Record<TopicId, TopicRow[]>> {
  const egfr: TopicRow[] = facts.egfr ? [{ kind: 'egfr' }] : [];
  const labs = facts.labs.filter((key) => !(facts.egfr && key === LAB_EGFR)).map((seriesKey): TopicRow => ({ kind: 'lab', seriesKey }));
  return {
    weight: [facts.whtr ? { kind: 'whtr' } : core('waist'), ...(facts.weight ? [core('weight')] : []), core('hba1c')],
    bloodPressure: [{ kind: 'bp' }, core('creatinine'), ...egfr],
    cholesterol: LIPID_ROW_METRICS.flatMap((m) => (m === 'hdl' && facts.nonHdl ? [core(m), { kind: 'nonHdl' } as const] : [core(m)])),
    bloodTests: [...BLOOD_ROW_METRICS.flatMap((m) => (m === 'creatinine' ? [core(m), ...egfr] : [core(m)])), ...labs],
  };
}

/**
 * My health's topics in TOPICS' order, empty ones left out: a topic shows when
 * it has a card, a row or questions (Blood tests always has rows, Supplements
 * always its list).
 * Cards come from `topicSections`, urgent ones apart; a medicine suggestion sits
 * in the topic of the form section that asks its question, a screening one in
 * Cancer screening. Call it once the form is drawn in full (web `fullForm`).
 */
export function planTopics<S extends Suggestion>(
  sections: ReadonlyArray<{ key: PlanSectionKey; cards: ReadonlyArray<{ category: Suggestion['category']; suggestions: S[] }>; ownershipLine?: string }>,
  forms: { medications: readonly FormSection[]; screenings: readonly FormSection[] },
  facts: TopicRowFacts,
): PlanTopic<S>[] {
  const layout = topicSections(sections, forms);
  const rows = topicRows(facts);
  const askedBy = new Map<string, TopicId>();
  for (const section of forms.medications) {
    const topic = MEDICATION_TOPIC[section.id];
    if (!topic) continue;
    for (const field of section.groups.flatMap((g) => g.fields)) askedBy.set(field.kind === 'measurement' ? field.metric : field.key, topic);
  }
  // A medicine section's questions where the form holds it (medicationForm); the screening ones where the form draws one.
  const questions: Partial<Record<TopicId, TopicQuestions>> = { supplements: 'supplements' };
  for (const section of forms.medications) {
    const topic = MEDICATION_TOPIC[section.id];
    if (topic) questions[topic] = section.id as TopicQuestions;
  }
  if (facts.screeningAsked) questions.screening = 'cancer-screening';
  return TOPICS.flatMap(({ topic, title }): PlanTopic<S>[] => {
    const cards = layout.sections.find((section) => section.topic === topic);
    const all = cards?.cards ?? [];
    const out: PlanTopic<S> = {
      topic, title,
      urgent: all.filter((c) => c.priority === 'urgent'),
      rows: rows[topic] ?? [],
      cards: all.filter((c) => c.priority !== 'urgent'),
      ...(cards?.ownershipLine ? { ownershipLine: cards.ownershipLine } : null),
      questions: questions[topic] ?? null,
      medicines: layout.medicines.filter(({ key }) => askedBy.get(key) === topic),
      screenings: topic === 'screening' ? layout.screenings : [],
    };
    return all.length > 0 || out.rows.length > 0 || out.questions !== null ? [out] : [];
  });
}
