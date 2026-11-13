// The router harness's setup (tools/test-chatbot-matching.ts): CLI args, the API key, the shared
// sources (answer context, router index and prompt), the fixtures and their checks, and --estimate.
// Everything here runs at load, in this order, before any API call; a bad fixture exits.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CHAT_MODEL, ROUTER_MODEL as PRODUCTION_ROUTER_MODEL, getArg as getArgOf, type CallStat } from '../packages/health-core/src/models';
import { loadBlogArticle, loadMatchedContent } from '../app/lib/matched-content';
import { routerView, routerIndexBlock, ROUTER_SUMMARY_MAX_CHARS } from '../app/lib/router-view';
import type { BlogIndexEntry } from '../app/lib/blog-index.server';
import { loadSurfaces } from './chatbot-surfaces';
import { estimateRunCost } from './harness-answers';
import { EMPTY_CHAT_CONTEXT, buildSystemBlocks, resolveChatContext } from '../app/lib/chat.server';
import { healthInputSchema } from '../packages/health-core/src/validation';
import { PRODUCTS_BLOCK_FILES } from '../app/lib/chat-products-block';

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

export const runs = Math.max(1, parseInt(getArg('--runs', '3'), 10));
export const varianceThreshold = parseFloat(getArg('--variance-threshold', '0.05'));
// Default concurrency 1: the 80K-token index counts toward ITPM on cold cache.
// Five concurrent cold requests each recreate the cache = 400K tokens/min, blows
// the Tier 1 50K ITPM limit. Post-warmup, cache reads consume ITPM at a reduced
// rate, so --concurrency 3 is usually safe; bump manually if runs feel slow.
export const concurrency = Math.max(1, parseInt(getArg('--concurrency', '1'), 10));
export const verbose = args.includes('--verbose');
const categoryFilter = args.includes('--category') ? getArg('--category', '') : null;
const sourceFilter = args.includes('--source') ? getArg('--source', '') : null;
// When set, entries with must_mention/must_not_mention/max_length_chars also call
// the main LLM to verify generated content, with the system production's
// buildSystemBlocks builds, matched blog content included (US-15 AC24a). Runs --answer-check-runs times (default = --runs,
// usually 3) and requires majority pass. Set --answer-check-runs 1 to cut API spend.
export const fixedHandlesOnly = args.includes('--fixed-handles-only');
const includePending = args.includes('--include-pending');
export const answerCheckMode = args.includes('--answer-check') || fixedHandlesOnly;
export const answerCheckRuns = Math.max(1, parseInt(getArg('--answer-check-runs', String(runs)), 10));
// --estimate: price the run and exit before any API call (Brad 2026-11-10).
const estimateOnly = args.includes('--estimate');

// Prefer ANTHROPIC_TEST_API_KEY if set — keeps harness spend isolated from
// production billing. Falls back to ANTHROPIC_API_KEY for backward compatibility.
export const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey && !estimateOnly) {
  console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}
const usingTestKey = !!process.env.ANTHROPIC_TEST_API_KEY;
if (!estimateOnly) console.log(`Using ${usingTestKey ? 'ANTHROPIC_TEST_API_KEY (test workspace)' : 'ANTHROPIC_API_KEY (production key — billing shared with prod)'}`);

// ---------------------------------------------------------------------------
// Answer-check context: production's buildSystemBlocks builds every answer call's system
// (checkAnswer, US-15 AC24a), from the files it reads at import. Production answers with a
// block missing; a paid run must not, so a missing file exits here.
// User data comes only from a fixture's made-up user_context (see the header).
// ---------------------------------------------------------------------------

// --answer-model qualifies a candidate answer model; the body shape follows its family.
export const ANSWER_MODEL = getArg('--answer-model', CHAT_MODEL);

