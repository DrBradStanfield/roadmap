#!/usr/bin/env tsx
/**
 * get_plan — the suggestion engine as a local CLI (US-30).
 *
 * US-29 published the record format, so any agent can READ health-roadmap.json.
 * This is the half only this repo can do: turn that file into Brad's actual
 * protocol — thresholds, suggestions, evidence, citations — deterministically,
 * offline. No server, no model, no network, no telemetry. The record file is
 * opened read-only and never written back.
 *
 * The pipeline itself lives in `packages/health-core/src/plan.ts`, so the MCP
 * server (US-32) computes the same plan. What is left here is the shell: argv,
 * reading the file, and the text and HTML a person reads.
 *
 * Usage:
 *   npx tsx tools/get-plan.ts <health-roadmap.json>
 *   npx tsx tools/get-plan.ts <file> --json
 *   npx tsx tools/get-plan.ts <file> --html plan.html
 *
 * health-core is deep-imported by path, not as `@roadmap/health-core`: the
 * workspace package resolves through `main: dist/index.js`, and dist/ is
 * gitignored and built by nobody — the package-name import would silently run
 * a stale engine on a fresh clone.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FileAdapter } from '../packages/health-core/src/file-adapter';
import { FIELD_METRIC_MAP } from '../packages/health-core/src/mappings';
import { recordSync } from '../packages/health-core/src/roadmap-doc';
import { describeStorageFailure, isStorageFailure } from '../packages/health-core/src/sync-manager';
import {
  computePlan,
  currentValues,
  dueSplit,
  PlanError,
  printable,
  renderJson,
  SCHEMA_URL,
  type DisplayRow,
  type Plan,
} from '../packages/health-core/src/plan';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '../packages/health-core/src/roadmap-file';
import type { Suggestion } from '../packages/health-core/src/types';
import { formatDisplayValue, getDisplayLabel } from '../packages/health-core/src/units';

// ---------------------------------------------------------------------------
// Load — the untrusted-bytes boundary
// ---------------------------------------------------------------------------

/**
 * Read the record through the same adapter the writers use, so "what counts as
 * my record" is decided in exactly one place (why: docs/mcp-architecture.md
 * §7). Read-only: nothing here saves.
 */
