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
 * follow it). It reads from process.cwd(): run from the repo root. The router
 * view and its index block come from app/lib/router-view.ts, as in production.
 *
 * Each query runs N times; pass = at least one expected handle appears in
 * the intersection of all runs (consistently returned across retries).
 * Acceptance bar: pass rate ≥ 90%, variance ≤ 5%.
 *
 * Fixture fields (tools/test-queries.json; router entries carry `expected`):
 *   expected: string[]        handles; any one in the intersection passes ([] = must route nothing)
 *   must_not_route?: string[] handles the case must NEVER get: one in ANY run fails the case,
 *                             reported "✗ routed forbidden handle X". `expected` cannot fail an
 *                             extra handle (2026-09-29: anticoagulant entries leaked next to the
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
 *                             must fit MAX_BLOG_CHARS (160K), or the harness exits before any API call.
 *   must_not_claim?: string[]  answer check only: a phrase stated as fact fails. A negation (no, not,
 *                             never, cannot, without, nor, nothing, none, neither, n't) excuses it only
 *                             within the 12 words before it and inside its clause (a semicolon, dash,
 *                             "but" or "and" ends the clause; a comma or "or" does not, so "claims
 *                             can't be made, including that it lowers X" and "not X or Y" stay
 *                             negated). So "it makes no claim that it can lower blood pressure"
 *                             passes; "it has no sugar and can lower blood pressure" fails.
 *                             Affirming idioms ("no doubt", "not only", "no wonder", "no question",
 *                             "without doubt", "none other than") never count as a negation.
 *                             Markdown * and _ are stripped, curly quotes straightened. A heuristic:
 *                             keep the phrases claim-shaped.
 *   must_match?: string[]      answer check only: regexes that must each match, and must_not_match?:
 *                             string[] regexes none may match. Both run on the answer as must_not_claim
 *                             sees it (lower case, straight quotes, no markdown * or _). For a claim a
 *                             phrase list cannot pin down, such as whose order a first step belongs to.
 *                             A regex that does not compile exits the harness before any API call.
 *   surface?: 'doctor' | 'brand' | 'youtube'  answer check only: the posture block, or for 'youtube'
 *                             the YouTube bot's whole prompt, with youtube_video; saved_chat? (C1). See tools/chatbot-surfaces.ts.
 *   user_context?: object      answer check only: the raw payload a widget sends as the chat's context
 *                             (chatContextOf's shape: form fields, unitSystem, medications, screenings).
 *                             It goes through production's resolveChatContext, and the answer call
 *                             gets it in production's buildSystemBlocks (as every answer call does,
 *                             US-15 AC24a) with the fixture's posture, which it must name: the widget's is
 *                             'doctor'. An explicit {} is production's empty context ('{}', no data
 *                             entered). Any other payload that makes no plan undeclared, has a key the
 *                             widget never sends, or loses a field to its range exits the harness before
 *                             any API call.
 *   expect_no_plan?: true      with user_context: this payload makes no plan (no usable height; US-07 AC8), and the
 *                             answer gets the saved values with no cards, as production sends them
 *                             (US-15 AC36). A payload that does make a plan then exits the harness before
 *                             any API call.
 *   history?: {role, content}[]  answer check only: earlier turns of the conversation, sent before the
 *                             query as the widget sends its history: alternating user and assistant
 *                             text, from a user turn to an assistant one. Any other shape exits the
 *                             harness before any API call.
 *   pending?: string           the reason the entry is not run yet (e.g. its content is unmerged). Listed,
 *                             never run or scored, unless --include-pending is passed.
 *   expect_roadmap_run?: boolean  answer check only: the answer must (true) or must not (false) call
 *                             run_roadmap. Every answer runs production's one-round loop (health-core
 *                             withRoadmapRound, US-15 AC33) on the fixture's raw user_context, and is
 *                             scored on the second call's text when the tool ran.
 *   expect_profile_edit?: {sex?, heightCm?}  answer check only (US-16 AC2): the reply must propose
 *                             saving these, through production's parser: its propose_profile_edit
 *                             calls, merged as the widget merges them (a later field wins), must hold
 *                             each stated field (height in cm, to 0.1). A reply with no text is scored
 *                             on production's toolOnlyAck line, as the widget shows it. Any other
 *                             shape exits the harness before any API call.
 *
 * A fetch that throws (timeout, DNS, reset) counts as an API error, like a non-2xx:
 * visible, scored as ∅, and the run continues but never exits green. So does a
 * router reply with no JSON object that parses (US-15 AC28).
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
 *   npx tsx tools/test-chatbot-matching.ts <any flags above> --estimate   # price the run, make no API call
 *
 * Every live run costs money from the same credits as production. Brad 2026-11-10: no run without
 * his yes, and give him the --estimate figure first. A run prints SUMMARY lines with the actual
 * cost: one for the router, one for the answer calls.
 *
 * --answer-check: for entries with must_mention/must_not_mention/max_length_chars,
 * also calls the main LLM (CHAT_MODEL; --answer-model overrides) with the system production's buildSystemBlocks
 * builds (US-15 AC24a): the cached base blocks, the posture, the user data ('{}' with no user_context) and the
 * matched blog content loaded from the handles the router returned, or from `answer_handles`. The check runs N times
 * (matching --answer-check-runs, default = --runs) and requires majority pass so
 * a single stochastic blip doesn't flip the test. Loads user data only from a fixture's user_context.
 *
 * COST DISCIPLINE — read this before iterating, the audit cycle of 2026-05-14/15
 * burned ~$30 because of these mistakes:
 *   - DEFAULT TO --category WHEN ITERATING. A full suite re-run is 30 queries × 4+
 *     LLM calls = 120+ calls. A single --category run is 1-3 queries. 30-50x
 *     cheaper per iteration. Only run the full suite at end-of-session.
 *   - DEFAULT TO --answer-check-runs 1 WHEN ITERATING. The default 3 triples
 *     answer-check cost. Only use 3 for the final verification.
 *   - READ THE BOT'S RESPONSE BEFORE RE-EDITING TESTS. A failing answer check
 *     prints the last run's answer in full; never rerun just to see it. Rewriting must_mention/must_not_mention
 *     blindly leads to multiple re-runs that each cost real money.
 *   - EDITING THE SYSTEM PROMPT INVALIDATES THE 1-HOUR ANTHROPIC PROMPT CACHE.
 *     Every re-run after a prompt edit pays cache-write price (2x base) instead
 *     of cache-read (0.10x base). Batch prompt edits where possible.
 *
 * Exit code 0 if acceptance bar met, 1 otherwise.
 */

