#!/usr/bin/env tsx
/**
 * LLM router test harness.
 *
 * Imports routeQuery directly — no replica logic. Each query runs N times
 * and passes only if the expected handle is in the intersection of all runs
 * (i.e., consistently returned). Acceptance bar: pass rate ≥ 90%, variance ≤ 5%.
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
import { routeQuery } from '../app/lib/chat-router.server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const concurrency = Math.max(1, parseInt(getArg('--concurrency', '5'), 10));
const verbose = args.includes('--verbose');
const categoryFilter = args.includes('--category') ? getArg('--category', '') : null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is not set');
  process.exit(1);
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
// Run each query N times and compute intersection of handles across all runs
// ---------------------------------------------------------------------------

interface QueryResult {
  query: TestQuery;
  allRuns: string[][];
  intersection: string[];
  passed: boolean;
}

async function runQuery(q: TestQuery): Promise<QueryResult> {
  const allRuns: string[][] = [];
  for (let i = 0; i < runs; i++) {
    const result = await routeQuery(q.query);
    allRuns.push(result.handles);
  }

  // Intersection: handles that appear in every run
  const intersection = allRuns[0].filter(h => allRuns.every(run => run.includes(h)));

  let passed: boolean;
  if (q.expected.length === 0) {
    // Out-of-scope: router must return empty on every run
    passed = allRuns.every(run => run.length === 0);
  } else {
    // At least one expected handle must be in the intersection
    passed = q.expected.some(e => intersection.includes(e));
  }

  return { query: q, allRuns, intersection, passed };
}

// ---------------------------------------------------------------------------
// Concurrency-limited runner
// ---------------------------------------------------------------------------

async function runAll(): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const queue = [...filtered];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift()!;
      results.push(await runQuery(q));
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

const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY  = '\x1b[90m';
const RESET = '\x1b[0m';

console.log(`\n${BOLD}=== LLM Router Test Harness ===${RESET}\n`);
console.log(`Queries:     ${filtered.length}`);
console.log(`Runs each:   ${runs}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Threshold:   ≤${(varianceThreshold * 100).toFixed(0)}% variance\n`);

const results = await runAll();

const passed  = results.filter(r => r.passed);
const failed  = results.filter(r => !r.passed);
const passRate = passed.length / results.length;
const varRate  = failed.length / results.length;

const byCategory: Record<string, { pass: number; fail: number }> = {};
for (const r of results) {
  if (!byCategory[r.query.category]) byCategory[r.query.category] = { pass: 0, fail: 0 };
  byCategory[r.query.category][r.passed ? 'pass' : 'fail']++;
}

console.log(`\n${BOLD}=== Results ===${RESET}\n`);
console.log(`Total:       ${results.length}`);
console.log(`${GREEN}Passing:     ${passed.length}${RESET}`);
console.log(`${RED}Failing:     ${failed.length}${RESET}`);

const passOk = passRate >= 0.9;
const varOk  = varRate <= varianceThreshold;
console.log(`Pass rate:   ${BOLD}${(passRate * 100).toFixed(1)}%${RESET} ${passOk ? `${GREEN}✓${RESET}` : `${RED}✗ need ≥90%${RESET}`}`);
console.log(`Variance:    ${BOLD}${(varRate * 100).toFixed(1)}%${RESET} ${varOk ? `${GREEN}✓${RESET}` : `${RED}✗ max ${(varianceThreshold * 100).toFixed(0)}%${RESET}`}`);

console.log(`\n${BOLD}--- By category ---${RESET}`);
for (const [cat, stats] of Object.entries(byCategory).sort((a, b) => b[1].fail - a[1].fail)) {
  const total = stats.pass + stats.fail;
  const rate  = (stats.pass / total * 100).toFixed(0);
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
