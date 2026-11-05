// US-73 AC3, AC4: the plan's cards by topic for the iPhone's My health. Every suggestion is drawn
// once, as a card or in a row (a medicine question, a screening group); an urgent one as both.
import { describe, expect, it } from 'vitest';
import { planSections, questionKeys, topicOf, topicSections, type TopicLayout } from './plan-sections';
import type { FormSection } from './input-form';
import type { Suggestion } from './types';

const s = (id: string, priority: Suggestion['priority'], category: Suggestion['category']): Suggestion =>
  ({ id, priority, category, title: id, description: '' });

const choice = (key: string) => ({ kind: 'choice' as const, key, label: key, options: [], value: '' });
const medications: FormSection[] = [
  { id: 'cholesterol', title: '', intro: '', groups: [{ id: 'statin', title: '', notes: [], fields: ['statin', 'statin_dose', 'ezetimibe', 'statin_escalation'].map(choice) }] },
  { id: 'weight', title: '', intro: '', groups: [{ id: 'glp1', title: '', notes: [], fields: ['glp1', 'glp1_dose'].map(choice) }] },
];
const screenings: FormSection[] = [{
  id: 'cancer-screening', title: '', intro: '', groups: [
    { id: 'colorectal', title: 'Colorectal', notes: [], fields: [choice('colorectal_method')] },
    { id: 'cervical', title: 'Cervical', notes: ['Stopped'], fields: [] },
  ],
}];
const forms = { medications, screenings };

/** Topic, then each card's suggestion ids. */
const cards = (layout: TopicLayout) => layout.sections.map((section) => [section.topic, section.cards.map((card) => card.suggestions.map((x) => x.id))]);

/** Every place a suggestion is drawn: `card:<topic>`, `medicine:<key>` or `screening:<group>`. */
function placements(layout: TopicLayout): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (id: string, where: string) => out.set(id, [...(out.get(id) ?? []), where]);
  for (const section of layout.sections) for (const card of section.cards) for (const x of card.suggestions) put(x.id, `card:${section.topic}`);
  for (const row of layout.medicines) for (const x of row.suggestions) put(x.id, `medicine:${row.key}`);
  for (const row of layout.screenings) for (const x of row.suggestions) put(x.id, `screening:${row.group}`);
  return out;
}

describe('topicOf: routing per id family (US-73 AC3)', () => {
  it.each([
    ['low-salt', 'nutrition', 'bloodPressure'], ['high-potassium', 'nutrition', 'bloodPressure'],
    ['lipid-diet', 'nutrition', 'cholesterol'], ['trig-nutrition', 'nutrition', 'cholesterol'],
    ['protein-target', 'nutrition', 'weight'], ['fiber', 'nutrition', 'weight'], ['reduce-alcohol', 'nutrition', 'weight'],
    ['hba1c-prediabetic', 'bloodwork', 'weight'],
    ['apob-high', 'bloodwork', 'cholesterol'], ['ldl-very-high', 'bloodwork', 'cholesterol'], ['non-hdl-high', 'bloodwork', 'cholesterol'],
    ['lpa-elevated', 'bloodwork', 'cholesterol'], ['total-chol-high', 'bloodwork', 'cholesterol'], ['hdl-low', 'bloodwork', 'cholesterol'],
    ['trig-very-high', 'bloodwork', 'cholesterol'], ['psa-raised', 'bloodwork', 'bloodTests'],
    ['weight-glp1', 'medication', 'weight'], ['weight-med-sglt2i', 'medication', 'weight'], ['med-statin', 'medication', 'cholesterol'],
    ['measure-waist', 'general', 'weight'], ['adults-only', 'general', 'weight'],
    ['exercise', 'exercise', 'fitness'], ['sleep', 'sleep', 'sleep'], ['bp-stage2', 'blood_pressure', 'bloodPressure'],
    ['screening-lung-overdue', 'screening', 'screening'], ['skin-sunscreen', 'skin', 'skin'], ['supplement-omega3', 'supplements', 'supplements'],
    ['anything', 'a-newer-category', 'other'],
  ])('%s (%s) goes under %s', (id, category, topic) => {
    expect(topicOf({ id, category: category as Suggestion['category'] })).toBe(topic);
  });

  it('a medicine step names its own question, then the escalation, then the drug', () => {
    expect(questionKeys('med-statin-dose')).toEqual(['statin_dose', 'statin_escalation', 'statin']);
    expect(questionKeys('med-statin-increase')).toEqual(['statin_increase', 'statin_escalation', 'statin']);
    expect(questionKeys('weight-med-glp1-dose')).toEqual(['glp1_dose', 'glp1_escalation', 'glp1']);
    expect(questionKeys('weight-glp1')).toEqual(['glp1', 'glp1_escalation', 'glp1']);
    expect(questionKeys('med-bempedoic-acid')).toEqual(['bempedoic_acid', 'bempedoic_escalation', 'bempedoic']);
  });
});

