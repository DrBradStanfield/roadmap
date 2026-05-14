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
 *   npx tsx tools/test-chatbot-matching.ts --answer-check   # also test generated answers
 *
 * --answer-check: for entries with must_mention/must_not_mention/max_length_chars,
 * also calls the main LLM (Haiku) with the full production context: blocks 1-3
 * (system prompt + algorithm + products knowledge) PLUS matched pathway/blog content
 * loaded from the handles the router returned (block 4). The check runs N times
 * (matching --runs) and requires majority pass so a single stochastic blip doesn't
 * flip the test. Does not load user data.
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
const sourceFilter = args.includes('--source') ? getArg('--source', '') : null;
// When set, entries with must_mention/must_not_mention/max_length_chars also call
// the main LLM to verify generated content. Loads blocks 1-3 (system prompt +
// algorithm + products) AND matched pathway/blog content (block 4) so the bot has
// the same context production does. Runs --answer-check-runs times (default = --runs,
// usually 3) and requires majority pass. Set --answer-check-runs 1 to cut API spend.
const answerCheckMode = args.includes('--answer-check');
const answerCheckRuns = Math.max(1, parseInt(getArg('--answer-check-runs', String(runs)), 10));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Answer-check context — loaded only when --answer-check is set
// Static portion: prompt cache blocks 1-3 (system prompt + algorithm + products).
// Dynamic portion (per-query, in checkAnswer): block 4 matched pathway/blog
// content, loaded via loadMatchedContent() from the routing intersection.
// Does NOT load user data (per-user, would require a fake profile).
// ---------------------------------------------------------------------------

const ANSWER_MODEL = 'claude-haiku-4-5-20251001';
let ANSWER_SYSTEM_CONTEXT = '';

if (answerCheckMode) {
  try {
    ANSWER_SYSTEM_CONTEXT =
      fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-system-prompt.md'), 'utf-8') +
      '\n\n---\n\n' +
      fs.readFileSync(path.join(REPO_ROOT, 'health_roadmap_algorithm.md'), 'utf-8') +
      '\n\n---\n\n## Dr Stanfield\'s Products\n\n' +
      fs.readFileSync(path.join(REPO_ROOT, 'docs/products.md'), 'utf-8');
  } catch {
    console.error('Error: --answer-check requires app/lib/chat-system-prompt.md, health_roadmap_algorithm.md, and docs/products.md');
    process.exit(1);
  }
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

// Mirrors chat.server.ts loadMatchedArticlesFromHandles. Cap matches production (80K chars ≈ 20K tokens).
const MAX_BLOG_CHARS = 80_000;
const matchedContentCache = new Map<string, string | null>();

function getContentDir(handle: string): string {
  const entry = BLOG_INDEX.find(a => a.handle === handle);
  if (entry?.type === 'guideline') return 'docs/guideline';
  if (entry?.type === 'pathway') return 'docs/pathway';
  return 'docs/blog';
}

function loadHandleContent(handle: string): string | null {
  if (!/^[a-z0-9-]+$/.test(handle)) return null;
  if (matchedContentCache.has(handle)) return matchedContentCache.get(handle) ?? null;
  try {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, getContentDir(handle), `${handle}.md`), 'utf-8',
    );
    matchedContentCache.set(handle, content);
    return content;
  } catch {
    matchedContentCache.set(handle, null);
    return null;
  }
}

