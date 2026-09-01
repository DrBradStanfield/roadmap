#!/usr/bin/env tsx
/**
 * edit_record — add and correct values in your own record file (US-31).
 *
 * The other half of `get-plan.ts`: that one reads the record and computes the
 * plan, this one writes to it. It is deliberately THIN. Every rule about what
 * a legal write is — slots, corrections, ranges, catalogue keys, clocks —
 * lives in `packages/health-core/src/record-edits.ts`, so this CLI and the
 * hosted MCP server enforce the same thing. What lives here is the shell: how
 * a person says it, and how the bytes reach the disk without losing the file.
 *
 * Usage:
 *   npx tsx tools/edit-record.ts add <file> --metric ldl --value 2.1 [--unit mg/dL] [--date 2026-08-14]
 *   npx tsx tools/edit-record.ts add <file> --test ferritin --value 210 --unit "µg/L" [--date …]
 *   npx tsx tools/edit-record.ts correct <file> --id <rowId> --value 2.3
 *
 * Safety: the original is copied to `health-roadmap.json.bak-<ISO>` (last 3
 * kept) before the new file is written to a temp file and renamed into place,
 * so an interrupted write leaves the record as it was — `record-io.ts` owns
 * that boundary, and the MCP server (US-32) writes through the same one. No
 * network, no model, no telemetry; the record and its .bak siblings are the
 * only files touched.
 */
import { pathToFileURL } from 'node:url';
import { oneLine, PlanError } from '../packages/health-core/src/plan';
import {
  appendLabValue,
  appendMeasurement,
  correctValue,
  type EditResult,
} from '../packages/health-core/src/record-edits';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../packages/health-core/src/roadmap-file';
import { formatDisplayValue, UNIT_DEFS, type MetricType } from '../packages/health-core/src/units';
import { assertUnchanged, backup, BACKUPS_KEPT, openRecord, writeAtomic } from './record-io';

export const HELP = `edit_record — add and correct values in your own record file.

  npx tsx tools/edit-record.ts add <file> --metric ldl --value 2.1
  npx tsx tools/edit-record.ts add <file> --metric ldl --value 81 --unit mg/dL --date 2026-08-14
  npx tsx tools/edit-record.ts add <file> --test ferritin --value 210 --unit "µg/L"
  npx tsx tools/edit-record.ts correct <file> --id <rowId> --value 2.3

add        --metric  one of the app's core metrics (ldl, hba1c, weight, …), stored
                     in SI units; --unit converts from the other unit system.
           --test    any other blood test, by catalogue name (ferritin, tsh, …);
                     --unit is required and kept exactly as the lab reported it.
           --date    the clinical date (YYYY-MM-DD). Defaults to today; a future
                     date is refused. One value per metric per day — a day that
                     already has a value is refused, and you correct it instead.
correct    --id      the row id to correct (get-plan --json shows them). The new
                     row keeps the ORIGINAL date; the old row becomes
                     entered-in-error. Nothing is ever deleted or overwritten.
                     --expect <n> refuses the correction unless the row holds
                     that value now — worth passing from a script.
                     --unit converts, as it does for add; a lab value keeps the
                     unit its lab reported, so give the number only.

Before writing, the record is copied to <file>.bak-<ISO> (the last ${BACKUPS_KEPT} are kept)
and the new version is written through a temp file, so a failed write cannot
leave you with half a record.

The file format and the rules this enforces: docs/agent-access.md
`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const FLAGS = ['--metric', '--test', '--value', '--unit', '--date', '--id', '--expect'] as const;
type Flag = typeof FLAGS[number];

interface Args {
  command: string;
  path: string;
  flags: Partial<Record<Flag, string>>;
}

/** `<command> <file> --flag value …`, with every unknown or dangling flag refused. */
export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const flags: Partial<Record<Flag, string>> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (!(FLAGS as readonly string[]).includes(token)) {
      throw new PlanError(`Unknown option ${token}`, 'Run with --help for the options.');
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PlanError(`${token} needs a value`, 'Run with --help for the options.');
    }
    flags[token as Flag] = value;
    i++;
  }
  if (positional.length === 0) throw new PlanError('No record file given', 'Run `npx tsx tools/edit-record.ts --help` for usage.');
  if (positional.length > 1) throw new PlanError(`Unexpected argument ${positional[1]}`, 'One record file per run.');
  return { command, path: positional[0], flags };
}

/**
 * A number the user typed, or a refusal naming the flag. Matched against a
 * plain decimal rather than handed to `Number`, which reads '' as 0, '0x10'
 * as 16 and ' ' as 0 — none of them a value anybody typed on purpose, and the
 * first of them lands a zero on a clinical row.
 */
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;

