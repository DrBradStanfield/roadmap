#!/usr/bin/env node
/**
 * Test time budget (US-64 AC36). Two halves:
 *  - the default export is a vitest reporter: `--reporter=./tools/test-time-budget.mjs` writes each test file's
 *    time and each test's time and timeout to test-timing.json under vitest's root (the reporter option outputFile changes it);
 *  - `node tools/test-time-budget.mjs <report.json> [label]` prints the slowest files and a GitHub warning for a
 *    file over FILE_BUDGET_MS or a test past half its own timeout. It always exits 0: a timing gate that fails
 *    would itself be a flake source. Test names are data: they reach the log only escaped (annotation()).
 * How to read the output: docs/git-workflow.md § Test time and flake watch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 40 s: above every file on main's runners on 2026-11-21 except the two slowest (55 s and 46 s). */
export const FILE_BUDGET_MS = 40_000;
export const TIMEOUT_SHARE = 0.5;

export default class TimingReporter {
  constructor(options = {}) { this.out = options.outputFile || 'test-timing.json'; }
  onInit(ctx) { this.root = ctx.config.root; }
  async onTestRunEnd(testModules) {
    const files = testModules.map((m) => ({
      file: m.relativeModuleId,
      durationMs: Math.round(m.diagnostic().duration),
      tests: [...m.children.allTests()].map((t) => ({
        name: t.fullName,
        durationMs: Math.round(t.diagnostic()?.duration ?? 0),
        timeoutMs: t.options.timeout ?? 0,
      })),
    }));
    const file = path.resolve(this.root ?? process.cwd(), this.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ files }));
  }
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function analyse(report, { fileBudgetMs = FILE_BUDGET_MS, timeoutShare = TIMEOUT_SHARE } = {}) {
  const files = [...(report?.files ?? [])].sort((a, b) => b.durationMs - a.durationMs);
  const warnings = [];
  for (const f of files) {
    if (f.durationMs > fileBudgetMs) {
      warnings.push({ kind: 'file', file: f.file, title: 'Slow test file',
        message: `${f.file} took ${secs(f.durationMs)}, over the ${secs(fileBudgetMs)} budget per file` });
    }
  }
  for (const f of files) {
    for (const t of f.tests ?? []) {
      if (t.timeoutMs > 0 && t.durationMs > t.timeoutMs * timeoutShare) {
        warnings.push({ kind: 'test', file: f.file, title: 'Test near its timeout',
          message: `"${t.name}" took ${secs(t.durationMs)} of its ${secs(t.timeoutMs)} timeout (${Math.round((100 * t.durationMs) / t.timeoutMs)}%)` });
      }
    }
  }
  return { files, warnings };
}

export function formatTable(files, limit = 10) {
  const rows = files.slice(0, limit).map((f, i) => `| ${i + 1} | \`${f.file}\` | ${secs(f.durationMs)} | ${f.tests?.length ?? 0} |`);
  return ['| # | File | Time | Tests |', '|---|---|---|---|', ...rows].join('\n');
}

// GitHub workflow-command escaping: a name holding a newline or "::" must not start a command of its own.
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
export const annotation = (w) => `::warning file=${escProp(w.file)},title=${escProp(w.title)}::${escData(w.message)}`;

export function main(argv, env = process.env, log = console.log) {
  const [reportPath, label = 'this run'] = argv;
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) {
    log(`No timing report at ${reportPath} (${e.code ?? e.message}); the tests may not have run. Nothing to check.`);
    return 0;
  }
  const { files, warnings } = analyse(report);
  const table = formatTable(files);
  log(`Slowest test files, ${label} (budget ${secs(FILE_BUDGET_MS)} per file; a test warns past ${TIMEOUT_SHARE * 100}% of its timeout):`);
  log(table);
  for (const w of warnings) log(annotation(w));
  if (env.GITHUB_STEP_SUMMARY) {
    const list = warnings.map((w) => `- ${w.message.replace(/[\r\n]+/g, ' ')}`).join('\n');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      `### Test time: ${label}\n\n${table}\n\n${warnings.length} warnings${warnings.length ? `:\n\n${list}` : '.'}\n\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
