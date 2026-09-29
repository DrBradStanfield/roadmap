#!/usr/bin/env tsx
/**
 * Chat tool-use (form-edit) regression harness.
 *
 * The chatbot can pre-fill the user's Health Roadmap form by emitting Anthropic
 * `tool_use` blocks (`propose_field_edit` / `propose_medication_edit`, shipped
 * in commit e9cc7bf). The existing router harness (test-chatbot-matching.ts)
 * runs the chat WITHOUT tools enabled, so it can't validate this behaviour.
 *
 * This harness calls the SAME main-LLM path the production chat uses — the
 * chat system prompt (which carries the tool-use instructions) + `tools:
 * CHAT_EDIT_TOOLS` — and asserts the model emits the CORRECT structured intent
 * by running the production parser `parseProposedEdits()` over the returned
 * content blocks. It checks the PARSED intent (field/value/unit/date), not
 * fuzzy text, so it can never drift from what the widget actually applies.
 *
 * Reused from test-chatbot-matching.ts (extend, don't fork): the API-key
 * resolution (ANTHROPIC_TEST_API_KEY first), the 429 retry-after backoff, the
 * worker-pool concurrency, the majority-of-N stochastic guard, and the
 * coloured pass/fail + exit-code reporting. Only the request body (tools on)
 * and the assertion (structured-intent vs router-handle) differ.
 *
 * Each query runs N times; a case passes if a MAJORITY of runs match the
 * expectation (the answer model thinks adaptively and is stochastic, so one
 * blip shouldn't flip a case).
 *
 * Usage:
 *   npx tsx tools/test-tool-edits.ts
 *   npx tsx tools/test-tool-edits.ts --runs 3 --verbose
 *   npx tsx tools/test-tool-edits.ts --name medication-statin
 *   npx tsx tools/test-tool-edits.ts --model <candidate id>   # default: CHAT_MODEL
 *
 * COST DISCIPLINE: this calls the real production answer model. Keep the fixture small and
 * prefer --name <case> when iterating on one case.
 *
 * Exit code 0 if every case passes, 1 otherwise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CHAT_EDIT_TOOLS,
  parseProposedEdits,
  type ProposedEdit,
} from '../packages/health-core/src/chat-edits';
import { CHAT_EFFORT, CHAT_MAX_TOKENS, CHAT_MODEL, PROMPT_CACHE, getArg as getArgOf, modelParams } from '../packages/health-core/src/models';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args (mirrors test-chatbot-matching.ts)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (flag: string, defaultValue: string) => getArgOf(args, flag, defaultValue);
// Production's answer model by default; --model qualifies a candidate with its family's body shape.
const MODEL = getArg('--model', CHAT_MODEL);

const runs = Math.max(1, parseInt(getArg('--runs', '3'), 10));
// Concurrency 2 keeps us under the Tier-1 ITPM limit (see CLAUDE.md/memory).
const concurrency = Math.max(1, parseInt(getArg('--concurrency', '2'), 10));
const verbose = args.includes('--verbose');
const nameFilter = args.includes('--name') ? getArg('--name', '') : null;

// Prefer ANTHROPIC_TEST_API_KEY — keeps harness spend off production billing.
const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}
const usingTestKey = !!process.env.ANTHROPIC_TEST_API_KEY;
console.log(`Using ${usingTestKey ? 'ANTHROPIC_TEST_API_KEY (test workspace)' : 'ANTHROPIC_API_KEY (production key — billing shared with prod)'}`);

// ---------------------------------------------------------------------------
// System prompt — the production chat system prompt carries the tool-use rules
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(REPO_ROOT, 'app/lib/chat-system-prompt.md'), 'utf-8',
);

// ---------------------------------------------------------------------------
// Expectation shapes (from test-tool-edits.json)
// ---------------------------------------------------------------------------

interface ExpectedFieldEdit {
  kind: 'field';
  field: string;
  displayValue: number;
  unitSystem: string;
  date?: string;
}
interface ExpectedMedicationEdit {
  kind: 'medication';
  medicationKey: string;
  drugName: string;
  doseValue?: number;
  doseUnit?: string;
}
type ExpectedEdit = ExpectedFieldEdit | ExpectedMedicationEdit;

interface TestCase {
  name: string;
  query: string;
  category: string;
  notes?: string;
  expect: {
    edits: ExpectedEdit[];
    unordered?: boolean;        // true: match edits as a set, not by position
    mustAskClarifying?: boolean; // negative-ambiguous: prose should ask for the unit
  };
}

let CASES: TestCase[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-tool-edits.json'), 'utf-8'),
);
if (nameFilter) CASES = CASES.filter(c => c.name === nameFilter);
if (CASES.length === 0) {
  console.error(`No cases match --name "${nameFilter}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Anthropic call — same model fields as getChatCompletion (tools enabled)
// ---------------------------------------------------------------------------

interface ContentBlock { type: string; name?: string; input?: unknown; text?: string }

interface ChatRunResult {
  edits: ProposedEdit[];
  text: string;
}

async function runChat(query: string, retryOnRateLimit = true): Promise<ChatRunResult> {
  const body = {
    ...modelParams(MODEL, CHAT_MAX_TOKENS, CHAT_EFFORT),
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: PROMPT_CACHE }],
    tools: CHAT_EDIT_TOOLS,
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
    signal: AbortSignal.timeout(60_000), // as production: adaptive thinking takes 10-20 s
  });

  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return runChat(query, false);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`API error ${res.status}: ${detail}`);
  }

  const data = await res.json() as { content?: ContentBlock[]; stop_reason?: string };
  // A refusal proposes nothing: score it as a failed run, not a crash.
  if (data.stop_reason === 'refusal') return { edits: [], text: '[refusal]' };
  const blocks = data.content ?? [];
  const edits = parseProposedEdits(blocks);
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').trim();
  return { edits, text };
}

// ---------------------------------------------------------------------------
// Assertion — compare parsed intent against the case expectation
// ---------------------------------------------------------------------------

/**
 * Detects a clarifying response (asking the user to confirm the unit / value)
 * rather than a silent pre-fill. Loose heuristic: it either ends a sentence
 * with "?" while naming a unit, or uses explicit confirm/clarify language about
 * the unit or value. Used for the negative cases where the model should pause.
 */
