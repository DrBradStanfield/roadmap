/**
 * US-41 AC5 — the lexical ranker's recall over the router fixtures, offline.
 *
 * The floors sit a little under the numbers measured on 2026-09-29, so a
 * ranker change that loses recall fails here instead of shipping. The fixtures
 * move (chat-health edits them weekly), which is what the margin absorbs.
 */
import { describe, it, expect } from 'vitest';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { evaluate, half, loadFixtures, recallFixtures } from './search-knowledge-eval';
import { BEST, VARIANTS } from './search-knowledge';

// Measured 2026-09-29 on 254 fixtures, abbreviations on: top-3 203 (79.9%),
// top-8 220 (86.6%). Floors sit about two points under, five fixtures of drift.
const FLOOR_TOP3 = 0.78;
const FLOOR_TOP8 = 0.84;

describe('US-41 AC5 — recall floor over the router fixtures', () => {
  it('scores only fixtures that name at least one expected handle', () => {
    const picked = recallFixtures([
      { query: 'a', expected: ['x'] },
      { query: 'b', expected: [] },
      { query: 'c', must_not_route: ['y'] },
      { query: 'd', answer_handles: ['z'] },
    ]);
    expect(picked.map((f) => f.query)).toEqual(['a']);
  });

  it('counts top-1, top-3 and top-8 hits against any expected handle', () => {
    const entries = [
      { handle: 'iron', title: 'Iron', summary: 'ferritin iron' },
      { handle: 'fish', title: 'Fish oil', summary: 'omega-3 fish oil' },
    ];
    const result = evaluate(
      [{ query: 'ferritin', expected: ['iron'] }, { query: 'fish oil', expected: ['iron'] }],
      entries,
      BEST,
    );
    expect(result).toMatchObject({ n: 2, top1: 1, top3: 1, top8: 1 });
  });

  it('splits fixtures into even and odd halves by index', () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((query) => ({ query, expected: ['x'] }));
    expect(half(all, 'even').map((f) => f.query)).toEqual(['a', 'c', 'e']);
    expect(half(all, 'odd').map((f) => f.query)).toEqual(['b', 'd']);
  });

  it(`keeps the best variant at or above top-3 ${FLOOR_TOP3} and top-8 ${FLOOR_TOP8}`, () => {
    const fixtures = recallFixtures(loadFixtures());
    expect(fixtures.length).toBeGreaterThan(200);
    const result = evaluate(fixtures, loadBlogIndex(), BEST);
    expect(result.top3 / result.n).toBeGreaterThanOrEqual(FLOOR_TOP3);
    expect(result.top8 / result.n).toBeGreaterThanOrEqual(FLOOR_TOP8);
  });

  it('the best variant is one of the named variants and beats summary alone at top-3', () => {
    expect(Object.values(VARIANTS)).toContain(BEST);
    const fixtures = recallFixtures(loadFixtures());
    const entries = loadBlogIndex();
    expect(evaluate(fixtures, entries, BEST).top3).toBeGreaterThan(evaluate(fixtures, entries, VARIANTS.summary).top3);
  });
});