const ANSWER_FILES = ['app/lib/chat-system-prompt.md', 'health_roadmap_algorithm.md', ...Object.values(PRODUCTS_BLOCK_FILES)];
const readable = (f: string) => { try { return fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8').trim() !== ''; } catch { return false; } };
if (answerCheckMode && !ANSWER_FILES.every(readable)) {
  console.error(`Error: --answer-check requires ${ANSWER_FILES.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared sources — read the same files chat-router.server.ts uses
// ---------------------------------------------------------------------------

// --model A/Bs a candidate router against the production pin. Thinking is
// off by default, as production; --effort-low is the candidate arm (Sonnet 5
// family only, modelParams in health-core models.ts; --thinking-off is the
// default, kept as an explicit flag). Stats cover suite calls only; the
// warmup call is excluded.
export const ROUTER_MODEL = getArg('--model', PRODUCTION_ROUTER_MODEL);
export const thinkingOff = !args.includes('--effort-low');
export const callStats: CallStat[] = [];
export const answerStats: CallStat[] = [];

// --index <path> overrides the index the ROUTER sees, so an experimental index
// (e.g. summary-capped) can be A/B'd against production without touching
// docs/blog/index.json. Matched-article loading still reads the real .md files.
const indexPathArg = args.includes('--index') ? getArg('--index', '') : null;
const INDEX_PATH = indexPathArg
  ? path.resolve(indexPathArg)
  : path.join(REPO_ROOT, 'docs/blog/index.json');

// The router's view, through the production function (US-50 AC3): a hidden post
// whose masters are up to date leaves the allow-list, the index block and the count.
// Fixture handles are checked against the full index; hidden ones are reported.
export const FULL_INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')) as BlogIndexEntry[];
export const FULL_HANDLES = new Set(FULL_INDEX.map(e => e.handle));
export const BLOG_INDEX: BlogIndexEntry[] = routerView(FULL_INDEX);

export const VALID_HANDLES = new Set(BLOG_INDEX.map(e => e.handle));

// --summary-cap overrides ROUTER_SUMMARY_MAX_CHARS (router-view.ts) so
// alternative caps can be A/B'd without editing the index.
const SUMMARY_CAP = args.includes('--summary-cap') ? parseInt(getArg('--summary-cap', String(ROUTER_SUMMARY_MAX_CHARS)), 10) : ROUTER_SUMMARY_MAX_CHARS;

// Mirrors repairHandle() in app/lib/chat-router.server.ts — strips a leading
// `<type>-` when the remainder is a real handle (the router emits
// `guideline-diet` for `diet`). Duplicated because tsx can't import the server
// module; keep the two in sync. Without it the harness under-reports the real
// pass rate, which is exactly what happened on the protein queries.
export function repairHandle(h: string): string {
  if (VALID_HANDLES.has(h)) return h;
  for (const t of ['guideline', 'reference', 'article']) {
    if (h.startsWith(`${t}-`)) {
      const stripped = h.slice(t.length + 1);
      if (VALID_HANDLES.has(stripped)) return stripped;
    }
  }
  return h;
}

export const ROUTER_INDEX_BLOCK = routerIndexBlock(BLOG_INDEX, SUMMARY_CAP);

// {{ENTRY_COUNT}} substitution must mirror chat-router.server.ts getRouterPrompt().
// Without it the harness would send the literal placeholder to the model and
// stop being a faithful test of production.
export const ROUTER_PROMPT = fs
  .readFileSync(path.join(REPO_ROOT, 'app/lib/chat-router-prompt.md'), 'utf-8')
  .replace(/\{\{ENTRY_COUNT\}\}/g, String(BLOG_INDEX.length));

// ---------------------------------------------------------------------------
// Load test queries
// ---------------------------------------------------------------------------

export interface TestQuery {
  query: string;
  expected: string[];
  category: string;
  source?: string;
  notes?: string;
  must_not_route?: string[];   // handles no run may return (see the header)
  must_mention?: string[];     // answer must contain ALL of these (case-insensitive)
  must_not_mention?: string[]; // answer must contain NONE of these (case-insensitive)
  must_not_claim?: string[];   // no un-negated sentence may hold these (see the header)
  must_match?: string[];       // regexes the answer must each match (see the header)
  must_not_match?: string[];   // regexes the answer must not match (see the header)
  max_length_chars?: number;   // answer must be at most this many characters
  answer_handles?: string[];   // fixed-handle answer check, no `expected` (see the header)
  surface?: 'doctor' | 'brand' | 'youtube'; // answer check adds that surface's posture block (see the header)
  saved_chat?: 'none' | 'question-rows' | 'transcript' | 'discord' | 'youtube'; // and its SAVED-CHAT block (see the header)
  youtube_video?: string;      // with surface 'youtube': the video's companion post (see the header)
  user_context?: unknown;      // answer check sends this widget payload as the user's data (see the header)
  expect_no_plan?: true;       // user_context makes no plan: no usable height (see the header)
  expect_roadmap_run?: boolean; // the answer must (true) or must not (false) call run_roadmap (see the header)
  expect_profile_edit?: { sex?: 'male' | 'female'; heightCm?: number }; // the reply proposes saving these (see the header)
  history?: Array<{ role: 'user' | 'assistant'; content: string }>; // earlier turns, before the query (see the header)
  pending?: string;            // listed, not run, unless --include-pending (see the header)
}

const LOADED_QUERIES: TestQuery[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-queries.json'), 'utf-8')
);
// A pending entry waits on content (e.g. an unmerged master). It is dropped here,
// before any validation below, so an invalid one never stops a run; it is listed later.
const ALL_QUERIES = includePending ? LOADED_QUERIES : LOADED_QUERIES.filter(q => !q.pending);

// Classifier-only entries (test-classifier.ts) live in the same file but
// have no `expected` handles array — exclude them from the router suite.
export let filtered = fixedHandlesOnly ? [] : ALL_QUERIES.filter(q => Array.isArray(q.expected));
// Fixed-handle answer checks never join the router suite: no `expected`, so the
// filter above skips them; they run only under --answer-check.
export let fixedHandle = answerCheckMode ? ALL_QUERIES.filter(q => !Array.isArray(q.expected) && Array.isArray(q.answer_handles)) : [];
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
const unknownForbidden = filtered.flatMap(q => (q.must_not_route ?? []).filter(h => !FULL_HANDLES.has(h)));
if (unknownForbidden.length > 0) {
  console.error(`must_not_route names handles not in the index: ${unknownForbidden.join(', ')}`);
  process.exit(1);
}
// A surface the harness cannot load, or a YouTube fixture production could never send, would score a prompt production never builds.
export const { postures: POSTURES, videos: YOUTUBE_VIDEOS, savedChats: SAVED_CHATS } = loadSurfaces(REPO_ROOT, ALL_QUERIES);
// A payload that makes no plan, or silently loses a key or a value, would score a context the fixture never meant.
const CONTEXT_KEYS = new Set([...Object.keys(healthInputSchema.shape), 'unitSystem', 'medications', 'screenings', 'measurementHistory']);
export const USER_CONTEXTS = new Map<TestQuery, string>();
for (const q of ALL_QUERIES.filter(q => q.user_context !== undefined)) {
  // Production always sends a posture with the user's data; without one the answer is not production's.
  if (q.surface === undefined) {
    console.error(`user_context needs a surface on: ${q.query}`);
    process.exit(1);
  }
  // As /api/chat. Only an explicit {} may resolve to the empty context, and only a payload
  // declared expect_no_plan to a context with no cards.
  const ctx = resolveChatContext(q.user_context);
  const empty = JSON.stringify(q.user_context) === '{}';
  const noPlan = !empty && !('currentSuggestions' in JSON.parse(ctx.userContextJson));
  const unknown = Object.keys(q.user_context ?? {}).filter(k => !CONTEXT_KEYS.has(k));
  if ((ctx === EMPTY_CHAT_CONTEXT) !== empty || noPlan !== (q.expect_no_plan === true) || unknown.length > 0
    || JSON.parse(ctx.userContextJson).excludedFields) {
    console.error(`user_context does not parse${unknown.length ? ` (unknown keys: ${unknown.join(', ')})` : ''} on: ${q.query}`);
    process.exit(1);
  }
  USER_CONTEXTS.set(q, ctx.userContextJson);
}
// A history the widget could never send would score a conversation production never has.
const badHistory = ALL_QUERIES.filter(q => q.history !== undefined && !(Array.isArray(q.history) && q.history.length % 2 === 0
  && q.history.every((m, i) => m && m.role === (i % 2 === 0 ? 'user' : 'assistant') && typeof m.content === 'string' && m.content.length > 0)));
if (badHistory.length > 0) {
  console.error(`history must alternate user and assistant text, ending on the assistant, on: ${badHistory.map(q => q.query).join(', ')}`);
  process.exit(1);
}
// A profile check that names no field, or a field the tool cannot carry, could never fail or never pass.
const badProfile = ALL_QUERIES.filter(q => q.expect_profile_edit !== undefined && !(
  q.expect_profile_edit && typeof q.expect_profile_edit === 'object' && Object.keys(q.expect_profile_edit).length > 0
  && Object.entries(q.expect_profile_edit).every(([k, v]) => (k === 'sex' && (v === 'male' || v === 'female')) || (k === 'heightCm' && typeof v === 'number'))));
if (badProfile.length > 0) {
  console.error(`expect_profile_edit must name sex (male or female) and/or heightCm (a number), on: ${badProfile.map(q => q.query).join(', ')}`);
  process.exit(1);
}
// A regex that cannot compile would throw mid-run, after money is spent.
const badRegex = ALL_QUERIES.flatMap(q => [...q.must_match ?? [], ...q.must_not_match ?? []].filter(r => {
  try { new RegExp(r); return false; } catch { return true; }
}));
if (badRegex.length > 0) {
  console.error(`must_match / must_not_match regexes that do not compile: ${badRegex.join(', ')}`);
  process.exit(1);
}
// --category takes a comma list, so several categories share one run and one cache warmup.
const categories = categoryFilter?.split(',');
const selected = (q: TestQuery) => (!categories || categories.includes(q.category)) && (!sourceFilter || q.source === sourceFilter);
filtered = filtered.filter(selected);
fixedHandle = fixedHandle.filter(selected);
// The pending entries this run would have held: listed, never scored.
const pending = LOADED_QUERIES.filter(q => !ALL_QUERIES.includes(q) && selected(q)
  && (Array.isArray(q.expected) ? !fixedHandlesOnly : answerCheckMode && Array.isArray(q.answer_handles)));
if (pending.length > 0) {
  console.log(`\x1b[33mPending (skipped; --include-pending runs them): ${pending.length}\x1b[0m`);
  for (const q of pending) console.log(`\x1b[33m  [${q.category}] "${q.query}": ${q.pending}\x1b[0m`);
}
export const suite = [...filtered, ...fixedHandle];

if (suite.length === 0 && pending.length > 0) process.exit(0);
if (suite.length === 0) {
  const desc = [categoryFilter && `category "${categoryFilter}"`, sourceFilter && `source "${sourceFilter}"`].filter(Boolean).join(' AND ');
  console.error(`No queries match ${desc}`);
  process.exit(1);
}

/** Under --answer-check, a case whose answer is also scored (when its routing passes). */
export function hasAnswerCheck(q: TestQuery): boolean {
  return answerCheckMode && !!(q.must_mention?.length || q.must_not_mention?.length || q.must_not_claim?.length || q.must_match?.length
    || q.must_not_match?.length || typeof q.max_length_chars === 'number' || q.expect_roadmap_run !== undefined || q.expect_profile_edit);
}

if (estimateOnly) {
  // Routed cases are priced as if routing passes and loads their expected handles, on production's cached base blocks.
  const answerCachedChars = buildSystemBlocks(EMPTY_CHAT_CONTEXT.userContextJson, { savedChat: '' })
    .reduce((n, b) => n + (b.cache_control ? b.text.length : 0), 0);
  const answerCallChars = suite.filter(hasAnswerCheck).flatMap(q => {
    const chars = q.query.length
      + (loadMatchedContent(Array.isArray(q.expected) ? q.expected : q.answer_handles!).content ?? '').length;
    return Array<number>(answerCheckRuns).fill(chars);
  });
  const routerCalls = filtered.length ? filtered.length * runs + 1 : 0;
  const cost = estimateRunCost({ routerCalls, routerPromptChars: ROUTER_PROMPT.length + ROUTER_INDEX_BLOCK.length, answerCachedChars, answerCallChars });
  console.log(`ESTIMATE router calls=${routerCalls} $${cost.router.toFixed(2)}; answer calls=${answerCallChars.length} up to $${cost.answer.toFixed(2)}; total up to $${cost.total.toFixed(2)}. No API call made.`);
  process.exit(0);
}
