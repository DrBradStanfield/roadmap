#!/usr/bin/env tsx
/**
 * LLM router test harness.
 *
 * Reads the same shared sources as app/lib/chat-router.server.ts — the
 * chat-router-prompt.md file and docs/blog/index.json — and calls Anthropic
 * directly. Kept self-contained (no import of chat-router.server.ts) because
 * tsx can't resolve the health-core workspace package through the Remix
 * server-module import chain. The prompt + index + model fully determine
 * routing behavior, so sharing those files catches any drift. The one server
 * import is app/lib/matched-content.ts, the Sentry-free loader production uses
 * for matched articles (its only dependency is blog-index.server.ts, so tsx can
 * follow it). It reads from process.cwd(): run from the repo root.
 *
 * Each query runs N times; pass = at least one expected handle appears in
 * the intersection of all runs (consistently returned across retries).
 * Acceptance bar: pass rate ≥ 90%, variance ≤ 5%.
 *
 * Fixture fields (tools/test-queries.json; router entries carry `expected`):
 *   expected: string[]        handles; any one in the intersection passes ([] = must route nothing)
 *   must_not_route?: string[] handles the case must NEVER get: one in ANY run fails the case,
 *                             reported "✗ routed forbidden handle X". `expected` cannot fail an
 *                             extra handle (2026-09-29: anticoagulant pathways leaked next to the
 *                             vitamin K reference and the run still scored 299/304). Each must be
 *                             a real index handle, or the harness exits before any API call.
 *   category, source?, notes?, must_mention?, must_not_mention?, max_length_chars? (below)
 *   answer_handles?: string[] fixed-handle answer check, on an entry with NO `expected`: under
 *                             --answer-check the answer is scored against context built from
 *                             exactly these handles (in order, via the production loader),
 *                             with no router call. Such entries never join the router suite
 *                             or its pass rate; they report on their own line. They gate the
 *                             exit code only under --fixed-handles-only, so a plain
 *                             --answer-check (the model-bump qualification) never goes red on
 *                             them before a live baseline exists. Each handle must load and the list
 *                             must fit the 120K cap, or the harness exits before any API call.
 *   must_not_claim?: string[]  answer check only: a phrase stated as fact fails. A negation (no, not,
 *                             never, cannot, without, nor, nothing, none, neither, n't) excuses it only
 *                             within the 12 words before it and inside its clause (a semicolon, dash,
 *                             "but" or "and" ends the clause; a comma or "or" does not, so "claims
 *                             can't be made, including that it lowers X" and "not X or Y" stay negated). So "it makes no claim that it can lower blood
 *                             pressure" passes; "it has no sugar and can lower blood pressure" fails.
 *                             Markdown * and _ are stripped, curly quotes straightened. A heuristic:
 *                             keep the phrases claim-shaped.
 *   surface?: 'doctor' | 'brand'  answer check only: adds app/lib/chat-posture-<surface>.md after the
 *                             products block, where production's buildSystemBlocks puts it. Omitted =
 *                             no posture block (the harness's behaviour before 2026-10-07).
 *
 * A fetch that throws (timeout, DNS, reset) counts as an API error, like a non-2xx:
 * visible, scored as ∅, and the run continues but never exits green.
 *
 * Usage:
 *   npx tsx tools/test-chatbot-matching.ts
 *   npx tsx tools/test-chatbot-matching.ts --runs 3 --verbose
 *   npx tsx tools/test-chatbot-matching.ts --category cardiovascular
 *   npx tsx tools/test-chatbot-matching.ts --category pediatric,palliative   # several, one warmup
 *   npx tsx tools/test-chatbot-matching.ts --variance-threshold 0.1
 *   npx tsx tools/test-chatbot-matching.ts --answer-check   # also test generated answers
 *   npx tsx tools/test-chatbot-matching.ts --fixed-handles-only   # only the answer_handles checks (implies --answer-check)
 *   npx tsx tools/test-chatbot-matching.ts --model <router id> [--thinking-off | --effort-low] --answer-model <answer id>
 *
 * --answer-check: for entries with must_mention/must_not_mention/max_length_chars,
 * also calls the main LLM (CHAT_MODEL; --answer-model overrides) with the full production context: blocks 1-3
 * (system prompt + algorithm + products knowledge) PLUS matched pathway/blog content
 * loaded from the handles the router returned, or from `answer_handles` (block 4). The check runs N times
 * (matching --answer-check-runs, default = --runs) and requires majority pass so
 * a single stochastic blip doesn't flip the test. Does not load user data.
 *
 * COST DISCIPLINE — read this before iterating, the audit cycle of 2026-05-14/15
 * burned ~$30 because of these mistakes:
 *   - DEFAULT TO --category WHEN ITERATING. A full suite re-run is 30 queries × 4+
 *     LLM calls = 120+ calls. A single --category run is 1-3 queries. 30-50x
 *     cheaper per iteration. Only run the full suite at end-of-session.
 *   - DEFAULT TO --answer-check-runs 1 WHEN ITERATING. The default 3 triples
 *     answer-check cost. Only use 3 for the final verification.
 *   - READ THE BOT'S RESPONSE BEFORE RE-EDITING TESTS. Use --verbose and look at
 *     what the bot actually produced. Rewriting must_mention/must_not_mention
 *     blindly leads to multiple re-runs that each cost real money.
 *   - EDITING THE SYSTEM PROMPT INVALIDATES THE 1-HOUR ANTHROPIC PROMPT CACHE.
 *     Every re-run after a prompt edit pays cache-write price (2x base) instead
 *     of cache-read (0.10x base). Batch prompt edits where possible.
 *
 * Exit code 0 if acceptance bar met, 1 otherwise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CHAT_EFFORT, CHAT_MAX_TOKENS, CHAT_MODEL, ROUTER_MODEL as PRODUCTION_ROUTER_MODEL,
  PROMPT_CACHE, getArg as getArgOf, modelParams, summaryLine, toStat, type CallStat,
} from '../packages/health-core/src/models';
import { CHAT_EDIT_TOOLS } from '../packages/health-core/src/chat-edits';
import { loadBlogArticle, loadMatchedContent } from '../app/lib/matched-content';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
// app/lib/matched-content.ts reads articles from process.cwd().
if (path.resolve(process.cwd()) !== REPO_ROOT) { console.error(`Run from the repo root (${REPO_ROOT}): the article loader reads from the working directory.`); process.exit(1); }

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const getArg = (flag: string, defaultValue: string) => getArgOf(args, flag, defaultValue);

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
const fixedHandlesOnly = args.includes('--fixed-handles-only');
const answerCheckMode = args.includes('--answer-check') || fixedHandlesOnly;
const answerCheckRuns = Math.max(1, parseInt(getArg('--answer-check-runs', String(runs)), 10));

// Prefer ANTHROPIC_TEST_API_KEY if set — keeps harness spend isolated from
// production billing. Falls back to ANTHROPIC_API_KEY for backward compatibility.
const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}
const usingTestKey = !!process.env.ANTHROPIC_TEST_API_KEY;
console.log(`Using ${usingTestKey ? 'ANTHROPIC_TEST_API_KEY (test workspace)' : 'ANTHROPIC_API_KEY (production key — billing shared with prod)'}`);

// ---------------------------------------------------------------------------
// Answer-check context — loaded only when --answer-check is set
// Static portion: prompt cache blocks 1-3 (system prompt + algorithm + products).
// Dynamic portion (per-query, in checkAnswer): block 4 matched pathway/blog
// content, loaded via loadMatchedContent() from the routing intersection
// (or a fixture's answer_handles).
// Does NOT load user data (per-user, would require a fake profile).
// ---------------------------------------------------------------------------

// --answer-model qualifies a candidate answer model; the body shape follows its family.
const ANSWER_MODEL = getArg('--answer-model', CHAT_MODEL);
let ANSWER_SYSTEM_CONTEXT = '';
let apiErrorCount = 0;

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

// --model A/Bs a candidate router against the production pin. Thinking is
// off by default, as production; --effort-low is the candidate arm (Sonnet 5
// family only, modelParams in health-core models.ts; --thinking-off is the
// default, kept as an explicit flag). Stats cover suite calls only; the
// warmup call is excluded.
const ROUTER_MODEL = getArg('--model', PRODUCTION_ROUTER_MODEL);
const thinkingOff = !args.includes('--effort-low');
const callStats: CallStat[] = [];

interface BlogIndexEntry {
  title: string;
  handle: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  summary?: string;
}

// --index <path> overrides the index the ROUTER sees, so an experimental index
// (e.g. summary-capped) can be A/B'd against production without touching
// docs/blog/index.json. Matched-article loading still reads the real .md files.
const indexPathArg = args.includes('--index') ? getArg('--index', '') : null;
const INDEX_PATH = indexPathArg
  ? path.resolve(indexPathArg)
  : path.join(REPO_ROOT, 'docs/blog/index.json');

const BLOG_INDEX: BlogIndexEntry[] = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

const VALID_HANDLES = new Set(BLOG_INDEX.map(e => e.handle));

// Mirrors ROUTER_SUMMARY_MAX_CHARS + capSummary() in chat-router.server.ts.
// The harness did NOT truncate until 2026-08-07, so it was rendering FULL
// summaries while production rendered capped ones — every "baseline" number
// measured a prompt production never sends. --summary-cap overrides it so
// alternative caps can be A/B'd without editing the index.
const SUMMARY_CAP = args.includes('--summary-cap') ? parseInt(getArg('--summary-cap', '150'), 10) : 150;

function capSummary(s: string): string {
  if (s.length <= SUMMARY_CAP) return s;
  const cut = s.slice(0, SUMMARY_CAP);
  for (const sep of ['. ', '; ', ', ', ' ']) {
    const p = cut.lastIndexOf(sep);
    if (p > SUMMARY_CAP * 0.6) return cut.slice(0, p).replace(/[ ,;.]+$/, '');
  }
  return cut.trimEnd();
}

// Mirrors repairHandle() in app/lib/chat-router.server.ts — strips a leading
// `<type>-` when the remainder is a real handle (the router emits
// `guideline-diet` for `diet`). Duplicated because tsx can't import the server
// module; keep the two in sync. Without it the harness under-reports the real
// pass rate, which is exactly what happened on the protein queries.
function repairHandle(h: string): string {
  if (VALID_HANDLES.has(h)) return h;
  for (const t of ['pathway', 'guideline', 'reference', 'article']) {
    if (h.startsWith(`${t}-`)) {
      const stripped = h.slice(t.length + 1);
      if (VALID_HANDLES.has(stripped)) return stripped;
    }
  }
  return h;
}

const TYPE_ORDER: Record<string, number> = { pathway: 0, guideline: 1, reference: 2, article: 3 };

const ROUTER_INDEX_BLOCK: string = [...BLOG_INDEX]
  .sort((a, b) => {
    const tr = (TYPE_ORDER[a.type ?? 'article'] ?? 3) - (TYPE_ORDER[b.type ?? 'article'] ?? 3);
    if (tr !== 0) return tr;
    return a.handle.localeCompare(b.handle);
  })
  .map(e => `[${e.type ?? 'article'}] ${e.handle}: ${capSummary(e.summary ?? e.title ?? '')}`)
  .join('\n');

// {{ENTRY_COUNT}} substitution must mirror chat-router.server.ts getRouterPrompt().
// Without it the harness would send the literal placeholder to the model and
// stop being a faithful test of production.
const ROUTER_PROMPT = fs
  .readFileSync(path.join(REPO_ROOT, 'app/lib/chat-router-prompt.md'), 'utf-8')
  .replace(/\{\{ENTRY_COUNT\}\}/g, String(BLOG_INDEX.length));

// ---------------------------------------------------------------------------
// Anthropic API call — minimal fetch glue, same body shape as routeQuery
// ---------------------------------------------------------------------------

interface RouteResult {
  handles: string[];
  rateLimited: boolean;
}

// A timeout, DNS failure or reset throws instead of returning a status. Return
// it as a label so each caller scores it like a non-2xx: one slow call must not
// kill a 304-case run (2026-09-29).
async function postMessages(body: object, timeoutMs: number): Promise<Response | string> {
  try {
    return await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
    return String((err as { cause?: { code?: string } }).cause?.code ?? err).slice(0, 100);
  }
}

async function routeQuery(currentMessage: string, retryOnRateLimit = true, record = true): Promise<RouteResult> {
  const t0 = Date.now();
  const body = {
    ...modelParams(ROUTER_MODEL, 200, thinkingOff ? 'off' : 'low'),
    system: [
      { type: 'text', text: ROUTER_PROMPT, cache_control: PROMPT_CACHE },
      { type: 'text', text: ROUTER_INDEX_BLOCK, cache_control: PROMPT_CACHE },
    ],
    messages: [{ role: 'user', content: `Current query: ${currentMessage}` }],
  };

  const res = await postMessages(body, 30_000);
  if (typeof res === 'string') {
    apiErrorCount++;
    process.stdout.write(` [api-error ${res}]`);
    return { handles: [], rateLimited: false };
  }

  // Rate-limited: wait for the reset window and retry once. Anthropic returns
  // retry-after header; default to 30s which matches a typical ITPM refill window.
  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return routeQuery(currentMessage, false, record);
  }

  if (!res.ok) {
    // An errored call must be VISIBLE: silently returning ∅ made a rate-limit
    // brownout look like a mass routing regression (2026-08-30, W35).
    apiErrorCount++;
    const errBody = await res.text().catch(() => '');
    process.stdout.write(` [api-error ${res.status}: ${errBody.slice(0, 200)}]`);
    return { handles: [], rateLimited: res.status === 429 };
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: Parameters<typeof toStat>[1] };
  if (record) callStats.push(toStat(Date.now() - t0, data.usage));
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
      .map(repairHandle)
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
  must_not_route?: string[];   // handles no run may return (see the header)
  must_mention?: string[];     // answer must contain ALL of these (case-insensitive)
  must_not_mention?: string[]; // answer must contain NONE of these (case-insensitive)
  must_not_claim?: string[];   // no un-negated sentence may hold these (see the header)
  max_length_chars?: number;   // answer must be at most this many characters
  answer_handles?: string[];   // fixed-handle answer check, no `expected` (see the header)
  surface?: 'doctor' | 'brand'; // answer check adds that surface's posture block (see the header)
}

const ALL_QUERIES: TestQuery[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-queries.json'), 'utf-8')
);

// Classifier-only entries (test-classifier.ts) live in the same file but
// have no `expected` handles array — exclude them from the router suite.
let filtered = fixedHandlesOnly ? [] : ALL_QUERIES.filter(q => Array.isArray(q.expected));
// Fixed-handle answer checks never join the router suite: no `expected`, so the
// filter above skips them; they run only under --answer-check.
let fixedHandle = answerCheckMode ? ALL_QUERIES.filter(q => !Array.isArray(q.expected) && Array.isArray(q.answer_handles)) : [];
// A handle that fails to load, or a list over the cap, would score a context the fixture never meant.
const badFixed = fixedHandle.flatMap(q => [
  ...q.answer_handles!.filter(h => !loadBlogArticle(h)).map(h => `${h} (no file)`),
  ...loadMatchedContent(q.answer_handles!).skipped.map(h => `${h} (over the cap)`),
]);
if (badFixed.length > 0) {
  console.error(`answer_handles that would not load: ${badFixed.join(', ')}`);
  process.exit(1);
}
// A mistyped forbidden handle can never be returned, so the guard would pass forever.
const unknownForbidden = filtered.flatMap(q => (q.must_not_route ?? []).filter(h => !VALID_HANDLES.has(h)));
if (unknownForbidden.length > 0) {
  console.error(`must_not_route names handles not in the index: ${unknownForbidden.join(', ')}`);
  process.exit(1);
}
// A surface the harness cannot load would score an answer with no posture at all.
const POSTURES = new Map<string, string>();
for (const q of ALL_QUERIES) {
  if (q.surface === undefined || POSTURES.has(q.surface)) continue;
  const file = path.join(REPO_ROOT, 'app/lib', `chat-posture-${q.surface}.md`);
  if (!['doctor', 'brand'].includes(q.surface) || !fs.existsSync(file)) {
    console.error(`unknown surface "${q.surface}" on: ${q.query}`);
    process.exit(1);
  }
  POSTURES.set(q.surface, fs.readFileSync(file, 'utf-8'));
}
// --category takes a comma list, so several categories share one run and one cache warmup.
const categories = categoryFilter?.split(',');
if (categories) filtered = filtered.filter(q => categories.includes(q.category));
if (sourceFilter) filtered = filtered.filter(q => q.source === sourceFilter);
if (categories) fixedHandle = fixedHandle.filter(q => categories.includes(q.category));
if (sourceFilter) fixedHandle = fixedHandle.filter(q => q.source === sourceFilter);
const suite = [...filtered, ...fixedHandle];

if (suite.length === 0) {
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
  forbidden: string[];                   // must_not_route handles any run returned
  answerCheck: AnswerCheckResult | null; // null if not checked
  passed: boolean;
}

const NEGATION = /\b(no|not|never|cannot|without|nor|nothing|none|neither)\b|n't\b/;
// A negation only excuses a phrase from inside its own clause.
const CLAUSE_BREAK = /[;—–]|\bbut\b|\band\b/g;

/** Phrases stated as fact: no negation in the up-to-12 words before them, within their clause. */
function claimed(response: string, phrases: string[]): string[] {
  const text = response.toLowerCase().replace(/[’‘]/g, "'").replace(/[*_]/g, '');
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return phrases.filter(p => sentences.some(s => {
    const phrase = p.toLowerCase().replace(/[’‘]/g, "'");
    for (let at = s.indexOf(phrase); at !== -1; at = s.indexOf(phrase, at + 1)) {
      const clause = s.slice(0, at).split(CLAUSE_BREAK).pop() ?? '';
      if (!NEGATION.test(clause.trim().split(/\s+/).slice(-12).join(' '))) return true;
    }
    return false;
  }));
}

