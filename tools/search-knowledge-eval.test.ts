/**
 * US-41 AC5 — the lexical ranker's recall over the router fixtures, offline.
 *
 * The floor reads a frozen snapshot of the fixtures
 * (tools/fixtures/search-knowledge-fixtures.json), not the live
 * tools/test-queries.json: the chat-health loop edits the live file weekly, and
 * its edits must never turn this suite red. The live numbers are a report
 * (`npx tsx tools/search-knowledge-eval.ts --live`), not a gate.
 */
import { describe, it, expect } from 'vitest';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { evaluate, half, loadSnapshot, recallFixtures, skipCounts, snapshotOf } from './search-knowledge-eval';
import { BEST, VARIANTS } from './search-knowledge';

// Measured 2026-09-29 on the 254-fixture snapshot: top-3 204 (80.3%), top-8
// 218 (85.8%). The floors need 199 and 214, so 5 and 4 fixtures of headroom:
// room for a neutral ranker change, not for fixture drift, which the snapshot
// removes.
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

  it('counts skipped fixtures by reason', () => {
    expect(skipCounts([
      { query: 'a', expected: ['x'] },
      { query: 'b', expected: [] },
      { query: 'c', expected: [], must_not_route: ['y'] },
      { query: 'd', expected_classification: 'MEASUREMENT' },
      { query: 'e', answer_handles: ['z'] },
    ])).toEqual({ emptyExpected: 2, classificationOnly: 1, answerOnly: 1 });
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

  it('counts a must_not_route handle in the top 8 as a violation, empty-expected fixtures included', () => {
    const entries = [
      { handle: 'iron', title: 'Iron', summary: 'ferritin iron' },
      { handle: 'warfarin', title: 'Warfarin', summary: 'warfarin iron' },
    ];
    const result = evaluate(
      [
        { query: 'iron', expected: ['iron'], must_not_route: ['warfarin'] },
        { query: 'warfarin', expected: [], must_not_route: ['warfarin'] },
        { query: 'ferritin', expected: ['iron'], must_not_route: ['warfarin'] },
      ],
      entries,
      BEST,
    );
    expect(result.violations).toBe(2);
  });

  it('splits fixtures into even and odd halves by index', () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((query) => ({ query, expected: ['x'] }));
    expect(half(all, 'even').map((f) => f.query)).toEqual(['a', 'c', 'e']);
    expect(half(all, 'odd').map((f) => f.query)).toEqual(['b', 'd']);
  });

  it('snapshots only what the eval reads: the query, its expected and forbidden handles', () => {
    const live = [
      { query: 'a', expected: ['x'], category: 'c', notes: 'n', must_mention: ['m'] },
      { query: 'b', expected: [] },
      { query: 'c', expected: [], must_not_route: ['y'] },
      { query: 'd', answer_handles: ['z'] },
    ];
    expect(snapshotOf(live)).toEqual([
      { query: 'a', expected: ['x'] },
      { query: 'c', expected: [], must_not_route: ['y'] },
    ]);
  });

  it(`keeps the best variant at or above top-3 ${FLOOR_TOP3} and top-8 ${FLOOR_TOP8}, with no forbidden handle in any top 8`, () => {
    const fixtures = loadSnapshot();
    expect(recallFixtures(fixtures)).toHaveLength(254);
    const result = evaluate(fixtures, loadBlogIndex(), BEST);
    expect(result.top3 / result.n).toBeGreaterThanOrEqual(FLOOR_TOP3);
    expect(result.top8 / result.n).toBeGreaterThanOrEqual(FLOOR_TOP8);
    expect(result.violations).toBe(0);
  });

  it('the best variant is one of the named variants and beats summary alone at top-3', () => {
    expect(Object.values(VARIANTS)).toContain(BEST);
    const fixtures = loadSnapshot();
    const entries = loadBlogIndex();
    expect(evaluate(fixtures, entries, BEST).top3).toBeGreaterThan(evaluate(fixtures, entries, VARIANTS.summary).top3);
  });
});
