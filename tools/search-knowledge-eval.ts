#!/usr/bin/env tsx
/**
 * Offline recall of the lexical ranker over the router fixtures (US-41 AC5).
 *
 * For each fixture in tools/test-queries.json that names at least one expected
 * handle, a hit is any expected handle in the ranker's top 1 or top 3. That is
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
import { buildIndex, search, VARIANTS, type Entry, type Weights } from './search-knowledge';

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

export function evaluate(fixtures: Fixture[], entries: Entry[], weights: Weights): { n: number; top1: number; top3: number } {
  const index = buildIndex(entries, weights);
  const scored = recallFixtures(fixtures);
  let top1 = 0;
  let top3 = 0;
  for (const f of scored) {
    const handles = search(index, f.query, 3).map((h) => h.handle);
    if (f.expected.includes(handles[0])) top1++;
    if (handles.some((h) => f.expected.includes(h))) top3++;
  }
  return { n: scored.length, top1, top3 };
}

const pct = (hits: number, n: number) => `${hits}/${n} (${((100 * hits) / n).toFixed(1)}%)`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = loadFixtures();
  const entries = loadBlogIndex();
  const rows = Object.entries(VARIANTS).map(([name, weights]) => {
    const r = evaluate(fixtures, entries, weights);
    return `| ${name} | ${pct(r.top1, r.n)} | ${pct(r.top3, r.n)} |`;
  });
  process.stdout.write([
    `Lexical ranker over ${entries.length} entries; fixtures with an expected handle only.`,
    '',
    '| Ranker | Top-1 | Top-3 |',
    '|---|---|---|',
    ...rows,
    `| live router (Sonnet 5.5, any expected in its set, incl. route-nothing) | n/a | ${pct(ROUTER.passed, ROUTER.of)} |`,
    '',
  ].join('\n'));
}