async function checkAnswer(q: TestQuery, matchedHandles: string[] = [], retryOnRateLimit = true): Promise<AnswerCheckResult> {
  const { query, surface, max_length_chars: maxLengthChars } = q;
  const mustMention = q.must_mention ?? [];
  const mustNotMention = q.must_not_mention ?? [];
  const matchedContent = loadMatchedContent(matchedHandles).content;
  // Production order (buildSystemBlocks): products, then the surface posture, then articles.
  const base = surface ? `${ANSWER_SYSTEM_CONTEXT}\n\n---\n\n${POSTURES.get(surface)}` : ANSWER_SYSTEM_CONTEXT;
  const system = matchedContent
    ? `${base}\n\n---\n\n## Referenced Blog Articles\n\n${matchedContent}`
    : base;
  const body = {
    ...modelParams(ANSWER_MODEL, CHAT_MAX_TOKENS, CHAT_EFFORT),
    system,
    tools: CHAT_EDIT_TOOLS, // as production: the tools change what the model writes
    messages: [{ role: 'user', content: query }],
  };

  // As production (callAnthropicWithUsage): thinking makes an answer take 10-20 s.
  const res = await postMessages(body, 60_000);
  if (typeof res === 'string') {
    // Count it: a majority vote could otherwise hide one timeout and exit green.
    apiErrorCount++;
    process.stdout.write(` [api-error ${res}]`);
    return { passed: false, failures: [`API error ${res}`], response: '' };
  }

  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return checkAnswer(q, matchedHandles, false);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body.slice(0, 200).replace(/\s+/g, ' ');
    apiErrorCount++;
    process.stdout.write(` [api-error ${res.status}]`);
    return { passed: false, failures: [`API error ${res.status}: ${detail}`], response: '' };
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; stop_details?: { category?: string } | null };
  if (data.stop_reason === 'refusal') {
    return { passed: false, failures: [`refusal (${data.stop_details?.category ?? 'no category'})`], response: '' };
  }
  // Thinking blocks come first on Sonnet; join every text block, as production does.
  const response = (data.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
  const lower = response.toLowerCase();

  const failures: string[] = [];
  for (const term of mustMention) {
    if (!lower.includes(term.toLowerCase())) failures.push(`missing: "${term}"`);
  }
  for (const term of claimed(response, q.must_not_claim ?? [])) failures.push(`claimed: "${term}"`);
  for (const term of mustNotMention) {
    if (lower.includes(term.toLowerCase())) failures.push(`found forbidden: "${term}"`);
  }
  if (typeof maxLengthChars === 'number' && response.length > maxLengthChars) {
    failures.push(`length ${response.length} chars > cap ${maxLengthChars}`);
  }

  return { passed: failures.length === 0, failures, response };
}

