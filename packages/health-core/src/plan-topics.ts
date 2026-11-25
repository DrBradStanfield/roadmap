/**
 * My health as the clients draw it (US-62 AC39, lead I-4): which topics show, in
 * which order, and in each its urgent cards, its rows, its other cards and the
 * form's questions that follow, with the suggestions placed on those questions.
 * One rule, so the web, the iPhone and a later client only draw. Where the clients
 * differed the owner ruled (2026-11-25): what a device has is an input fact, never
 * a platform; the engine's own functions (`labTestSeries`, `medicationForm`,
 * `screeningForm`) decide what they decide. The cards come from `topicSections`
 * unchanged. Layout only: it changes no suggestion and no word.
 */
import type { FormSection } from './input-form';
import { labTestSeries, type LabValueRow } from './lab-series';
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
  /** A lab test beyond the core ones, by its series key (`labTestSeries`). */
  | { kind: 'lab'; seriesKey: string }
  /** The device health source's rows for Sleep or Fitness (Apple Health on the iPhone). */
  | { kind: 'deviceHealth' };

/** The form's questions a topic draws after its rows; Cancer screening's stand as its rows. */
export type TopicQuestions = 'weight-medications' | 'lipid-medications' | 'cancer-screening' | 'supplements';

/** A row worked out from other rows. Its inputs' rows are always listed, so it shows when its value does. */
export type DerivedRow = 'whtr' | 'nonHdl' | 'egfr';

/** What the client knows that decides the layout: facts about the record and the device, no platform. */
export interface PlanTopicFacts {
  /** The form is drawn in full (web `fullForm`); before it nothing has a topic. */
  formFull: boolean;
  /** Which derived values exist: a waist-to-height point (`whtrSeries`), the plan's non-HDL tile,
   *  the plan's eGFR tile with its day and source. */
  derived: Readonly<Record<DerivedRow, boolean>>;
  /** Onboarding asks the weight beside the height, so the weight row waits. */
  weightAskedWithHeight: boolean;
  /** The record's lab values; the lab-test rows are `labTestSeries`' series. */
  labValues: readonly LabValueRow[];
  /** The client reads sleep and fitness from a device health source. */
  deviceHealth: boolean;
  /** The client shows a screening note (no screening question can be offered, or the forms could not be read). */
  screeningNote: boolean;
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

/** My health's two modes: topics once the form is full; before it, every card in one list, Other,
 *  its urgent cards first (`urgent`, then `other`), as the iPhone draws it (TopicPlan.swift). */
export type MyHealthLayout<S extends Suggestion = Suggestion> =
  | { kind: 'topics'; topics: PlanTopic<S>[] }
  | { kind: 'waiting'; urgent: TopicCard<S>[]; other: TopicCard<S>[]; ownershipLine?: string };

/** The core blood tests, in the grid's order (PSA is asked under prostate screening); the web's `BLOOD_ROWS`. */
const BLOOD_ROW_METRICS: readonly string[] = BLOOD_TEST_METRICS.filter((m) => m !== 'psa' && METRIC_TO_FIELD[m]);
const LIPID_ROW_METRICS = ['apob', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides', 'lpa'] as const;
/** The lab eGFR's series key: its own row, left out while the plan's eGFR row stands for it (US-73 AC7). */
const LAB_EGFR = 'egfr';

/** The medicine form's sections and the topic that draws each. */
const MEDICATION_TOPIC: Readonly<Record<string, TopicId>> = { 'weight-medications': 'weight', 'lipid-medications': 'cholesterol' };

const core = (metric: string): TopicRow => ({ kind: 'core', metric });

/** Each topic's rows (US-62 AC21). */
function topicRows(facts: PlanTopicFacts): Partial<Record<TopicId, TopicRow[]>> {
  const shows = (row: DerivedRow) => facts.derived[row];
  const egfr: TopicRow[] = shows('egfr') ? [{ kind: 'egfr' }] : [];
  // Which series, not their trends: the day only moves a trend's window.
  const labs = labTestSeries(facts.labValues, new Date(0)).map((r) => r.seriesKey)
    .filter((key) => !(shows('egfr') && key === LAB_EGFR)).map((seriesKey): TopicRow => ({ kind: 'lab', seriesKey }));
  const device: TopicRow[] = facts.deviceHealth ? [{ kind: 'deviceHealth' }] : [];
  return {
    weight: [shows('whtr') ? { kind: 'whtr' } : core('waist'), ...(facts.weightAskedWithHeight ? [] : [core('weight')]), core('hba1c')],
    sleep: device,
    fitness: device,
    bloodPressure: [{ kind: 'bp' }, core('creatinine'), ...egfr],
    cholesterol: LIPID_ROW_METRICS.flatMap((m) => (m === 'hdl' && shows('nonHdl') ? [core(m), { kind: 'nonHdl' } as const] : [core(m)])),
    bloodTests: [...BLOOD_ROW_METRICS.flatMap((m) => (m === 'creatinine' ? [core(m), ...egfr] : [core(m)])), ...labs],
  };
}

type Sections<S extends Suggestion> = ReadonlyArray<{ key: PlanSectionKey; cards: ReadonlyArray<{ category: Suggestion['category']; suggestions: S[] }>; ownershipLine?: string }>;

/**
 * My health's layout. Before the form is full: no topics, every card in Other, the
 * urgent ones apart to lead it (nothing is placed on a question, as none is drawn). Then the topics in TOPICS'
 * order, empty ones left out: a topic shows when it has a card, a row or
 * questions. Cancer screening shows for a note, any screening section or a card;
 * while a note shows nothing is placed on its questions, so those suggestions are
 * cards. A medicine suggestion sits in the topic of the `medicationForm` section
 * that asks its question.
 */
export function planTopics<S extends Suggestion>(
  sections: Sections<S>,
  forms: { medications: readonly FormSection[]; screenings: readonly FormSection[] },
  facts: PlanTopicFacts,
): MyHealthLayout<S> {
  if (!facts.formFull) {
    const layout = topicSections(sections, { medications: [], screenings: [] });
    const ownershipLine = layout.sections.find((section) => section.ownershipLine)?.ownershipLine;
    const all = layout.sections.flatMap((section) => section.cards);
    return { kind: 'waiting', urgent: all.filter((c) => c.priority === 'urgent'), other: all.filter((c) => c.priority !== 'urgent'), ...(ownershipLine ? { ownershipLine } : null) };
  }
  const layout = topicSections(sections, facts.screeningNote ? { ...forms, screenings: [] } : forms);
  const rows = topicRows(facts);
  const askedBy = new Map<string, TopicId>();
  for (const section of forms.medications) {
    const topic = MEDICATION_TOPIC[section.id];
    if (!topic) continue;
    for (const field of section.groups.flatMap((g) => g.fields)) askedBy.set(field.kind === 'measurement' ? field.metric : field.key, topic);
  }
  // A medicine section's questions where medicationForm holds it; the screening ones for a note or a section.
  const questions: Partial<Record<TopicId, TopicQuestions>> = { supplements: 'supplements' };
  for (const section of forms.medications) {
    const topic = MEDICATION_TOPIC[section.id];
    if (topic) questions[topic] = section.id as TopicQuestions;
  }
  if (facts.screeningNote || forms.screenings.length > 0) questions.screening = 'cancer-screening';
  const topics = TOPICS.flatMap(({ topic, title }): PlanTopic<S>[] => {
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
  return { kind: 'topics', topics };
}
