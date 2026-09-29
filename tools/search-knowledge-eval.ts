#!/usr/bin/env tsx
/**
 * Offline recall of the lexical ranker over the router fixtures (US-41 AC5).
 *
 * For each fixture in tools/test-queries.json that names at least one expected
 * handle, a hit is any expected handle in the ranker's top 1, 3 or 8 (the
 * tool's max). The table also splits the fixtures by even and odd index: any
 * tuning is done on the even half, so the odd half shows how much it overfits.
 * A chat-filler stopword set (algorithm, take, per, day, best, good) tuned
 * that way gained 2 top-3 on the even half and 0 on the odd half (2026-09-29),
 * so it was not kept. That is
 * the router harness's own pass rule (any one expected handle), minus the
 * cases a ranker cannot express: `expected: []` asks the router to route
 * nothing, and a ranker always returns its best matches. No model call.
 *
 *   npx tsx tools/search-knowledge-eval.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { buildIndex, MAX_K, search, VARIANTS, type Entry, type Weights } from './search-knowledge';

/** The live Sonnet 5.5 router on 2026-09-29, over all 304 routed fixtures (13b53de). */
const ROUTER = { passed: 297, of: 304 };

export interface Fixture {
  query: string;
  expected?: string[];
  must_not_route?: string[];
  answer_handles?: string[];
}

export function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(join(process.cwd(), 'tools/test-queries.json'), 'utf8'));
}

/** Only fixtures that name a handle to find; must-route-nothing and answer-only cases are skipped. */
export function recallFixtures(all: Fixture[]): (Fixture & { expected: string[] })[] {
  return all.filter((f): f is Fixture & { expected: string[] } => Array.isArray(f.expected) && f.expected.length > 0);
}

/** Every other fixture, by index: 'even' is the tuning half, 'odd' the held-out one. */
export function half<T>(fixtures: T[], which: 'even' | 'odd'): T[] {
  return fixtures.filter((_, i) => i % 2 === (which === 'even' ? 0 : 1));
}

export function evaluate(
  fixtures: Fixture[],
  entries: Entry[],
  weights: Weights,
): { n: number; top1: number; top3: number; top8: number } {
  const index = buildIndex(entries, weights);
  const scored = recallFixtures(fixtures);
  const hits = { top1: 0, top3: 0, top8: 0 };
  for (const f of scored) {
    const handles = search(index, f.query, MAX_K).map((h) => h.handle);
    const rank = handles.findIndex((h) => f.expected.includes(h));
    if (rank === 0) hits.top1++;
    if (rank >= 0 && rank < 3) hits.top3++;
    if (rank >= 0) hits.top8++;
  }
  return { n: scored.length, ...hits };
}

const pct = (hits: number, n: number) => `${hits}/${n} (${((100 * hits) / n).toFixed(1)}%)`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = recallFixtures(loadFixtures());
  const entries = loadBlogIndex();
  const halves = { even: half(fixtures, 'even'), odd: half(fixtures, 'odd'), all: fixtures };
  const rows = Object.entries(VARIANTS).flatMap(([name, weights]) => Object.entries(halves).map(([which, set]) => {
    const r = evaluate(set, entries, weights);
    return `| ${name} | ${which} | ${pct(r.top1, r.n)} | ${pct(r.top3, r.n)} | ${pct(r.top8, r.n)} |`;
  }));
  process.stdout.write([
    `Lexical ranker over ${entries.length} entries; fixtures with an expected handle only.`,
    '',
    '| Ranker | Half | Top-1 | Top-3 | Top-8 |',
    '|---|---|---|---|---|',
    ...rows,
    `| live router (Sonnet 5.5, any expected in its set, incl. route-nothing) | all 304 | n/a | ${pct(ROUTER.passed, ROUTER.of)} | n/a |`,
    '',
  ].join('\n'));
}
