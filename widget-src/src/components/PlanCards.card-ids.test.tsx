// @vitest-environment jsdom
/**
 * US-09 AC7d, US-62 AC40: every card on My health has its own DOM id, its place on the page. The ids
 * come from usePlanView's numbering of each topic's cards, urgent ones apart, as planTopics splits
 * them; a card without one is a bug: development throws, production falls back to its place in the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import type { HealthResults, Suggestion } from '@roadmap/health-core/types';
import { cardIdAt, PlanCardList } from './PlanCards';
import { usePlanView } from './ResultsPanel';
import { NO_PLAN } from '../testing/my-health-props';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

const s = (id: string, category: Suggestion['category'], priority: Suggestion['priority']): Suggestion => ({ id, category, priority, title: id, description: '' });
const card = (x: Suggestion) => ({ category: x.category, priority: x.priority, suggestions: [x] });

describe('US-09 AC7d: a card DOM id', () => {
  it('is the id at its place in the list', () => {
    expect([0, 1].map(i => cardIdAt(['mh-card-4', 'mh-card-7'], i))).toEqual(['mh-card-4', 'mh-card-7']);
  });

  it('throws in development when the list has no id for a card', () => {
    expect(() => cardIdAt(['mh-card-0'], 1)).toThrow('no DOM id for card 1 of 1');
    expect(() => render(<PlanCardList cards={[card(s('sleep', 'sleep', 'info'))]} ids={[]} plan={NO_PLAN}/>)).toThrow();
  });

  it('falls back to its place in the list in production, so the card still has an id', () => {
    vi.stubEnv('DEV', false);
    const { container } = render(<PlanCardList cards={[card(s('sleep', 'sleep', 'info')), card(s('exercise', 'exercise', 'info'))]} ids={['mh-card-3']} plan={NO_PLAN}/>);
    expect([...container.querySelectorAll('.mh-card')].map(el => el.id)).toEqual(['mh-card-3', 'mh-card-at-1']);
  });

  it('is unique per card when the same suggestion shows in two topics and at two priorities', () => {
    const suggestions = [s('fiber', 'nutrition', 'info'), s('fiber', 'nutrition', 'urgent'), s('fiber', 'sleep', 'attention'), s('bp-stage2', 'blood_pressure', 'urgent')];
    const forms = { medications: [], screenings: [] };
    const { result } = renderHook(() => usePlanView({ results: { suggestions, knownMinor: false } as unknown as HealthResults, shownErase: '', isValid: true, tiles: [], forms, cardsShown: true }));
    const { cardIds, urgent } = result.current;
    expect(Object.fromEntries(cardIds)).toEqual({
      weight: { urgent: ['mh-card-0'], others: ['mh-card-1'] },
      sleep: { urgent: [], others: ['mh-card-2'] },
      bloodPressure: { urgent: ['mh-card-3'], others: [] },
    });
    // The banner names the first urgent card in topic order, by its own id.
    expect(urgent).toEqual({ title: 'fiber', cardId: 'mh-card-0' });
  });
});