export async function loadRecord(path: string, now = new Date()): Promise<RoadmapFile> {
  try {
    return await recordSync(new FileAdapter(path), 'get-plan-cli', now.toISOString()).load();
  } catch (error) {
    if (!isStorageFailure(error)) throw error;
    const failed = describeStorageFailure(error, path);
    throw new PlanError(failed.message, failed.hint);
  }
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/** Group order and heading together: a priority cannot lose its label. */
const PRIORITY_GROUPS = [
  ['urgent', 'Urgent'],
  ['attention', 'Needs attention'],
  ['info', 'Foundation'],
] as const;

function profileLine(plan: Plan): string {
  const bits: string[] = [];
  if (plan.results.age !== undefined) bits.push(`${plan.results.age}y`);
  bits.push(plan.inputs.sex === 'female' ? 'female' : 'male');
  const height = FIELD_METRIC_MAP.heightCm;
  bits.push(`${formatDisplayValue(height, plan.results.heightCm, plan.unitSystem)}${getDisplayLabel(height, plan.unitSystem)}`);
  if (plan.results.bmi !== undefined) bits.push(`BMI ${plan.results.bmi}${plan.results.bmiCategory ? ` (${plan.results.bmiCategory})` : ''}`);
  if (plan.results.eGFR !== undefined) bits.push(`eGFR ${plan.results.eGFR}`);
  return bits.join(' · ');
}

function byPriority(suggestions: Suggestion[]): Array<{ priority: string; label: string; items: Suggestion[] }> {
  return PRIORITY_GROUPS.map(([priority, label]) => ({
    priority,
    label,
    items: suggestions.filter((s) => s.priority === priority),
  })).filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderText(plan: Plan): string {
  const out: string[] = [];
  out.push('YOUR HEALTH PLAN');
  out.push(profileLine(plan));
  out.push(`Computed ${plan.today} from your record file. Not medical advice — take it to your doctor.`);

  const row = (r: DisplayRow) => `  ${r.label.padEnd(20)} ${String(r.value).padStart(6)} ${r.unit.padEnd(9)} ${r.date}${r.excluded ? '  (excluded — out of range)' : ''}`;
  const values = currentValues(plan);
  out.push('', 'CURRENT VALUES');
  if (values.length === 0) out.push('  (none recorded yet)');
  for (const v of values) out.push(row(v));

  if (plan.labs.length > 0) {
    out.push('', 'ADDITIONAL LAB RESULTS (latest per test — informational; not used to compute suggestions)');
    for (const l of plan.labs) out.push(row(l));
  }

  const { overdue, upcoming } = dueSplit(plan);
  out.push('', 'WHAT’S DUE');
  if (overdue.length === 0 && upcoming.length === 0) out.push('  (nothing scheduled — the app needs your age and sex to work this out)');
  for (const i of overdue) out.push(`  DUE NOW   ${i.label} (was due ${i.dueAt})`);
  for (const i of upcoming) out.push(`  ${i.dueAt}  ${i.label}`);

  for (const group of byPriority(plan.results.suggestions)) {
    out.push('', `${group.label.toUpperCase()} (${group.items.length})`);
    for (const s of group.items) {
      out.push('', `  ${s.title}  [${s.category}]`);
      out.push(...wrap(s.description));
      if (s.ingredients?.length) for (const i of s.ingredients) out.push(`      - ${i}`);
      if (s.reason) out.push(...wrap(`Why: ${s.reason}`));
      if (s.guidelines?.length) out.push(`    Guidelines: ${s.guidelines.join(', ')}`);
      if (s.references?.length) for (const r of s.references) out.push(`    - ${r.label} — ${r.url}`);
    }
  }
  out.push('', `Record: schemaVersion ${CURRENT_SCHEMA_VERSION} · ${SCHEMA_URL}`);
  return printable(out.join('\n'));
}

/** Hard-wrap prose to 76 columns, indented four spaces. */
function wrap(text: string): string[] {
  const pad = '    ';
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > 76) {
      lines.push(pad + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(pad + line);
  return lines;
}

/** Everything the file can contain is untrusted text — escape it, always. */
function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderHtml(plan: Plan): string {
  const { overdue, upcoming } = dueSplit(plan);
  const values = currentValues(plan);
  const rows = (items: DisplayRow[]) =>
    items.map((i) => `<tr><th>${esc(i.label)}</th><td>${esc(i.value)} ${esc(i.unit)}${i.excluded ? ' <span class="ex">(excluded — out of range)</span>' : ''}</td><td>${esc(i.date)}</td></tr>`).join('\n');

  const suggestions = byPriority(plan.results.suggestions)
    .map(
      (group) => `<section><h2>${esc(group.label)} <span class="count">${group.items.length}</span></h2>
${group.items
  .map(
    (s) => `<article class="s ${esc(s.priority)}">
<h3>${esc(s.title)}</h3><p class="cat">${esc(s.category)}</p>
<p>${esc(s.description)}</p>
${s.ingredients?.length ? `<ul>${s.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
${s.reason ? `<p class="why"><b>Why:</b> ${esc(s.reason)}</p>` : ''}
${s.guidelines?.length ? `<p class="tags">${s.guidelines.map((g) => `<span>${esc(g)}</span>`).join(' ')}</p>` : ''}
${s.references?.length ? `<ul class="refs">${s.references.map((r) => `<li><a href="${esc(r.url)}">${esc(r.label)}</a></li>`).join('')}</ul>` : ''}
</article>`,
  )
  .join('\n')}
</section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health plan — ${esc(plan.today)}</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--muted:#666;--line:#e2e2e2;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#151515;--muted:#9a9a9a;--line:#333;--card:#1e1e1e}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.1rem;text-transform:uppercase;letter-spacing:.06em;margin:2.5rem 0 .75rem;padding-bottom:.35rem;border-bottom:2px solid var(--line)}
h3{font-size:1rem;margin:0 0 .15rem}
.sub{color:var(--muted);margin:0 0 .25rem}
.count{color:var(--muted);font-weight:400}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600}
td,th{padding:.35rem .5rem;border-bottom:1px solid var(--line)}
td:last-child{color:var(--muted);text-align:right;white-space:nowrap}
ul{margin:.4rem 0;padding-left:1.2rem}
.s{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--muted);border-radius:6px;padding:.9rem 1rem;margin:.75rem 0}
.s.urgent{border-left-color:#c0392b}.s.attention{border-left-color:#d68910}.s.info{border-left-color:#2874a6}
.cat{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;margin:0 0 .5rem}
.why{font-size:.92rem;color:var(--muted)}
.tags span{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:.05rem .55rem;font-size:.78rem;margin-right:.3rem}
.refs{font-size:.85rem}
a{color:inherit}
.due li{margin:.2rem 0}
.disclaimer{font-size:.85rem;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem}
.od{color:#c0392b;font-weight:600}
.ex{color:#c0392b;font-size:.82rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}
@media print{body{padding:0}.s{break-inside:avoid}}
</style></head><body><main>
<h1>Your health plan</h1>
<p class="sub">${esc(profileLine(plan))}</p>
<p class="sub">Computed ${esc(plan.today)} from your own record file, on your own machine.</p>
<p class="disclaimer"><b>Disclaimer:</b> This tool is for educational purposes only and is not a substitute for professional medical advice. Always consult with your healthcare provider before making any health decisions. Suggestions are based on general guidelines and may not apply to your individual situation.</p>

<h2>Current values</h2>
${values.length === 0 ? '<p class="sub">Nothing recorded yet.</p>' : `<table>${rows(values)}</table>`}

${plan.labs.length === 0 ? '' : `<h2>Additional lab results</h2>
<p class="sub">Latest per test. Informational — these do not feed the suggestions below.</p>
<table>${rows(plan.labs)}</table>`}

<h2>What’s due</h2>
<ul class="due">
${overdue.map((i) => `<li><span class="od">Due now</span> — ${esc(i.label)} <em>(was due ${esc(i.dueAt)})</em></li>`).join('\n')}
${upcoming.map((i) => `<li>${esc(i.dueAt)} — ${esc(i.label)}</li>`).join('\n')}
${overdue.length + upcoming.length === 0 ? '<li class="sub">Nothing scheduled.</li>' : ''}
</ul>

${suggestions}

<footer>Generated by <code>tools/get-plan.ts</code> — offline, from <code>health-roadmap.json</code> (schemaVersion ${CURRENT_SCHEMA_VERSION}). Nothing left this machine.</footer>
</main></body></html>
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const HELP = `get_plan — compute your health plan from your own record file, offline.

  npx tsx tools/get-plan.ts <health-roadmap.json>          readable report
  npx tsx tools/get-plan.ts <file> --json                  machine-readable
  npx tsx tools/get-plan.ts <file> --html <out.html>       self-contained page

Reads the file and nothing else: no network, no model, no telemetry, and the
record is never written back.

--json emits:
  instruction    how to present this plan: keep the hedging, keep the citations
  schemaVersion, generatedAt, today, unitSystem
  profile        age, sex, heightCm, bmi, bmiCategory, eGFR, idealBodyWeightKg,
                 proteinTargetG
  inputs         the HealthInputs the plan was computed from (SI canonical)
  currentValues  one row per metric — id, label, display value, unit, clinical
                 date; excluded: true marks a value out of range — shown, but
                 unused
  labValues      latest per additional test, with its id (informational; not
                 used to compute suggestions)
  medications    screenings
  due            { overdue, upcoming } — label + dueAt (YYYY-MM-DD)
  suggestions    id, category, priority, title, description, ingredients,
                 reason, guidelines, references[{label,url}]

The file format: docs/agent-access.md
Schema: ${SCHEMA_URL}
`;

/**
 * The report must never land on the record. A path can reach the same file by
 * another name (a symlink, /var vs /private/var, or a different CASE on macOS
 * APFS), so compare resolved paths — and refuse a target that is really the
 * next flag. `realpathSync.native` is load-bearing: the JS implementation
 * preserves the case it was given, so on a case-insensitive filesystem two
 * spellings of the same file compare unequal and the guard would pass. Hard
 * links are an accepted bypass — no filesystem-independent way to spot one.
 * Overwriting any OTHER existing file is normal `-o` behaviour and stays
 * allowed.
 */
function assertWritableTarget(htmlOut: string, recordPath: string): void {
  if (htmlOut.startsWith('--')) {
    throw new PlanError(`--html needs an output path, not ${htmlOut}`, 'Try `--html plan.html`.');
  }
  let sameFile = false;
  try {
    sameFile = realpathSync.native(htmlOut) === realpathSync.native(recordPath);
  } catch {
    // No such file yet — nothing to overwrite.
  }
  if (sameFile) {
    throw new PlanError('--html would overwrite the record file itself', 'Give the report its own path, e.g. `--html plan.html`.');
  }
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const htmlAt = argv.indexOf('--html');
  const htmlOut = htmlAt >= 0 ? argv[htmlAt + 1] : null;
  const path = argv.find((a) => !a.startsWith('--') && a !== htmlOut);
  const unknown = argv.find((a) => a.startsWith('--') && a !== '--json' && a !== '--html' && a !== htmlOut);

  try {
    if (!path) throw new PlanError('No record file given', 'Run `npx tsx tools/get-plan.ts --help` for usage.');
    if (htmlAt >= 0 && !htmlOut) throw new PlanError('--html needs an output path', 'Try `--html plan.html`.');
    if (unknown) throw new PlanError(`Unknown option ${unknown}`, 'Run with --help for the options.');
    if (htmlOut) assertWritableTarget(htmlOut, path);

    const plan = computePlan(await loadRecord(path));
    if (htmlOut) {
      try {
        writeFileSync(htmlOut, renderHtml(plan));
      } catch {
        throw new PlanError(`Cannot write ${htmlOut}`, 'Check the directory exists.');
      }
      process.stdout.write(`Wrote ${htmlOut}\n`);
    } else if (argv.includes('--json')) {
      process.stdout.write(`${renderJson(plan)}\n`);
    } else {
      process.stdout.write(`${renderText(plan)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof PlanError) {
      process.stderr.write(`get_plan: ${error.message}\n  ${error.hint}\n`);
      return 1;
    }
    process.stderr.write(`get_plan: ${error instanceof Error ? error.message : String(error)}\n  This is a bug — please report it with the record file's schemaVersion.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