async function runOne(q: TestQuery): Promise<QueryResult> {
  // A fixed-handle answer check skips the router and answers from its own handles.
  const fixed = !Array.isArray(q.expected);
  const allRuns: string[][] = [];
  for (let i = 0; !fixed && i < runs; i++) {
    const { handles } = await routeQuery(q.query);
    allRuns.push(handles);
  }
  const intersection = fixed ? q.answer_handles! : allRuns[0].filter(h => allRuns.every(run => run.includes(h)));

  let routingPassed: boolean;
  if (fixed) {
    routingPassed = true;
  } else if (q.expected.length === 0) {
    routingPassed = allRuns.every(run => run.length === 0);
  } else {
    routingPassed = q.expected.some(e => intersection.includes(e));
  }
  const forbidden = (q.must_not_route ?? []).filter(h => allRuns.some(run => run.includes(h)));
  if (forbidden.length > 0) routingPassed = false;

  let answerCheck: AnswerCheckResult | null = null;
  if (answerCheckMode && routingPassed && (q.must_mention?.length || q.must_not_mention?.length || q.must_not_claim?.length || typeof q.max_length_chars === 'number')) {
    const answerRuns: AnswerCheckResult[] = [];
    for (let i = 0; i < answerCheckRuns; i++) {
      answerRuns.push(await checkAnswer(q, intersection));
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
  return { query: q, allRuns, intersection, routingPassed, forbidden, answerCheck, passed };
}

async function runAll(): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const queue = [...suite];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift()!;
      results.push(await runOne(q));
      completed++;
      process.stdout.write(`\r  ${completed}/${suite.length} queries`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, suite.length) }, () => worker())
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
console.log(`Queries:     ${filtered.length}${fixedHandle.length ? ` + ${fixedHandle.length} fixed-handle answer checks` : ''}`);
console.log(`Runs each:   ${runs}`);
console.log(`Concurrency: ${concurrency}`);
if (answerCheckMode) console.log(`Answer model: ${ANSWER_MODEL}`);
console.log(`Threshold:   ≤${(varianceThreshold * 100).toFixed(0)}% variance\n`);

