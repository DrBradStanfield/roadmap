#!/usr/bin/env tsx
/**
 * Offline recall of the lexical ranker over the router fixtures (US-41 AC5).
 *
 * A hit is any expected handle in the ranker's top 1, 3 or 8 (the tool's max):
 * the router harness's own pass rule, minus the cases a ranker cannot express.
 * `expected: []` asks the router to route nothing, and a ranker always returns
 * its best matches, so those fixtures are skipped for recall. Their
 * `must_not_route` handles are still checked: none may appear in a top 8.
 *
 * The table splits the fixtures by even and odd index. Tuning is done on the
 * even half, so the odd half shows how much it overfits. A chat-filler
 * stopword set (algorithm, take, per, day, best, good) tuned that way gained 2
 * top-3 on the even half and 0 on the odd half (2026-09-29), so it was not
 * kept. The abbreviation map was built with all fixtures in view: neither
 * half holds it out.
 *
 * The gate reads a frozen snapshot, tools/fixtures/search-knowledge-fixtures.json,
 * because the chat-health loop edits tools/test-queries.json weekly. No model call.
 *
 *   npx tsx tools/search-knowledge-eval.ts                   # the snapshot the test gates on
 *   npx tsx tools/search-knowledge-eval.ts --live            # the live fixtures, report only
 *   npx tsx tools/search-knowledge-eval.ts --write-snapshot  # re-freeze the snapshot from the live file
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { buildIndex, MAX_K, search, VARIANTS, type Entry, type Weights } from './search-knowledge';

/** The live Sonnet 5.5 router on 2026-09-29, over all 304 routed fixtures (13b53de). */
const ROUTER = { passed: 297, of: 304 };

const LIVE = 'tools/test-queries.json';
const SNAPSHOT = 'tools/fixtures/search-knowledge-fixtures.json';

export interface Fixture {
  query: string;
  expected?: string[];
  must_not_route?: string[];
  answer_handles?: string[];
  expected_classification?: string;
}

const readJson = (path: string): Fixture[] => JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
export const loadFixtures = (): Fixture[] => readJson(LIVE);
export const loadSnapshot = (): Fixture[] => readJson(SNAPSHOT);

/** Only fixtures that name a handle to find. */
export function recallFixtures(all: Fixture[]): (Fixture & { expected: string[] })[] {
  return all.filter((f): f is Fixture & { expected: string[] } => Array.isArray(f.expected) && f.expected.length > 0);
}

/** Why the others are not scored for recall. */
export function skipCounts(all: Fixture[]): { emptyExpected: number; classificationOnly: number; answerOnly: number } {
  const noExpected = all.filter((f) => !Array.isArray(f.expected));
  return {
    emptyExpected: all.filter((f) => Array.isArray(f.expected) && f.expected.length === 0).length,
    classificationOnly: noExpected.filter((f) => f.expected_classification !== undefined && !f.answer_handles).length,
    answerOnly: noExpected.filter((f) => f.answer_handles).length,
  };
}

/** What the snapshot keeps: every fixture the eval reads, and only the fields it reads. */
export function snapshotOf(all: Fixture[]): Fixture[] {
  return all
    .filter((f) => Array.isArray(f.expected) && (f.expected.length > 0 || f.must_not_route?.length))
    .map(({ query, expected, must_not_route }) => ({ query, expected, ...(must_not_route ? { must_not_route } : {}) }));
}

/** Every other fixture, by index: 'even' is the tuning half, 'odd' the held-out one. */
export function half<T>(fixtures: T[], which: 'even' | 'odd'): T[] {
  return fixtures.filter((_, i) => i % 2 === (which === 'even' ? 0 : 1));
}

export function evaluate(
  fixtures: Fixture[],
  entries: Entry[],
  weights: Weights,
): { n: number; top1: number; top3: number; top8: number; violations: number } {
  const index = buildIndex(entries, weights);
  const result = { n: 0, top1: 0, top3: 0, top8: 0, violations: 0 };
  for (const f of fixtures) {
    const handles = search(index, f.query, MAX_K).map((h) => h.handle);
    if (f.must_not_route?.some((h) => handles.includes(h))) result.violations++;
    if (!f.expected?.length) continue;
    const rank = handles.findIndex((h) => f.expected?.includes(h));
    result.n++;
    if (rank === 0) result.top1++;
    if (rank >= 0 && rank < 3) result.top3++;
    if (rank >= 0) result.top8++;
  }
  return result;
}

const pct = (hits: number, n: number) => `${hits}/${n} (${((100 * hits) / n).toFixed(1)}%)`;

function report(all: Fixture[], source: string): string {
  const entries = loadBlogIndex();
  const scored = recallFixtures(all);
  const halves = { even: half(scored, 'even'), odd: half(scored, 'odd'), all: scored };
  const rows = Object.entries(VARIANTS).flatMap(([name, weights]) => Object.entries(halves).map(([which, set]) => {
    const r = evaluate(set, entries, weights);
    return `| ${name} | ${which} | ${pct(r.top1, r.n)} | ${pct(r.top3, r.n)} | ${pct(r.top8, r.n)} |`;
  }));
  const skipped = skipCounts(all);
  const violations = Object.entries(VARIANTS).map(([name, weights]) => `${name} ${evaluate(all, entries, weights).violations}`);
  return [
    `Lexical ranker over ${entries.length} entries; ${source}, ${scored.length} fixtures with an expected handle.`,
    `Skipped: ${skipped.emptyExpected} with expected: [], ${skipped.classificationOnly} classification-only, ${skipped.answerOnly} answer-only.`,
    `must_not_route handles in a top 8: ${violations.join(', ')}.`,
    '',
    '| Ranker | Half | Top-1 | Top-3 | Top-8 |',
    '|---|---|---|---|---|',
    ...rows,
    `| live router (Sonnet 5.5, any expected in its set, incl. route-nothing) | all 304 | n/a | ${pct(ROUTER.passed, ROUTER.of)} | n/a |`,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv[2];
  if (flag === '--write-snapshot') {
    writeFileSync(join(process.cwd(), SNAPSHOT), `${JSON.stringify(snapshotOf(loadFixtures()), null, 2)}\n`);
    process.stdout.write(`Wrote ${SNAPSHOT}\n`);
  } else {
    process.stdout.write(flag === '--live' ? report(loadFixtures(), LIVE) : report(loadSnapshot(), SNAPSHOT));
  }
}
