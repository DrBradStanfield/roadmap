// US-25 AC2: the plan's layout is one function, shared by the web's results
// panel and the iOS app, so both show the same cards in the same order.
import { describe, expect, it } from 'vitest';
import { LEADING_IDS, planSections } from './plan-sections';
import { generateSuggestions } from './suggestions';
import type { Suggestion } from './types';

const s = (id: string, priority: Suggestion['priority'], category: Suggestion['category']): Suggestion =>
  ({ id, priority, category, title: id, description: '' });

/** Section titles, each with its cards as id lists. */
const layout = (suggestions: Suggestion[]) =>
  planSections(suggestions).map((section) => [section.title, section.cards.map((card) => card.suggestions.map((x) => x.id))]);

describe('planSections (US-25 AC2)', () => {
  it('lays out the sample record the way the web did before the extraction', () => {
    // The sample plan's Next Steps and Foundation, in engine order.
    const suggestions = [
      s('weight-med-glp1', 'attention', 'medication'),
      s('measure-waist', 'attention', 'general'),
      s('hba1c-normal', 'info', 'bloodwork'),
      s('bp-stage1', 'attention', 'blood_pressure'),
      s('med-ezetimibe', 'attention', 'medication'),
      s('screening-colorectal', 'attention', 'screening'),
      s('screening-breast', 'info', 'screening'),
      s('screening-cervical', 'attention', 'screening'),
    ];

    expect(layout(suggestions)).toEqual([
      ['Next Steps', [['measure-waist'], ['screening-colorectal', 'screening-cervical'], ['weight-med-glp1', 'med-ezetimibe'], ['bp-stage1']]],
      ['Foundation', [['screening-breast'], ['hba1c-normal']]],
    ]);
  });

  it('leads Next Steps with the waist prompt, then the blood pressure prompt (US-07 AC10)', () => {
    const suggestions = [
      s('screening-colorectal', 'attention', 'screening'),
      s('screening-cervical', 'attention', 'screening'),
      s('measure-bp', 'attention', 'blood_pressure'),
      s('weight-med-glp1', 'attention', 'medication'),
      s('measure-waist', 'attention', 'general'),
    ];
    expect(layout(suggestions)).toEqual([
      ['Next Steps', [['measure-waist'], ['measure-bp'], ['screening-colorectal', 'screening-cervical'], ['weight-med-glp1']]],
    ]);
    // With a waist on record, the blood pressure prompt leads.
    expect(layout(suggestions.filter((x) => x.id !== 'measure-waist'))[0][1][0]).toEqual(['measure-bp']);
  });

  it('orders the five sections and leaves empty ones out', () => {
    expect(layout([
      s('sun', 'info', 'skin'),
      s('creatine', 'info', 'supplements'),
      s('protein', 'info', 'nutrition'),
      s('trig', 'urgent', 'bloodwork'),
    ]).map(([title]) => title)).toEqual(['Requires Attention', 'Foundation', 'Skin Health', 'Supplements']);
  });

  it('groups only nutrition, screening, bloodwork and medication, and only two or more', () => {
    expect(layout([
      s('cardio', 'info', 'exercise'),
      s('lift', 'info', 'exercise'),
      s('protein', 'info', 'nutrition'),
      s('sodium', 'info', 'nutrition'),
      s('sleep', 'info', 'sleep'),
      s('bp', 'info', 'blood_pressure'),
      s('hba1c', 'info', 'bloodwork'),
    ])).toEqual([
      ['Foundation', [['protein', 'sodium'], ['cardio'], ['lift'], ['sleep'], ['hba1c'], ['bp']]],
    ]);
  });

  it('gives a grouped card its highest priority', () => {
    const [section] = planSections([s('a', 'info', 'screening'), s('b', 'info', 'screening')]);
    expect(section.cards[0].priority).toBe('info');

    const [urgent, attention] = planSections([s('c', 'urgent', 'bloodwork'), s('d', 'attention', 'bloodwork'), s('e', 'attention', 'bloodwork')]);
    expect(urgent.cards[0].priority).toBe('urgent');
    expect(attention.cards[0]).toMatchObject({ priority: 'attention', category: 'bloodwork' });
  });

  it('puts unknown categories last, ungrouped, in arrival order', () => {
    expect(layout([
      s('x2', 'info', 'mystery' as Suggestion['category']),
      s('x1', 'info', 'mystery' as Suggestion['category']),
      s('protein', 'info', 'nutrition'),
    ])).toEqual([['Foundation', [['protein'], ['x2'], ['x1']]]]);
  });

  it('keeps skin and supplements flat and in engine order, and shows a raised one in its priority section too', () => {
    expect(layout([
      s('retinoid', 'info', 'skin'),
      s('sunscreen', 'attention', 'skin'),
      s('omega', 'info', 'supplements'),
      s('creatine', 'info', 'supplements'),
    ])).toEqual([
      ['Next Steps', [['sunscreen']]],
      ['Skin Health', [['retinoid'], ['sunscreen']]],
      ['Supplements', [['omega'], ['creatine']]],
    ]);
  });
});

describe('US-07 AC10: one source for the leading prompts', () => {
  it('the engine emits the leading ids first, in their order', () => {
    const emitted = generateSuggestions({ heightCm: 178 }, { heightCm: 178, age: 40, suggestions: [] }).map((x) => x.id);
    expect(emitted.slice(0, LEADING_IDS.length)).toEqual([...LEADING_IDS]);
  });
});