// Warm the prompt cache with one call before running the suite. First call
// creates the 80K-token cache block; subsequent calls read from it at a
// reduced ITPM rate. Without the warmup, Tier 1 accounts hit the 50K ITPM
// limit on the first real query.
if (filtered.length > 0) {
  console.log('Warming prompt cache...');
  const warmResult = await routeQuery('health', true, false);
  if (warmResult.rateLimited) {
    console.error('\nWarmup rate-limited. If on Anthropic Tier 1 (50K ITPM), wait 60s and retry.');
    process.exit(1);
  }
  console.log('Cache warmed. Running test suite.\n');
}

const t0 = Date.now();
const allResults = await runAll();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
// The router numbers cover the router suite only; fixed-handle checks report on their own line.
const results = allResults.filter(r => Array.isArray(r.query.expected));
const fixedResults = allResults.filter(r => !Array.isArray(r.query.expected));
const fixedOk = fixedResults.every(r => r.passed);
// Fixed-handle checks gate the exit code only when run on their own (see the header).
const fixedGateOk = !fixedHandlesOnly || fixedOk;

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
if (apiErrorCount > 0) console.log(`${RED}⚠ ${apiErrorCount} API calls errored and scored as ∅ — this run's numbers are NOT trustworthy${RESET}\n`);
console.log(`Total:       ${results.length}`);
console.log(`${GREEN}Passing:     ${passed.length}${RESET}`);
console.log(`${RED}Failing:     ${failed.length}${RESET}`);

