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
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { calculateHealthResults } from '../packages/health-core/src/calculations';
import { fileProfileToApi, fileScreeningRows } from '../packages/health-core/src/file-inputs';
import { displayLabUnit, resolveLabCatalogEntry } from '../packages/health-core/src/lab-catalog';
import {
  FIELD_METRIC_MAP,
  METRIC_LABELS,
  METRIC_TO_FIELD,
  measurementsToInputs,
  medicationsToInputs,
  screeningsToInputs,
  type ApiMeasurement,
} from '../packages/health-core/src/mappings';
import { latestActivePerMetric } from '../packages/health-core/src/measurement-history';
import { migrateFile, SchemaTooNewError } from '../packages/health-core/src/migrate';
import { computeReminderSchedule, type ReminderScheduleItem } from '../packages/health-core/src/reminder-schedule';
import { CURRENT_SCHEMA_VERSION, type FileLabValue, type RoadmapFile } from '../packages/health-core/src/roadmap-file';
import type { HealthInputs, HealthResults, MedicationInputs, ScreeningInputs, Suggestion } from '../packages/health-core/src/types';
import { UNIT_DEFS, formatDisplayValue, getDisplayLabel, type MetricType, type UnitSystem } from '../packages/health-core/src/units';
import { getValidationErrors, validateHealthInputs } from '../packages/health-core/src/validation';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json';

