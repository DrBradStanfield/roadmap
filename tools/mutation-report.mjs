#!/usr/bin/env node
// Reads a Stryker JSON report, prints the per-file mutation score, and lists the
// surviving / no-coverage mutants that are NOT in the committed baseline.
// Exit 1 only when there are new survivors. `--update-baseline` rewrites the baseline.
// Mutants are keyed on file + mutator + original text + replacement + enclosing top-level
// declaration, never on line numbers (they drift). Identical keys are counted.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPORT = 'reports/mutation/mutation.json';
export const DEFAULT_BASELINE = 'docs/loops/product-health/mutation-baseline.json';
const OPEN = new Set(['Survived', 'NoCoverage']);
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var|class)\s+(\w+))/;

function offsetOf(lines, { line, column }) {
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + column - 1;
}

function enclosingDecl(lines, line) {
  for (let i = line - 1; i >= 0; i--) {
    const m = DECL.exec(lines[i]);
    if (m) return m[1] || m[2];
  }
  return '<module>';
}

/** Returns { scores: [{file, score, killed, open}], open: [{key, ...parts, line}] }. */
export function analyse(report) {
  const scores = [];
  const open = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const lines = data.source.split('\n');
    let killed = 0;
    let missed = 0;
    for (const m of data.mutants) {
      if (m.status === 'Killed' || m.status === 'Timeout') killed++;
      if (!OPEN.has(m.status)) continue;
      missed++;
      const { start, end } = m.location;
      const original = data.source.slice(offsetOf(lines, start), offsetOf(lines, end)).replace(/\s+/g, ' ').trim();
      const parts = { file, mutator: m.mutatorName, original, replacement: (m.replacement ?? '').replace(/\s+/g, ' ').trim(), fn: enclosingDecl(lines, start.line) };
      open.push({ ...parts, key: JSON.stringify([parts.file, parts.mutator, parts.fn, parts.original, parts.replacement]), line: start.line, status: m.status });
    }
    const total = killed + missed;
    scores.push({ file, killed, missed, score: total ? (killed / total) * 100 : 100 });
  }
  return { scores, open };
}

function counts(open) {
  const c = new Map();
  for (const o of open) c.set(o.key, (c.get(o.key) ?? 0) + 1);
  return c;
}

/** Mutants beyond the baseline's count for their key. */
export function newSurvivors(open, baseline) {
  const allowed = new Map(baseline.map((b) => [JSON.stringify([b.file, b.mutator, b.fn, b.original, b.replacement]), b.count]));
  const seen = new Map();
  return open.filter((o) => {
    const n = (seen.get(o.key) ?? 0) + 1;
    seen.set(o.key, n);
    return n > (allowed.get(o.key) ?? 0);
  });
}

export function buildBaseline(open) {
  const c = counts(open);
  const rows = [];
  for (const o of open) {
    if (!c.has(o.key)) continue;
    rows.push({ file: o.file, mutator: o.mutator, fn: o.fn, original: o.original, replacement: o.replacement, count: c.get(o.key) });
    c.delete(o.key);
  }
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return rows;
}

export function main(argv, io = { log: console.log, err: console.error }) {
  const update = argv.includes('--update-baseline');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const reportPath = pos[0] ?? DEFAULT_REPORT;
  const baselinePath = pos[1] ?? DEFAULT_BASELINE;
  const { scores, open } = analyse(JSON.parse(readFileSync(reportPath, 'utf8')));
  for (const s of scores) io.log(`${s.score.toFixed(1).padStart(5)}%  ${s.file}  (${s.killed} killed, ${s.missed} open)`);
  if (update) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(buildBaseline(open), null, 2) + '\n');
    io.log(`baseline updated: ${open.length} open mutants -> ${baselinePath}`);
    return 0;
  }
  let baseline = [];
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { io.err(`no baseline at ${baselinePath}: every open mutant counts as new`); }
  const fresh = newSurvivors(open, baseline);
  if (!fresh.length) { io.log('no new surviving mutants'); return 0; }
  io.log(`${fresh.length} NEW surviving mutants:`);
  for (const o of fresh) io.log(`  [${o.status}] ${o.file}:${o.line} in ${o.fn} (${o.mutator}): ${o.original}  ->  ${o.replacement}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