const passOk = results.length === 0 || passRate >= 0.9;
const varOk = results.length === 0 || varRate <= varianceThreshold;
if (results.length > 0) {
  console.log(`Pass rate:   ${BOLD}${(passRate * 100).toFixed(1)}%${RESET} ${passOk ? `${GREEN}✓${RESET}` : `${RED}✗ need ≥90%${RESET}`}`);
  console.log(`Variance:    ${BOLD}${(varRate * 100).toFixed(1)}%${RESET} ${varOk ? `${GREEN}✓${RESET}` : `${RED}✗ max ${(varianceThreshold * 100).toFixed(0)}%${RESET}`}`);
  console.log(summaryLine('router', ROUTER_MODEL, thinkingOff, passed.length, results.length, callStats, apiErrorCount));
}
if (fixedResults.length > 0) {
  const n = fixedResults.filter(r => r.passed).length;
  console.log(`Fixed-handle answer checks: ${BOLD}${n}/${fixedResults.length}${RESET} ${fixedOk ? `${GREEN}✓${RESET}` : fixedHandlesOnly ? `${RED}✗ all must pass${RESET}` : `${YELLOW}✗ reported, not gating (gates under --fixed-handles-only)${RESET}`}`);
}

console.log(`\n${BOLD}--- By category ---${RESET}`);
for (const [cat, stats] of Object.entries(byCategory).sort((a, b) => b[1].fail - a[1].fail)) {
  const total = stats.pass + stats.fail;
  const rate = (stats.pass / total * 100).toFixed(0);
  const colour = stats.fail === 0 ? GREEN : (stats.pass === 0 ? RED : YELLOW);
  console.log(`  ${colour}${cat.padEnd(20)} ${stats.pass}/${total} (${rate}%)${RESET}`);
}

const failedAll = [...failed, ...fixedResults.filter(r => !r.passed)];
if (failedAll.length > 0) {
  console.log(`\n${BOLD}${RED}--- Failing queries ---${RESET}`);
  for (const r of failedAll) {
    console.log(`\n${RED}✗${RESET} ${BOLD}[${r.query.category}]${RESET} "${r.query.query}"${r.query.surface ? ` (${r.query.surface})` : ''}`);
    for (const h of r.forbidden) console.log(`    ${RED}✗ routed forbidden handle ${h}${RESET}`);
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
  for (const r of [...passed, ...fixedResults.filter(r => r.passed)]) {
    const top = r.intersection[0] ?? r.allRuns[0]?.[0] ?? '(router-empty)';
    console.log(`${GREEN}✓${RESET} [${r.query.category}] "${r.query.query}"${r.query.surface ? ` (${r.query.surface})` : ''} → ${top}`);
  }
}

console.log();
// Any errored API call makes the run's numbers untrustworthy — never exit green.
process.exit(passOk && varOk && fixedGateOk && apiErrorCount === 0 ? 0 : 1);