function looksLikeClarifying(text: string): boolean {
  const t = text.toLowerCase();
  const namesUnit = t.includes('mmol') || t.includes('mg/dl') || t.includes('unit');
  const asks = t.includes('?');
  const confirms = /\b(clarify|confirm|double-?check|are you sure|did you mean)\b/.test(t);
  return (asks && namesUnit) || (confirms && (namesUnit || t.includes('value')));
}

function editMatches(actual: ProposedEdit, expected: ExpectedEdit): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'field' && expected.kind === 'field') {
    return (
      actual.field === expected.field &&
      actual.displayValue === expected.displayValue &&
      actual.unitSystem === expected.unitSystem &&
      (expected.date === undefined || actual.date === expected.date)
    );
  }
  if (actual.kind === 'medication' && expected.kind === 'medication') {
    return (
      actual.medicationKey === expected.medicationKey &&
      actual.drugName.toLowerCase() === expected.drugName.toLowerCase() &&
      (expected.doseValue === undefined || actual.doseValue === expected.doseValue) &&
      (expected.doseUnit === undefined ||
        (actual.doseUnit ?? '').toLowerCase() === expected.doseUnit.toLowerCase())
    );
  }
  return false;
}

/** Returns null on pass, or a human-readable failure reason. */
function checkRun(c: TestCase, result: ChatRunResult): string | null {
  const { edits } = result;
  const exp = c.expect.edits;

  // Negative cases: assert NO edit fired.
  if (exp.length === 0) {
    if (edits.length > 0) {
      return `expected no edit, got ${edits.length}: ${JSON.stringify(edits)}`;
    }
    if (c.expect.mustAskClarifying && !looksLikeClarifying(result.text)) {
      return `expected a clarifying question, prose was: "${result.text.slice(0, 120)}"`;
    }
    return null;
  }

  // Positive cases: every expected edit must be present.
  if (edits.length !== exp.length) {
    return `expected ${exp.length} edit(s), got ${edits.length}: ${JSON.stringify(edits)}`;
  }

  if (c.expect.unordered) {
    const remaining = [...edits];
    for (const e of exp) {
      const idx = remaining.findIndex(a => editMatches(a, e));
      if (idx === -1) return `no edit matched expectation ${JSON.stringify(e)} in ${JSON.stringify(edits)}`;
      remaining.splice(idx, 1);
    }
    return null;
  }

  for (let i = 0; i < exp.length; i++) {
    if (!editMatches(edits[i], exp[i])) {
      return `edit[${i}] ${JSON.stringify(edits[i])} != expected ${JSON.stringify(exp[i])}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run each case N times, majority-of-N pass
// ---------------------------------------------------------------------------

interface CaseResult {
  case: TestCase;
  runReasons: (string | null)[]; // null = pass for that run
  passCount: number;
  passed: boolean;
  sample: ChatRunResult; // last run, for verbose output
}

async function runCase(c: TestCase): Promise<CaseResult> {
  const runReasons: (string | null)[] = [];
  let sample!: ChatRunResult;
  for (let i = 0; i < runs; i++) {
    sample = await runChat(c.query);
    runReasons.push(checkRun(c, sample));
  }
  const passCount = runReasons.filter(r => r === null).length;
  const majority = Math.floor(runs / 2) + 1;
  return { case: c, runReasons, passCount, passed: passCount >= majority, sample };
}

async function runAll(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const queue = [...CASES];
  let completed = 0;
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift()!;
      results.push(await runCase(c));
      completed++;
      process.stdout.write(`\r  ${completed}/${CASES.length} cases`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, CASES.length) }, () => worker()));
  process.stdout.write('\n');
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

console.log(`\n${BOLD}=== Chat Tool-Use (Form-Edit) Harness ===${RESET}\n`);
console.log(`Model:       ${MODEL}`);
console.log(`Cases:       ${CASES.length}`);
console.log(`Runs each:   ${runs} (majority pass)`);
console.log(`Concurrency: ${concurrency}\n`);

const t0 = Date.now();
const results = await runAll();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const passed = results.filter(r => r.passed);
const failed = results.filter(r => !r.passed);

console.log(`\n${BOLD}=== Results (${elapsed}s) ===${RESET}\n`);
console.log(`Total:    ${results.length}`);
console.log(`${GREEN}Passing:  ${passed.length}${RESET}`);
console.log(`${RED}Failing:  ${failed.length}${RESET}\n`);

// Preserve fixture order in output.
for (const c of CASES) {
  const r = results.find(x => x.case.name === c.name)!;
  const mark = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`${mark} ${BOLD}[${c.category}]${RESET} ${c.name} ${GREY}(${r.passCount}/${runs} runs)${RESET}`);
  if (!r.passed || verbose) {
    for (let i = 0; i < r.runReasons.length; i++) {
      const reason = r.runReasons[i];
      console.log(`    ${reason ? `${RED}run ${i + 1}: ${reason}${RESET}` : `${GREEN}run ${i + 1}: ok${RESET}`}`);
    }
    if (verbose) {
      console.log(`    ${GREY}query: "${c.query}"${RESET}`);
      console.log(`    ${GREY}edits: ${JSON.stringify(r.sample.edits)}${RESET}`);
      if (r.sample.text) console.log(`    ${GREY}prose: "${r.sample.text.slice(0, 160)}"${RESET}`);
    }
    if (c.notes) console.log(`    ${GREY}notes: ${c.notes}${RESET}`);
  }
}

console.log();
process.exit(failed.length === 0 ? 0 : 1);
