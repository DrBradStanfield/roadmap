#!/usr/bin/env tsx
/**
 * Pre-router classifier test runner.
 *
 * Reads classifier test entries from tools/test-queries.json (entries with an
 * `expected_classification` field) and asserts the classifier returns the
 * expected token for each.
 *
 * Loads the prompt from app/lib/chat-classifier-prompt.md — same file the
 * server module reads — so harness and prod can never drift.
 *
 * Usage:
 *   source .env && npx tsx tools/test-classifier.ts
 *   source .env && npx tsx tools/test-classifier.ts --runs 1     # cheaper smoke test
 *
 * Pass criterion: every entry's classifier output matches expected_classification.
 * Exit 0 on full pass, 1 on any miss.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runs = Math.max(1, parseInt(args[args.indexOf('--runs') + 1] ?? '3', 10));
const concurrency = Math.max(1, parseInt(args[args.indexOf('--concurrency') + 1] ?? '2', 10));

// Prefer ANTHROPIC_TEST_API_KEY if set — keeps harness spend isolated from
// the prod key. Falls back to ANTHROPIC_API_KEY otherwise (matches
// tools/test-chatbot-matching.ts).
const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}
const usingTestKey = !!process.env.ANTHROPIC_TEST_API_KEY;
console.log(`Using ${usingTestKey ? 'ANTHROPIC_TEST_API_KEY (test workspace)' : 'ANTHROPIC_API_KEY (production key — billing shared with prod)'}`);

// ---------------------------------------------------------------------------
// Prompt + model — loaded from the same file the server module reads.
// ---------------------------------------------------------------------------

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const PROMPT_PATH = path.join(__dirname, '..', 'app', 'lib', 'chat-classifier-prompt.md');
const CLASSIFIER_PROMPT = fs.readFileSync(PROMPT_PATH, 'utf-8');

// Kept as a literal list rather than importing chat-classifier.server.ts: tsx
// can't resolve the health-core workspace package through that import chain
// (same constraint as test-chatbot-matching.ts). It therefore has to be kept in
// sync BY HAND with Classification in app/lib/chat-classifier.server.ts.
// Adding MEASUREMENT there on 2026-08-07 without updating here made the harness
// parse a correct 'MEASUREMENT' reply as ERROR — a false failure. If you add a
// label, add it in BOTH places.
type Classification = 'ROUTE' | 'GREETING' | 'PRODUCT' | 'ACCOUNT' | 'MEASUREMENT' | 'ERROR';

const VALID: ReadonlyArray<Classification> = ['ROUTE', 'GREETING', 'PRODUCT', 'ACCOUNT', 'MEASUREMENT'];

function parseClassification(raw: string): Classification {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z]/g, '') as Classification;
  return VALID.includes(cleaned) ? cleaned : 'ERROR';
}

// ---------------------------------------------------------------------------
// Single classifier call
// ---------------------------------------------------------------------------

async function callClassifier(query: string): Promise<{ classification: Classification; raw: string; latencyMs: number }> {
  const t0 = Date.now();
  const body = {
    model: CLASSIFIER_MODEL,
    max_tokens: 5,
    temperature: 0,
    system: [
      { type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: `(new conversation, no prior turns)\n\nCurrent message: ${query}\n\nClassification:` },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const raw = data.content?.find(c => c.type === 'text')?.text ?? '';
  return { classification: parseClassification(raw), raw, latencyMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Test entries
// ---------------------------------------------------------------------------

interface TestEntry {
  query: string;
  category?: string;
  source?: string;
  expected_classification?: Classification;
  notes?: string;
  [k: string]: unknown;
}

const ALL: TestEntry[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-queries.json'), 'utf-8'),
);

const TESTS = ALL.filter(e => e.expected_classification);

if (TESTS.length === 0) {
  console.error('No test entries with expected_classification in test-queries.json');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run with bounded concurrency
// ---------------------------------------------------------------------------

interface RunResult {
  test: TestEntry;
  runs: { classification: Classification; raw: string; latencyMs: number }[];
  passed: boolean;
}

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', GREY = '\x1b[90m', BOLD = '\x1b[1m';

async function runOne(t: TestEntry): Promise<RunResult> {
  const results: { classification: Classification; raw: string; latencyMs: number }[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      results.push(await callClassifier(t.query));
    } catch (err) {
      results.push({ classification: 'ERROR', raw: String(err).slice(0, 100), latencyMs: 0 });
    }
  }
  // Pass criterion: ALL runs match expected (temperature 0, should be deterministic).
  const passed = results.every(r => r.classification === t.expected_classification);
  return { test: t, runs: results, passed };
}

async function runAll(): Promise<RunResult[]> {
  const queue = [...TESTS];
  const out: RunResult[] = [];
  let done = 0;
  async function worker() {
    while (queue.length > 0) {
      const t = queue.shift();
      if (!t) break;
      const r = await runOne(t);
      out.push(r);
      done++;
      process.stdout.write(` ${done}/${TESTS.length}`);
    }
  }
  console.log(`${BOLD}=== Pre-router classifier tests ===${RESET}`);
  console.log(`Tests:       ${TESTS.length}`);
  console.log(`Runs each:   ${runs}`);
  console.log(`Concurrency: ${concurrency}\n`);
  process.stdout.write('Running...');
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log('\n');
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const results = await runAll();
const pass = results.filter(r => r.passed).length;
const fail = results.length - pass;

console.log(`${BOLD}=== Results ===${RESET}`);
console.log(`${GREEN}Passing: ${pass}/${results.length}${RESET}`);
console.log(`${fail > 0 ? RED : GREEN}Failing: ${fail}${RESET}\n`);

if (fail > 0) {
  console.log(`${BOLD}${RED}--- Failures ---${RESET}`);
  for (const r of results.filter(x => !x.passed)) {
    const got = r.runs.map(x => x.classification).join(', ');
    console.log(`${RED}✗${RESET} [${r.test.category}] "${r.test.query}"`);
    console.log(`  expected: ${r.test.expected_classification}  ·  got: ${got}`);
    if (r.runs[0]?.raw && r.runs[0].raw !== r.runs[0].classification) {
      console.log(`  ${GREY}raw output: "${r.runs[0].raw.slice(0, 60)}"${RESET}`);
    }
    if (r.test.notes) console.log(`  ${GREY}notes: ${r.test.notes}${RESET}`);
  }
  process.exit(1);
}

console.log(`${GREEN}✓ All classifier tests passed.${RESET}`);
process.exit(0);