function numberFlag(args: Args, flag: Flag): number {
  const raw = args.flags[flag];
  if (raw === undefined) throw new PlanError(`${flag} is required`, 'Run with --help for the options.');
  if (!DECIMAL.test(raw.trim())) throw new PlanError(`${flag} must be a number, not "${raw}"`, 'Try `--value 2.1`.');
  return Number(raw.trim());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Row = FileMeasurement | FileLabValue;

/** The name a row is filed under — the two array shapes differ by one field. */
function rowName(row: Row): string {
  return 'metricType' in row ? row.metricType : row.metricName;
}

/**
 * What to echo back. A measurement is STORED unrounded — converting 81 mg/dL
 * gives 2.094647… and the app stores the same — but a confirmation line reads
 * as a value, so it is rounded the way the app displays it.
 */
function shownValue(row: Row): string {
  const metric = 'metricType' in row ? (row.metricType as MetricType) : undefined;
  return metric && UNIT_DEFS[metric] ? formatDisplayValue(metric, row.value, 'si') : String(row.value);
}

/** Turn a rejection into the user's next move; a slot clash names the row. */
function refuse(result: Extract<EditResult<Row>, { ok: false }>, path: string): never {
  const held = result.existing;
  if (result.reason === 'slot-occupied' && held) {
    throw new PlanError(
      result.message,
      `That day holds ${held.value} (row ${oneLine(held.id)}, ${oneLine(String(held.recordedAt).slice(0, 10))}). ` +
        `Correct it instead: npx tsx tools/edit-record.ts correct ${path} --id ${oneLine(held.id)} --value <new value>`,
    );
  }
  throw new PlanError(result.message, 'Nothing was written. Run with --help for the options.');
}

/** What one command did: the new file, the row written, and how to say it. */
interface Change {
  file: RoadmapFile;
  row: Row;
  unit: string;
  /** The row this one corrects, so the echo can show old → new. */
  previous?: Row;
}

function runAdd(args: Args, record: RoadmapFile, now: string): Change {
  const { '--metric': metric, '--test': test, '--unit': unit, '--date': date } = args.flags;
  if (!!metric === !!test) {
    throw new PlanError('Give either --metric (a core metric) or --test (any other blood test)', 'Run with --help for the list.');
  }
  const value = numberFlag(args, '--value');

  if (metric) {
    const result = appendMeasurement(record, { metricType: metric, value, unit, recordedAt: date, now });
    if (!result.ok) refuse(result, args.path);
    return { file: result.file, row: result.row, unit: UNIT_DEFS[metric as MetricType]?.canonical ?? '' };
  }
  if (!unit) throw new PlanError('--test needs --unit', 'Give the unit the lab reported, e.g. `--unit "µg/L"`.');
  const result = appendLabValue(record, { metricName: test as string, value, unit, recordedAt: date, now });
  if (!result.ok) refuse(result, args.path);
  return { file: result.file, row: result.row, unit };
}

function runCorrect(args: Args, record: RoadmapFile, now: string): Change {
  const id = args.flags['--id'];
  if (!id) throw new PlanError('correct needs --id', 'Run `npx tsx tools/get-plan.ts <file> --json` to see the row ids.');
  if (args.flags['--date']) throw new PlanError('A correction cannot change the date', 'The new row keeps the original date. Drop --date.');
  const result = correctValue(record, {
    id,
    newValue: numberFlag(args, '--value'),
    unit: args.flags['--unit'],
    // Optional here, required on the hosted server (US-32): a human running
    // this is looking at the file, an agent is not.
    expectedValue: args.flags['--expect'] === undefined ? undefined : numberFlag(args, '--expect'),
    now,
  });
  if (!result.ok) refuse(result, args.path);
  const unit = 'metricType' in result.row ? UNIT_DEFS[result.row.metricType as MetricType]?.canonical ?? '' : result.row.unit;
  // The superseded row, read back off the result — its status is now the flip.
  const previous = [...result.file.measurements, ...result.file.labValues].find((r) => r.id === id);
  return { file: result.file, row: result.row, unit, previous };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(argv: string[]): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const args = parseArgs(argv);
    if (args.command !== 'add' && args.command !== 'correct') {
      throw new PlanError(`Unknown command "${args.command}"`, 'The commands are `add` and `correct`.');
    }
    const now = new Date().toISOString();
    const record = openRecord(args.path);
    const change = args.command === 'add' ? runAdd(args, record.file, now) : runCorrect(args, record.file, now);

    assertUnchanged(record.path, record.stamp);
    const bak = backup(record.path, now);
    writeAtomic(record.path, change.file);

    const { row, unit, previous } = change;
    const verb = args.command === 'add' ? 'Added' : 'Corrected';
    const was = previous ? `${shownValue(previous)} → ` : '';
    process.stdout.write(
      `${verb} ${oneLine(rowName(row))} ${was}${shownValue(row)}${unit ? ` ${oneLine(unit)}` : ''}` +
      ` on ${oneLine(String(row.recordedAt).slice(0, 10))} — new row ${oneLine(row.id)}\n` +
      `Wrote ${oneLine(record.path)} (backup: ${oneLine(bak)})\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PlanError) {
      process.stderr.write(`edit_record: ${oneLine(error.message)}\n  ${oneLine(error.hint)}\n`);
      return 1;
    }
    process.stderr.write(`edit_record: ${error instanceof Error ? error.message : String(error)}\n  This is a bug — please report it with the record file's schemaVersion.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