function loadMatchedContent(handles: string[]): string | null {
  if (handles.length === 0) return null;
  const parts: string[] = [];
  let totalChars = 0;
  for (const handle of handles) {
    const content = loadHandleContent(handle);
    if (!content) continue;
    if (totalChars + content.length > MAX_BLOG_CHARS) break;
    parts.push(content);
    totalChars += content.length;
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

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
  source?: string;
  notes?: string;
  must_mention?: string[];     // answer must contain ALL of these (case-insensitive)
  must_not_mention?: string[]; // answer must contain NONE of these (case-insensitive)
  max_length_chars?: number;   // answer must be at most this many characters
}

const ALL_QUERIES: TestQuery[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-queries.json'), 'utf-8')
);

let filtered = ALL_QUERIES;
if (categoryFilter) filtered = filtered.filter(q => q.category === categoryFilter);
if (sourceFilter) filtered = filtered.filter(q => q.source === sourceFilter);

if (filtered.length === 0) {
  const desc = [categoryFilter && `category "${categoryFilter}"`, sourceFilter && `source "${sourceFilter}"`].filter(Boolean).join(' AND ');
  console.error(`No queries match ${desc}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run each query N times and compute intersection of handles
// ---------------------------------------------------------------------------

interface AnswerCheckResult {
  passed: boolean;
  failures: string[];
  response: string;
}

interface QueryResult {
  query: TestQuery;
  allRuns: string[][];
  intersection: string[];
  routingPassed: boolean;
  answerCheck: AnswerCheckResult | null; // null if not checked
  passed: boolean;
}

async function checkAnswer(query: string, mustMention: string[], mustNotMention: string[], maxLengthChars: number | undefined, matchedHandles: string[] = [], retryOnRateLimit = true): Promise<AnswerCheckResult> {
  const matchedContent = loadMatchedContent(matchedHandles);
  const system = matchedContent
    ? `${ANSWER_SYSTEM_CONTEXT}\n\n---\n\n## Referenced Blog Articles\n\n${matchedContent}`
    : ANSWER_SYSTEM_CONTEXT;
  const body = {
    model: ANSWER_MODEL,
    max_tokens: 800,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: query }],
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

  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return checkAnswer(query, mustMention, mustNotMention, maxLengthChars, matchedHandles, false);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body.slice(0, 200).replace(/\s+/g, ' ');
    return { passed: false, failures: [`API error ${res.status}: ${detail}`], response: '' };
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const response = data.content?.find(c => c.type === 'text')?.text ?? '';
  const lower = response.toLowerCase();

  const failures: string[] = [];
  for (const term of mustMention) {
    if (!lower.includes(term.toLowerCase())) failures.push(`missing: "${term}"`);
  }
  for (const term of mustNotMention) {
    if (lower.includes(term.toLowerCase())) failures.push(`found forbidden: "${term}"`);
  }
  if (typeof maxLengthChars === 'number' && response.length > maxLengthChars) {
    failures.push(`length ${response.length} chars > cap ${maxLengthChars}`);
  }

  return { passed: failures.length === 0, failures, response };
}

async function runOne(q: TestQuery): Promise<QueryResult> {
  const allRuns: string[][] = [];
  for (let i = 0; i < runs; i++) {
    const { handles } = await routeQuery(q.query);
    allRuns.push(handles);
  }
  const intersection = allRuns[0].filter(h => allRuns.every(run => run.includes(h)));

  let routingPassed: boolean;
  if (q.expected.length === 0) {
    routingPassed = allRuns.every(run => run.length === 0);
  } else {
    routingPassed = q.expected.some(e => intersection.includes(e));
  }

  let answerCheck: AnswerCheckResult | null = null;
  if (answerCheckMode && routingPassed && (q.must_mention?.length || q.must_not_mention?.length || typeof q.max_length_chars === 'number')) {
    const answerRuns: AnswerCheckResult[] = [];
    for (let i = 0; i < answerCheckRuns; i++) {
      answerRuns.push(await checkAnswer(q.query, q.must_mention ?? [], q.must_not_mention ?? [], q.max_length_chars, intersection));
    }
    const passCount = answerRuns.filter(r => r.passed).length;
    const majority = Math.floor(answerCheckRuns / 2) + 1;
    const overallPass = passCount >= majority;
    answerCheck = {
      passed: overallPass,
      failures: overallPass
        ? []
        : answerRuns.flatMap((r, i) => r.passed ? [] : r.failures.map(f => `run ${i + 1}: ${f}`)),
      response: answerRuns[answerRuns.length - 1].response,
    };
  }

  const passed = routingPassed && (answerCheck === null || answerCheck.passed);
  return { query: q, allRuns, intersection, routingPassed, answerCheck, passed };
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
    if (!r.routingPassed) {
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
    }
    if (r.answerCheck && !r.answerCheck.passed) {
      console.log(`    Answer check: ${RED}FAIL${RESET}`);
      for (const f of r.answerCheck.failures) {
        console.log(`      ${RED}→ ${f}${RESET}`);
      }
      if (verbose) {
        console.log(`    Response:     ${GREY}${r.answerCheck.response.slice(0, 300)}...${RESET}`);
      }
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