// Setup runs at load (test-chatbot-matching-setup.ts), then the calls module (test-chatbot-matching-calls.ts).
import { summaryLine } from '../packages/health-core/src/models';
import { apiErrorCount, routeQuery, runAll } from './test-chatbot-matching-calls';
import {
  ANSWER_MODEL, BLOG_INDEX, FULL_HANDLES, ROUTER_MODEL, VALID_HANDLES, answerCheckMode, answerStats, callStats, concurrency,
  filtered, fixedHandle, fixedHandlesOnly, runs, thinkingOff, varianceThreshold, verbose,
} from './test-chatbot-matching-setup';

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
// A handle the router view hides can never be returned: report it, never exit (US-50 AC3).
const hiddenIn = (key: 'expected' | 'must_not_route') =>
  [...new Set(filtered.flatMap(q => q[key] ?? []).filter(h => FULL_HANDLES.has(h) && !VALID_HANDLES.has(h)))].join(', ') || 'none';
if (hiddenIn('expected') !== 'none' || hiddenIn('must_not_route') !== 'none') {
  console.log(`${YELLOW}Hidden by the router view (US-50 AC3): expected ${hiddenIn('expected')}; must_not_route ${hiddenIn('must_not_route')}${RESET}\n`);
}

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
if (apiErrorCount > 0) console.log(`${RED}⚠ ${apiErrorCount} API calls errored or did not parse, scored as ∅ — this run's numbers are NOT trustworthy${RESET}\n`);
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
// The answer calls' own line, so a run's whole cost is on screen (Brad 2026-11-10).
const checked = allResults.filter(r => r.answerCheck);
if (answerStats.length > 0) console.log(summaryLine('answer', ANSWER_MODEL, false, checked.filter(r => r.answerCheck!.passed).length, checked.length, answerStats, apiErrorCount));
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
      // In full, every time: a rerun just to read the answer costs money (Brad 2026-11-10).
      console.log(`    Response (last run):\n${GREY}${r.answerCheck.response.replace(/^/gm, '      ')}${RESET}`);
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
// Exit only after stdout drains: process.exit() drops what a full pipe (64 KB) has not yet delivered,
// which cut the last failures from a long report on a loaded CI runner (deploy run 39484726768).
const exitCode = passOk && varOk && fixedGateOk && apiErrorCount === 0 ? 0 : 1;
process.stdout.write('', () => process.exit(exitCode));