describe('topicSections (US-73 AC3, AC4)', () => {
  const plan = [
    s('fiber', 'info', 'nutrition'), s('protein-target', 'info', 'nutrition'), s('reduce-alcohol', 'attention', 'nutrition'),
    s('hba1c-prediabetic', 'attention', 'bloodwork'), s('measure-waist', 'attention', 'general'),
    s('ldl-high', 'attention', 'bloodwork'), s('lipid-diet', 'attention', 'nutrition'),
    s('med-statin-dose', 'attention', 'medication'), s('med-pcsk9i', 'attention', 'medication'), s('weight-glp1', 'urgent', 'medication'),
    s('screening-colorectal-overdue', 'attention', 'screening'), s('screening-cervical', 'urgent', 'screening'),
    s('screening-lung', 'urgent', 'screening'),
    s('bp-crisis', 'urgent', 'blood_pressure'), s('low-salt', 'info', 'nutrition'),
    s('skin-sunscreen', 'attention', 'skin'), s('supplement-omega3', 'info', 'supplements'),
    s('new-thing', 'info', 'nutrition'), s('future', 'info', 'a-newer-category' as Suggestion['category']),
  ];
  const layout = topicSections(planSections(plan), forms);

  it('places every suggestion: a card, its medicine question or its screening group; an urgent one also as a card', () => {
    const where = placements(layout);
    expect(Object.fromEntries(where)).toEqual({
      'fiber': ['card:weight'], 'protein-target': ['card:weight'], 'reduce-alcohol': ['card:weight'], 'hba1c-prediabetic': ['card:weight'],
      'measure-waist': ['card:weight'], 'new-thing': ['card:weight'],
      'ldl-high': ['card:cholesterol'], 'lipid-diet': ['card:cholesterol'],
      'med-statin-dose': ['medicine:statin_dose'],
      // No pcsk9i question in this form: a card, never dropped.
      'med-pcsk9i': ['card:cholesterol'],
      'weight-glp1': ['card:weight', 'medicine:glp1'],
      'screening-colorectal-overdue': ['screening:colorectal'],
      // Cervical's group asks nothing and lung's is not in the form: cards.
      'screening-cervical': ['card:screening'], 'screening-lung': ['card:screening'],
      'bp-crisis': ['card:bloodPressure'], 'low-salt': ['card:bloodPressure'],
      'skin-sunscreen': ['card:skin'], 'supplement-omega3': ['card:supplements'],
      'future': ['card:other'],
    });
    for (const x of plan) expect(where.get(x.id), x.id).toHaveLength(x.priority === 'urgent' && x.id === 'weight-glp1' ? 2 : 1);
  });

  it('lists the topics in the tab\'s order, empty ones left out', () => {
    expect(layout.sections.map((section) => [section.topic, section.title])).toEqual([
      ['weight', 'Weight & diabetes'], ['bloodPressure', 'Blood pressure'], ['cholesterol', 'Cholesterol'],
      ['screening', 'Cancer screening'], ['skin', 'Skin'], ['supplements', 'Supplements'], ['other', 'Other'],
    ]);
  });

  it('orders a topic urgent, attention, info, a result before advice within a level, fibre under protein', () => {
    expect(cards(layout).find(([topic]) => topic === 'weight')![1]).toEqual([
      ['weight-glp1'],
      ['hba1c-prediabetic'],
      ['measure-waist'],
      ['reduce-alcohol'],
      ['protein-target', 'fiber', 'new-thing'],
    ]);
    expect(cards(layout).find(([topic]) => topic === 'bloodPressure')![1]).toEqual([['bp-crisis'], ['low-salt']]);
  });

  it('badges a split card by its own suggestions', () => {
    const weight = layout.sections.find((section) => section.topic === 'weight')!;
    expect(weight.cards.map((card) => card.priority)).toEqual(['urgent', 'attention', 'attention', 'attention', 'info']);
  });

  it('a fibre card of its own moves under the protein target\'s card', () => {
    const own = topicSections(planSections([
      s('protein-target', 'attention', 'nutrition'), s('measure-waist', 'info', 'general'), s('hba1c-normal', 'info', 'bloodwork'), s('fiber', 'info', 'nutrition'),
    ]), forms);
    expect(cards(own)).toEqual([['weight', [['protein-target'], ['fiber'], ['hba1c-normal'], ['measure-waist']]]]);
  });

  it('fibre stays where it sorts when there is no protein target', () => {
    const alone = topicSections(planSections([s('fiber', 'info', 'nutrition'), s('exercise', 'info', 'exercise'), s('sleep', 'info', 'sleep')]), forms);
    expect(cards(alone)).toEqual([['weight', [['fiber']]], ['sleep', [['sleep']]], ['fitness', [['exercise']]]]);
  });

  it('draws a skin or supplement suggestion raised to attention once, from its own section', () => {
    const raised = topicSections(planSections([s('skin-sunscreen', 'urgent', 'skin'), s('supplement-tmg', 'attention', 'supplements')]), forms);
    expect(Object.fromEntries(placements(raised))).toEqual({ 'skin-sunscreen': ['card:skin'], 'supplement-tmg': ['card:supplements'] });
  });

  it('keeps the US overlay\'s ownership line on Supplements (US-61 AC7)', () => {
    const sections = planSections([s('supplement-omega3', 'info', 'supplements')]).map((section) => ({ ...section, ownershipLine: 'Owned.' }));
    expect(topicSections(sections, forms).sections[0]).toMatchObject({ topic: 'supplements', ownershipLine: 'Owned.' });
  });

  it('with no questions asked every suggestion is a card', () => {
    const none = topicSections(planSections(plan), { medications: [], screenings: [] });
    expect(none.medicines).toEqual([]);
    expect(none.screenings).toEqual([]);
    expect([...placements(none).values()].every((places) => places.length === 1 && places[0].startsWith('card:'))).toBe(true);
  });
});
