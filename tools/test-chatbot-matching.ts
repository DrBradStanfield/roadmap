#!/usr/bin/env tsx
/**
 * LLM router test harness.
 *
 * Reads the same shared sources as app/lib/chat-router.server.ts — the
 * chat-router-prompt.md file and docs/blog/index.json — and calls Anthropic
 * directly. Kept self-contained (no import of chat-router.server.ts) because
 * tsx can't resolve the health-core workspace package through the Remix
 * server-module import chain. The prompt + index + model fully determine
 * routing behavior, so sharing those files catches any drift.
 *
 * Each query runs N times; pass = at least one expected handle appears in
 * the intersection of all runs (consistently returned across retries).
 * Acceptance bar: pass rate ≥ 90%, variance ≤ 5%.
 *
 * Usage:
 *   npx tsx tools/test-chatbot-matching.ts
 *   npx tsx tools/test-chatbot-matching.ts --runs 3 --verbose
 *   npx tsx tools/test-chatbot-matching.ts --category cardiovascular
 *   npx tsx tools/test-chatbot-matching.ts --variance-threshold 0.1
 *
 * Exit code 0 if acceptance bar met, 1 otherwise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const runs = Math.max(1, parseInt(getArg('--runs', '3'), 10));
const varianceThreshold = parseFloat(getArg('--variance-threshold', '0.05'));
// Default concurrency 1: the 80K-token index counts toward ITPM on cold cache.
// Five concurrent cold requests each recreate the cache = 400K tokens/min, blows
// the Tier 1 50K ITPM limit. Post-warmup, cache reads consume ITPM at a reduced
// rate, so --concurrency 3 is usually safe; bump manually if runs feel slow.
const concurrency = Math.max(1, parseInt(getArg('--concurrency', '1'), 10));
const verbose = args.includes('--verbose');
const categoryFilter = args.includes('--category') ? getArg('--category', '') : null;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared sources — read the same files chat-router.server.ts uses
// ---------------------------------------------------------------------------

const ROUTER_MODEL = 'claude-haiku-4-5-20251001';

interface BlogIndexEntry {
  title: string;
  handle: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  summary?: string;
}

const BLOG_INDEX: BlogIndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'docs/blog/index.json'), 'utf-8')
);

const VALID_HANDLES = new Set(BLOG_INDEX.map(e => e.handle));

const TYPE_ORDER: Record<string, number> = { pathway: 0, guideline: 1, reference: 2, article: 3 };

const ROUTER_INDEX_BLOCK: string = [...BLOG_INDEX]
  .sort((a, b) => {
    const tr = (TYPE_ORDER[a.type ?? 'article'] ?? 3) - (TYPE_ORDER[b.type ?? 'article'] ?? 3);
    if (tr !== 0) return tr;
    return a.handle.localeCompare(b.handle);
  })
  .map(e => `[${e.type ?? 'article'}] ${e.handle}: ${e.summary ?? e.title}`)
  .join('\n');

const ROUTER_PROMPT = fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-router-prompt.md'), 'utf-8');

// ---------------------------------------------------------------------------
// Anthropic API call — minimal fetch glue, same body shape as routeQuery
// ---------------------------------------------------------------------------

interface RouteResult {
  handles: string[];
  rateLimited: boolean;
}

async function routeQuery(currentMessage: string, retryOnRateLimit = true): Promise<RouteResult> {
  const body = {
    model: ROUTER_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: [
      { type: 'text', text: ROUTER_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: ROUTER_INDEX_BLOCK, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `Current query: ${currentMessage}` }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  // Rate-limited: wait for the reset window and retry once. Anthropic returns
  // retry-after header; default to 30s which matches a typical ITPM refill window.
  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return routeQuery(currentMessage, false);
  }

  if (!res.ok) return { handles: [], rateLimited: res.status === 429 };

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find(c => c.type === 'text')?.text ?? '';

  // Haiku sometimes adds prose after the JSON (esp. on urgent-sounding symptom
  // queries). Extract the JSON object between first { and last } — same logic
  // as app/lib/anthropic.server.ts:extractJsonObject.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const stripped = first !== -1 && last > first ? text.slice(first, last + 1) : text;

  try {
    const parsed = JSON.parse(stripped) as { handles?: unknown };
    if (!Array.isArray(parsed.handles)) return { handles: [], rateLimited: false };
    const handles = parsed.handles
      .filter((h): h is string => typeof h === 'string' && /^[a-z0-9-]+$/.test(h) && h.length <= 120)
      .filter(h => VALID_HANDLES.has(h))
      .slice(0, 3);
    return { handles, rateLimited: false };
  } catch {
    return { handles: [], rateLimited: false };
  }
}

// ---------------------------------------------------------------------------
// Load test queries
// ---------------------------------------------------------------------------

interface TestQuery {
  query: string;
  expected: string[];
  category: string;
  notes?: string;
}

const ALL_QUERIES: TestQuery[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-queries.json'), 'utf-8')
);

const filtered = categoryFilter
  ? ALL_QUERIES.filter(q => q.category === categoryFilter)
  : ALL_QUERIES;

if (filtered.length === 0) {
  console.error(`No queries match category "${categoryFilter}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run each query N times and compute intersection of handles
// ---------------------------------------------------------------------------

interface QueryResult {
  query: TestQuery;
  allRuns: string[][];
  intersection: string[];
  passed: boolean;
}

async function runOne(q: TestQuery): Promise<QueryResult> {
  const allRuns: string[][] = [];
  for (let i = 0; i < runs; i++) {
    const { handles } = await routeQuery(q.query);
    allRuns.push(handles);
  }
  const intersection = allRuns[0].filter(h => allRuns.every(run => run.includes(h)));

  let passed: boolean;
  if (q.expected.length === 0) {
    passed = allRuns.every(run => run.length === 0);
  } else {
    passed = q.expected.some(e => intersection.includes(e));
  }

  return { query: q, allRuns, intersection, passed };
}

async function runAll(): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const queue = [...filtered];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift()!;
      results.push(await runOne(q));
      completed++;
      process.stdout.write(`\r  ${completed}/${filtered.length} queries`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filtered.length) }, () => worker())
  );
  process.stdout.write('\n');

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

console.log(`\n${BOLD}=== LLM Router Test Harness ===${RESET}\n`);
console.log(`Index:       ${BLOG_INDEX.length} entries`);
console.log(`Queries:     ${filtered.length}`);
console.log(`Runs each:   ${runs}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Threshold:   ≤${(varianceThreshold * 100).toFixed(0)}% variance\n`);

// Warm the prompt cache with one call before running the suite. First call
// creates the 80K-token cache block; subsequent calls read from it at a
// reduced ITPM rate. Without the warmup, Tier 1 accounts hit the 50K ITPM
// limit on the first real query.
console.log('Warming prompt cache...');
const warmResult = await routeQuery('health');
if (warmResult.rateLimited) {
  console.error('\nWarmup rate-limited. If on Anthropic Tier 1 (50K ITPM), wait 60s and retry.');
  process.exit(1);
}
console.log('Cache warmed. Running test suite.\n');

const t0 = Date.now();
const results = await runAll();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const passed = results.filter(r => r.passed);
const failed = results.filter(r => !r.passed);
const passRate = passed.length / results.length;
const varRate = failed.length / results.length;

const byCategory: Record<string, { pass: number; fail: number }> = {};
for (const r of results) {
  if (!byCategory[r.query.category]) byCategory[r.query.category] = { pass: 0, fail: 0 };
  byCategory[r.query.category][r.passed ? 'pass' : 'fail']++;
}

console.log(`\n${BOLD}=== Results (${elapsed}s) ===${RESET}\n`);
console.log(`Total:       ${results.length}`);
console.log(`${GREEN}Passing:     ${passed.length}${RESET}`);
console.log(`${RED}Failing:     ${failed.length}${RESET}`);

const passOk = passRate >= 0.9;
const varOk = varRate <= varianceThreshold;
console.log(`Pass rate:   ${BOLD}${(passRate * 100).toFixed(1)}%${RESET} ${passOk ? `${GREEN}✓${RESET}` : `${RED}✗ need ≥90%${RESET}`}`);
console.log(`Variance:    ${BOLD}${(varRate * 100).toFixed(1)}%${RESET} ${varOk ? `${GREEN}✓${RESET}` : `${RED}✗ max ${(varianceThreshold * 100).toFixed(0)}%${RESET}`}`);

console.log(`\n${BOLD}--- By category ---${RESET}`);
for (const [cat, stats] of Object.entries(byCategory).sort((a, b) => b[1].fail - a[1].fail)) {
  const total = stats.pass + stats.fail;
  const rate = (stats.pass / total * 100).toFixed(0);
  const colour = stats.fail === 0 ? GREEN : (stats.pass === 0 ? RED : YELLOW);
  console.log(`  ${colour}${cat.padEnd(20)} ${stats.pass}/${total} (${rate}%)${RESET}`);
}

if (failed.length > 0) {
  console.log(`\n${BOLD}${RED}--- Failing queries ---${RESET}`);
  for (const r of failed) {
    console.log(`\n${RED}✗${RESET} ${BOLD}[${r.query.category}]${RESET} "${r.query.query}"`);
    if (r.query.expected.length > 0) {
      console.log(`    Expected:     ${r.query.expected.join(' | ')}`);
    } else {
      console.log(`    Expected:     (empty — out-of-scope)`);
    }
    if (r.intersection.length === 0) {
      console.log(`    Intersection: ${GREY}∅ (nothing consistent across ${runs} runs)${RESET}`);
    } else {
      console.log(`    Intersection: ${r.intersection.join(', ')}`);
    }
    if (runs > 1) {
      const runSummary = r.allRuns.map((run, i) => `[${i + 1}]${run.join(',') || '∅'}`).join(' ');
      console.log(`    Runs:         ${GREY}${runSummary}${RESET}`);
    }
    if (r.query.notes) console.log(`    Notes:        ${GREY}${r.query.notes}${RESET}`);
  }
}

if (verbose) {
  console.log(`\n${BOLD}${GREEN}--- Passing queries ---${RESET}`);
  for (const r of passed) {
    const top = r.intersection[0] ?? r.allRuns[0]?.[0] ?? '(router-empty)';
    console.log(`${GREEN}✓${RESET} [${r.query.category}] "${r.query.query}" → ${top}`);
  }
}

console.log();
process.exit(passOk && varOk ? 0 : 1);