/** A failure the user can act on: one plain line plus a hint, never a stack. */
export class PlanError extends Error {
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * Text out of the record, made safe to print: a name lifted off an uploaded PDF
 * can carry terminal control codes (cursor moves, screen clears, BEL), and the
 * record is data — it must never drive the terminal. Newlines survive.
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

// ---------------------------------------------------------------------------
// Load — the untrusted-bytes boundary
// ---------------------------------------------------------------------------

/** Read a record file through `migrateFile`, so the hardened boundary applies. */
export function loadRecord(path: string, now = new Date()): RoadmapFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new PlanError(
      `Cannot read ${path}`,
      'Give the path to your health-roadmap.json — see docs/agent-access.md for where each backend keeps it.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlanError(`${path} is not valid JSON`, 'The file may be a partial write. Restore it from your cloud provider’s version history.');
  }
  try {
    return migrateFile(parsed, { deviceId: 'get-plan-cli', now: now.toISOString() });
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      throw new PlanError(
        `${path} is schema v${error.fileVersion}; this tool understands v${CURRENT_SCHEMA_VERSION}`,
        'A newer version of the app wrote this file. Pull the latest repo and try again.',
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Derive — the same path the widget takes (US-30 AC2)
// ---------------------------------------------------------------------------

export interface PlanInputs {
  inputs: Partial<HealthInputs>;
  unitSystem: UnitSystem;
  medications: MedicationInputs;
  screenings: ScreeningInputs;
  /**
   * The winning row per metric, with its clinical date. A row whose value the
   * schema rejects is still here — the file says it, so the report shows it —
   * but `Plan.excluded` names those fields and the plan did not use them.
   */
  currentRows: ApiMeasurement[];
}

/**
 * File → inputs, exactly as the widget derives them: the newest active row per
 * metric (US-07 AC4) mapped through `measurementsToInputs` over the file's
 * profile, medications and screenings converted by health-core. Per-field
 * display-unit overrides are deliberately absent — those live in the browser's
 * localStorage, never in the record, so the CLI renders in `profile.unitSystem`.
 */
export function derivePlanInputs(file: RoadmapFile): PlanInputs {
  const active = file.measurements.filter((m) => m.status === 'active') as ApiMeasurement[];
  const currentRows = latestActivePerMetric(active);
  return {
    inputs: measurementsToInputs(currentRows, fileProfileToApi(file.profile)),
    unitSystem: file.profile.unitSystem ?? 'si',
    medications: medicationsToInputs(file.medications),
    screenings: screeningsToInputs(fileScreeningRows(file.screenings)),
    currentRows,
  };
}

export interface PlanLab {
  key: string;
  label: string;
  value: number;
  unit: string;
  date: string;
}

/** Latest active row per lab test, named and unit-labelled from the catalogue. */
function derivePlanLabs(file: RoadmapFile): PlanLab[] {
  const active = file.labValues.filter((l) => l.status === 'active');
  const rows = latestActivePerMetric(active.map((l) => ({ ...l, metricType: l.metricName }))) as FileLabValue[];
  return rows
    .map((l) => {
      const entry = resolveLabCatalogEntry(l.metricName);
      return {
        key: l.metricName,
        label: entry?.label ?? l.metricName,
        value: l.value,
        unit: displayLabUnit(l.unit, entry),
        date: String(l.recordedAt ?? '').slice(0, 10),
      };
    })
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export interface Plan extends PlanInputs {
  generatedAt: string;
  results: HealthResults;
  due: ReminderScheduleItem[];
  labs: PlanLab[];
  /** Input fields dropped as out of range — displayed, never fed to the plan. */
  excluded: string[];
}

/**
 * The whole plan. Invalid fields are stripped before calculating (the widget
 * does the same), so one bad number costs its own suggestion, not the report.
 */
export function computePlan(file: RoadmapFile, now = new Date()): Plan {
  const derived = derivePlanInputs(file);
  let inputs = derived.inputs;
  let excluded: string[] = [];

  const validation = validateHealthInputs(inputs);
  if (!validation.success && validation.errors) {
    const invalid = new Set(validation.errors.issues.map((i) => String(i.path[0])));
    if (invalid.has('heightCm') || invalid.has('sex')) {
      throw new PlanError(
        `This record has no usable height and sex (${Object.values(getValidationErrors(validation.errors)).join('; ')})`,
        'The plan needs both. Open the app and fill in the first two fields, then run this again.',
      );
    }
    const stripped = { ...inputs } as Record<string, unknown>;
    for (const field of invalid) stripped[field] = undefined;
    inputs = stripped as Partial<HealthInputs>;
    excluded = [...invalid];
  }
  return {
    ...derived,
    inputs,
    excluded,
    generatedAt: now.toISOString(),
    results: calculateHealthResults(inputs as HealthInputs, derived.unitSystem, derived.medications, derived.screenings),
    due: computeReminderSchedule(file, now),
    labs: derivePlanLabs(file),
  };
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

/** A printed row: current value or lab. `excluded` marks a value the plan ignored. */
type DisplayRow = { label: string; value: unknown; unit: string; date: string; excluded?: boolean };

/**
 * Current values as displayed: label, converted value, unit, clinical date.
 * A value the schema rejected is marked `excluded` — it is in the file, so it
 * is on the report, but the reader must not mistake it for a plan input.
 */
function currentValues(plan: Plan) {
  const excluded = new Set(plan.excluded);
  return plan.currentRows
    .filter((row) => row.metricType in UNIT_DEFS)
    .map((row) => {
      const metric = row.metricType as MetricType;
      return {
        metric: row.metricType,
        label: METRIC_LABELS[row.metricType] ?? row.metricType,
        value: formatDisplayValue(metric, row.value, plan.unitSystem),
        unit: getDisplayLabel(metric, plan.unitSystem),
        date: String(row.recordedAt ?? '').slice(0, 10),
        excluded: excluded.has(METRIC_TO_FIELD[row.metricType]) || undefined,
      };
    })
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

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

function dueSplit(plan: Plan): { overdue: ReminderScheduleItem[]; upcoming: ReminderScheduleItem[] } {
  const today = plan.generatedAt.slice(0, 10);
  const sorted = [...plan.due].sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
  return {
    overdue: sorted.filter((i) => i.dueAt <= today),
    upcoming: sorted.filter((i) => i.dueAt > today),
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderText(plan: Plan): string {
  const out: string[] = [];
  out.push('YOUR HEALTH PLAN');
  out.push(profileLine(plan));
  out.push(`Computed ${plan.generatedAt.slice(0, 10)} from your record file. Not medical advice — take it to your doctor.`);

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

/** The agent-facing shape. Field names are stable; add, never rename. */
export function renderJson(plan: Plan): string {
  const { overdue, upcoming } = dueSplit(plan);
  return JSON.stringify(
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: plan.generatedAt,
      unitSystem: plan.unitSystem,
      profile: {
        sex: plan.inputs.sex,
        age: plan.results.age ?? null,
        heightCm: plan.results.heightCm,
        bmi: plan.results.bmi ?? null,
        bmiCategory: plan.results.bmiCategory ?? null,
        eGFR: plan.results.eGFR ?? null,
        idealBodyWeightKg: plan.results.idealBodyWeight,
        proteinTargetG: plan.results.proteinTarget,
      },
      inputs: plan.inputs,
      currentValues: currentValues(plan),
      labValues: plan.labs,
      medications: plan.medications,
      screenings: plan.screenings,
      due: { overdue, upcoming },
      suggestions: plan.results.suggestions.map((s) => ({
        id: s.id,
        category: s.category,
        priority: s.priority,
        title: s.title,
        description: s.description,
        ingredients: s.ingredients ?? [],
        reason: s.reason ?? null,
        guidelines: s.guidelines ?? [],
        references: s.references ?? [],
      })),
      source: { schema: SCHEMA_URL, tool: 'tools/get-plan.ts', docs: 'docs/agent-access.md' },
    },
    null,
    2,
  );
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
<title>Health plan — ${esc(plan.generatedAt.slice(0, 10))}</title>
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
<p class="sub">Computed ${esc(plan.generatedAt.slice(0, 10))} from your own record file, on your own machine.</p>
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
  schemaVersion, generatedAt, unitSystem
  profile        age, sex, heightCm, bmi, bmiCategory, eGFR, idealBodyWeightKg,
                 proteinTargetG
  inputs         the HealthInputs the plan was computed from (SI canonical)
  currentValues  one row per metric — label, display value, unit, clinical date;
                 excluded: true marks a value out of range — shown, but unused
  labValues      latest per additional test (informational; not used to compute
                 suggestions)
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

export function run(argv: string[]): number {
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

    const plan = computePlan(loadRecord(path));
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
  process.exit(run(process.argv.slice(2)));
}
