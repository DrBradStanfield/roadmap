/**
 * Writing a RoadmapFile from outside the app (US-31).
 *
 * `docs/agent-access.md` publishes the rules an agent must keep when it edits
 * `health-roadmap.json`. This module is those rules AS CODE: pure functions
 * that take a file plus a request and return a NEW file, never mutating the
 * one they were given. `tools/edit-record.ts` is a shell over them, and the
 * hosted MCP server will be another — so neither can invent its own semantics.
 *
 * What is enforced here, and where the rule comes from:
 *  - one `active` row per (metric, calendar day) slot — rule 3, the same check
 *    `RoadmapStore.addMeasurement` answers with its 409-shaped `duplicate`;
 *  - a correction APPENDS with `correctsId` and the ORIGINAL `recordedAt`, and
 *    flips the old row to `entered-in-error` (one-way) — rule 2;
 *  - a fresh UUID per row, never a reused id — rule 5;
 *  - `meta.updatedAt` set to the same clock stamped on the row, and no other
 *    `meta` field touched — rule 6 (leave it stale and `migrate.ts` rewinds the
 *    row you just wrote, and it can lose its slot);
 *  - SI canonical values inside `healthInputSchema`'s range for measurements,
 *    the lab's own number and unit for lab values — rule 8;
 *  - catalogue keys for `metricName` — rule 10.
 *
 * v1 writes clinical VALUES only: no delete (deletion is a document tombstone
 * or an `eraseEpoch` bump, both the app's), and no medication, supplement or
 * screening op — those are last-write-wins current state, which a second
 * writer can only edit safely with the lamport discipline this does not take on.
 */
import { labSlotKey } from './lab-catalog';
import { METRIC_LABELS, METRIC_TO_FIELD } from './mappings';
import { dayOf, localDay } from './merge';
import { createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { resolveUnitSystem, toCanonicalValue, UNIT_DEFS, type MetricType } from './units';
import { healthInputSchema, type MeasurementSource, METRIC_TYPES } from './validation';

/**
 * What the writer's clock means. `now` stamps the row; `latestDay` is the
 * latest calendar day this writer will accept as not-future, and defaults to
 * the writer's own LOCAL day — right where the writer runs on the user's
 * machine (the CLI, the widget). A server in UTC cannot know the user's
 * timezone and passes `latestDayOnEarth(now)` instead, so it does not refuse
 * the day an Auckland user is living in (US-31 AC6/AC11).
 */
export interface EditContext {
  /** ISO 8601 write clock — stamped on the row AND on `meta.updatedAt`. */
  now: string;
  /** `YYYY-MM-DD`. Omit for the strict local-day check. */
  latestDay?: string;
}

export interface AppendMeasurementRequest extends EditContext {
  /** One of METRIC_TYPES. */
  metricType: string;
  /** The number as typed, in `unit`; stored SI canonical (rule 8). */
  value: number;
  /**
   * Which of the metric's two unit labels `value` is in (e.g. 'mg/dL', 'lbs').
   * Absent means it is already SI canonical. Anything else is refused, never
   * guessed — a silently mis-scaled LDL is the whole risk here.
   */
  unit?: string;
  /** Clinical date, `YYYY-MM-DD` or a full timestamp. Defaults to `now`. */
  recordedAt?: string;
  /** Who wrote it. `manual` unless the caller is an import (US-35: `lab_import`). */
  source?: MeasurementSource;
}

export interface AppendLabValueRequest extends EditContext {
  /** Reported test name; stored as the catalogue key when catalogued (rule 10). */
  metricName: string;
  /** The lab's own number, in the lab's own unit — never converted. */
  value: number;
  unit: string;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  recordedAt?: string;
  source?: MeasurementSource;
}

export interface CorrectValueRequest extends EditContext {
  /** Id of the active measurement or lab value being corrected. */
  id: string;
  newValue: number;
  /**
   * The unit `newValue` is in, for a MEASUREMENT — resolved against the metric
   * of the row being corrected. A lab value keeps the unit its lab reported,
   * so passing one here is refused rather than silently ignored.
   */
  unit?: string;
  /**
   * What the caller believes the row holds right now, in the STORED number —
   * SI canonical for a measurement, the lab's own for a lab value, which is
   * exactly what a read returned. A mismatch refuses the correction, so a
   * caller working from a stale or invented read writes nothing.
   *
   * Optional here and on the CLI, where a human is watching their own file.
   * The hosted MCP server REQUIRES it (design §3, mitigation 1): there the
   * caller is an agent that may have been talked into this.
   */
  expectedValue?: number;
  /** Who corrected it. `manual_correction` unless an import replaced the row. */
  source?: MeasurementSource;
}

export type EditRejectionReason =
  | 'unknown-metric'
  | 'core-metric'
  | 'invalid-value'
  | 'unknown-unit'
  | 'out-of-range'
  | 'invalid-date'
  | 'future-date'
  | 'slot-occupied'
  | 'not-found'
  | 'not-active'
  | 'value-changed';

/** A refused write. The caller decides what to do — nothing was changed. */
export interface EditRejection {
  ok: false;
  reason: EditRejectionReason;
  message: string;
  /** The active row holding the slot, on `slot-occupied`. */
  existing?: FileMeasurement | FileLabValue;
}

export interface EditSuccess<TRow> {
  ok: true;
  /** A new file. The one passed in is untouched. */
  file: RoadmapFile;
  row: TRow;
}

export type EditResult<TRow> = EditSuccess<TRow> | EditRejection;

function reject(reason: EditRejectionReason, message: string, existing?: FileMeasurement | FileLabValue): EditRejection {
  return { ok: false, reason, message, ...(existing ? { existing } : null) };
}

/** Float noise from a unit conversion is not a mismatch; a wrong number is. */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Rule 5 — a fresh UUID per row, always. */
function newId(): string {
  return crypto.randomUUID();
}

/**
 * Rule 9 — a clinical date that exists and has not happened yet, reduced to
 * the calendar day the slot is keyed on (the same shape a lab import writes).
 * How far "yet" reaches is the caller's to state: `EditContext.latestDay`.
 * Storing the day, not the caller's string, is what makes what is echoed back
 * and what lands on disk the same thing: `2026-02-30` rolls forward to March
 * in `Date`, and `'2026-08-14 <script>…'` would otherwise be stored whole.
 */
function resolveRecordedAt(recordedAt: string | undefined, ctx: EditContext): string | EditRejection {
  const when = recordedAt ?? localDay(ctx.now);
  const day = dayOf(when);
  const parsed = new Date(day);
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(when) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    return reject('invalid-date', `"${when}" is not a date`);
  }
  if (day > (ctx.latestDay ?? localDay(ctx.now))) {
    return reject('future-date', `${day} has not happened yet`);
  }
  return day;
}

/**
 * Rule 8 — the typed number in SI canonical units. `undefined` means the
 * caller already holds canonical; a label that is neither of the metric's two
 * is refused, because guessing the scale corrupts the value silently. The
 * label match is `units.ts`'s, the same one the chatbot's proposed edits use,
 * so the two writers cannot accept different spellings of the same unit.
 */
function toCanonicalUnit(metricType: string, value: number, unit: string | undefined): number | EditRejection {
  const def = UNIT_DEFS[metricType as MetricType];
  if (unit === undefined || !def) return value;
  const system = resolveUnitSystem(metricType as MetricType, unit);
  if (!system) {
    return reject('unknown-unit', `${metricType} is measured in ${def.label.si} or ${def.label.conventional}, not "${unit}"`);
  }
  return toCanonicalValue(metricType as MetricType, value, system);
}

/** Rule 8 — SI canonical, inside the range the app itself accepts. */
function checkMeasurementValue(metricType: string, value: number): EditRejection | null {
  if (!Number.isFinite(value)) return reject('invalid-value', 'A value must be a finite number');
  const shape = healthInputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }>;
  const field = METRIC_TO_FIELD[metricType];
  const parsed = shape[field].safeParse(value);
  if (parsed.success) return null;
  return reject('out-of-range', `${parsed.error?.issues[0]?.message ?? 'Value out of range'} (got ${value})`);
}

/**
 * The file with this row appended and `meta.updatedAt` moved to the write
 * clock — rule 6. Forward ONLY, like `mergeFiles` (merge.ts): `meta.updatedAt`
 * is the anchor `migrate.ts` clamps every row's `createdAt` to, so a writer
 * whose clock runs behind the file would rewind every other row and hand the
 * slot tie-breaks to a UUID comparison. The row itself keeps the real `now`.
 */
function withRow(file: RoadmapFile, key: 'measurements' | 'labValues', rows: Array<FileMeasurement | FileLabValue>, now: string): RoadmapFile {
  return stampUpdatedAt({ ...file, [key]: rows }, now);
}

/**
 * Rule 6 on its own, for a write that is not a row: `meta.updatedAt` moved to
 * the write clock, FORWARD only. `update_profile` (mcp-tools.ts) writes the
 * profile object rather than an array, and `migrate.ts` rewinds any stamp
 * newer than this anchor — so a profile write that skipped it would lose the
 * merge it just won.
 */
export function stampUpdatedAt(file: RoadmapFile, now: string): RoadmapFile {
  return now > file.meta.updatedAt ? { ...file, meta: { ...file.meta, updatedAt: now } } : file;
}

/**
 * The active row holding one (metric, day) slot, or none. Rule 3's question,
 * asked in one place: the two appends refuse on it, `bulkAppendValues` skips
 * on it, and `import_documents` slots its candidates against it. A lab slot is
 * keyed on the catalogue key, so "Gamma GT" and `ggt` are one slot.
 */
export function findActiveInSlot(file: RoadmapFile, kind: 'measurement', metric: string, day: string): FileMeasurement | undefined;
export function findActiveInSlot(file: RoadmapFile, kind: 'lab', metric: string, day: string): FileLabValue | undefined;
export function findActiveInSlot(file: RoadmapFile, kind: 'measurement' | 'lab', metric: string, day: string): FileMeasurement | FileLabValue | undefined {
  const at = dayOf(day);
  if (kind === 'measurement') {
    return file.measurements.find((m) => m.status === 'active' && m.metricType === metric && dayOf(m.recordedAt ?? '') === at);
  }
  const key = labSlotKey(metric);
  return file.labValues.find((l) => l.status === 'active' && labSlotKey(l.metricName) === key && dayOf(l.recordedAt ?? '') === at);
}

/**
 * What a new value finds in its slot. Equality is on the DISPLAYED string —
 * what a person would see — so float noise from a unit conversion never
 * manufactures a conflict. The website's review table and the connector's
 * `import_documents` both answer the question here, so they cannot disagree
 * about what "already recorded" means (US-35 AC6).
 */
export type SlotState = 'free' | 'held_equal' | 'held_different';

export function slotState(existingDisplay: string | undefined, candidateDisplay: string): SlotState {
  if (existingDisplay === undefined) return 'free';
  return existingDisplay === candidateDisplay ? 'held_equal' : 'held_different';
}

/**
 * Append one core-metric measurement. Rejects an occupied slot rather than
 * choosing for the caller: overwriting means correcting, and that is
 * `correctValue`'s decision to make explicit.
 */
export function appendMeasurement(file: RoadmapFile, request: AppendMeasurementRequest): EditResult<FileMeasurement> {
  const { metricType, now } = request;
  if (!(METRIC_TYPES as readonly string[]).includes(metricType)) {
    return reject('unknown-metric', `"${metricType}" is not a core metric (${METRIC_TYPES.join(', ')})`);
  }
  const value = toCanonicalUnit(metricType, request.value, request.unit);
  if (typeof value !== 'number') return value;
  const invalid = checkMeasurementValue(metricType, value);
  if (invalid) return invalid;
  const recordedAt = resolveRecordedAt(request.recordedAt, request);
  if (typeof recordedAt !== 'string') return recordedAt;

  const taken = findActiveInSlot(file, 'measurement', metricType, recordedAt);
  if (taken) {
    return reject('slot-occupied', `${metricType} already has a value on ${dayOf(recordedAt)}`, taken);
  }

  const row = createMeasurement({ id: newId(), metricType, value, recordedAt, createdAt: now, ...(request.source ? { source: request.source } : null) });
  return { ok: true, file: withRow(file, 'measurements', [...file.measurements, row], now), row };
}

/**
 * Every spelling of a core metric this tool recognises — its key and its
 * display label, folded to lower case. A core metric written into `labValues`
 * is invisible to the suggestion engine, and `docs/agent-access.md` names them
 * to users in exactly the display spelling ("LDL", "HbA1c").
 */
const CORE_METRIC_NAMES = new Set<string>([
  ...METRIC_TYPES,
  ...METRIC_TYPES.map((metric) => (METRIC_LABELS[metric] ?? metric).toLowerCase()),
]);

/**
 * Append one non-core lab value. The number and unit are the lab's own (rule
 * 8), so there is no range to check — only the app's 13 core metrics have one.
 */
export function appendLabValue(file: RoadmapFile, request: AppendLabValueRequest): EditResult<FileLabValue> {
  const { value, now } = request;
  const metricName = labSlotKey(request.metricName);
  if (!metricName) return reject('invalid-value', 'A lab value needs a test name');
  if (CORE_METRIC_NAMES.has(metricName)) {
    return reject('core-metric', `"${request.metricName}" is a core metric — write it as a measurement, in SI units`);
  }
  if (!Number.isFinite(value)) return reject('invalid-value', 'A value must be a finite number');
  if (!request.unit.trim()) return reject('invalid-value', 'A lab value needs the unit the lab reported it in');
  const recordedAt = resolveRecordedAt(request.recordedAt, request);
  if (typeof recordedAt !== 'string') return recordedAt;

  const taken = findActiveInSlot(file, 'lab', metricName, recordedAt);
  if (taken) {
    return reject('slot-occupied', `${metricName} already has a value on ${dayOf(recordedAt)}`, taken);
  }

  const row: FileLabValue = {
    id: newId(), metricName, value, unit: request.unit,
    referenceLow: request.referenceLow ?? null, referenceHigh: request.referenceHigh ?? null,
    recordedAt, createdAt: now, source: request.source ?? 'manual', status: 'active', correctsId: null,
  };
  return { ok: true, file: withRow(file, 'labValues', [...file.labValues, row], now), row };
}

/**
 * Correct an existing value (rule 2): append a row carrying the new number,
 * the old row's id in `correctsId` and — always — the old row's `recordedAt`,
 * then flip the old row to `entered-in-error`. A correction changes the value,
 * never the date, so the pair stays in one slot and history stays readable.
 *
 * It does not REPAIR a slot it did not break: if the file already carried two
 * active rows for that day (a hand edit, or another writer), correcting one
 * leaves the other active. The next `mergeFiles` demotes the loser — that is
 * where slot reconciliation lives, and duplicating it here would let this
 * function flip rows it was never asked about.
 */
export function correctValue(file: RoadmapFile, request: CorrectValueRequest): EditResult<FileMeasurement | FileLabValue> {
  const { id, now } = request;
  const measurement = file.measurements.find((m) => m.id === id);
  const lab = measurement ? undefined : file.labValues.find((l) => l.id === id);
  const old = measurement ?? lab;
  if (!old) return reject('not-found', `No value in this record has id ${id}`);
  if (old.status !== 'active') return reject('not-active', `Value ${id} is already entered-in-error; correct the row that replaced it`);
  // The refusal deliberately does not echo either number: a caller that
  // guessed must not learn the value by guessing at it.
  if (request.expectedValue !== undefined && !sameValue(old.value, request.expectedValue)) {
    return reject('value-changed', `Row ${id} does not hold the value you expected; read the record again before correcting`);
  }
  if (!Number.isFinite(request.newValue)) return reject('invalid-value', 'A value must be a finite number');

  if (measurement) {
    const newValue = toCanonicalUnit(measurement.metricType, request.newValue, request.unit);
    if (typeof newValue !== 'number') return newValue;
    const invalid = checkMeasurementValue(measurement.metricType, newValue);
    if (invalid) return invalid;
    const row = createMeasurement({
      id: newId(), metricType: measurement.metricType, value: newValue,
      recordedAt: measurement.recordedAt, createdAt: now,
      source: request.source ?? 'manual_correction', correctsId: id,
    });
    const rows = file.measurements.map((m) => (m.id === id ? { ...m, status: 'entered-in-error' as const } : m));
    return { ok: true, file: withRow(file, 'measurements', [...rows, row], now), row };
  }

  if (request.unit !== undefined) {
    return reject('unknown-unit', `A lab value keeps the unit its lab reported (${(lab as FileLabValue).unit}) — correct the number only`);
  }
  const row: FileLabValue = {
    ...(lab as FileLabValue),
    id: newId(), value: request.newValue, createdAt: now,
    source: request.source ?? 'manual_correction', status: 'active', correctsId: id,
  };
  const rows = file.labValues.map((l) => (l.id === id ? { ...l, status: 'entered-in-error' as const } : l));
  return { ok: true, file: withRow(file, 'labValues', [...rows, row], now), row };
}

// ---------------------------------------------------------------------------
// A reviewed batch, written at once
// ---------------------------------------------------------------------------

/**
 * One reviewed row on its way into the record. `correctsId` is set when the
 * reviewer chose "Replace" on a slot another writer already holds — it turns
 * the write into a FHIR correction instead of a skip. Values are already the
 * stored number (SI for a measurement, the lab's own for a lab value) and the
 * date is already the day the reviewer confirmed: this is the save behind a
 * review step, not a fresh claim to validate.
 */
export type BulkRow =
  | { kind: 'measurement'; metricType: string; value: number; recordedAt: string; source: MeasurementSource; correctsId?: string }
  | {
      kind: 'lab'; metricName: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null;
      recordedAt: string; source: MeasurementSource; correctsId?: string;
    };

export interface BulkAppendResult {
  file: RoadmapFile;
  saved: Array<FileMeasurement | FileLabValue>;
  /** Rows that found their slot taken, or named a `correctsId` that was no longer the slot's active row. */
  skippedDuplicates: number;
}

/**
 * The website's bulk save and the connector's import commit, as one rule
 * (US-35 AC8): a row naming `correctsId` supersedes that row only if it is
 * STILL the active row in the same slot — a stale id (superseded on another
 * device since review) is skipped, never appended, because two active rows in
 * one slot must not exist; a row without one is skipped if the slot is taken,
 * including by an earlier row of this batch. Rows are appended on their own
 * `recordedAt`; a correction keeps the old row's date, as `correctValue` does.
 */
export function bulkAppendValues(file: RoadmapFile, rows: BulkRow[], now: string): BulkAppendResult {
  let measurements = file.measurements;
  let labValues = file.labValues;
  const saved: Array<FileMeasurement | FileLabValue> = [];
  let skippedDuplicates = 0;
  const slotOf = (row: { metricType: string; recordedAt: string } | { metricName: string; recordedAt: string }) =>
    'metricType' in row ? `m:${row.metricType}@${dayOf(row.recordedAt)}` : `l:${labSlotKey(row.metricName)}@${dayOf(row.recordedAt)}`;
  const taken = new Set([...measurements, ...labValues].filter((r) => r.status === 'active').map(slotOf));

  for (const input of rows) {
    const slot = slotOf(input);
    if (input.correctsId) {
      const old = input.kind === 'measurement'
        ? measurements.find((m) => m.id === input.correctsId)
        : labValues.find((l) => l.id === input.correctsId);
      if (!old || old.status !== 'active' || slotOf(old) !== slot) { skippedDuplicates++; continue; }
      const flipped = { ...old, status: 'entered-in-error' as const };
      if (input.kind === 'measurement') {
        const row = createMeasurement({
          id: newId(), metricType: input.metricType, value: input.value,
          recordedAt: old.recordedAt, createdAt: now, source: input.source, correctsId: old.id,
        });
        measurements = [...measurements.map((m) => (m.id === old.id ? flipped as FileMeasurement : m)), row];
        saved.push(row);
      } else {
        const row: FileLabValue = {
          id: newId(), metricName: input.metricName, value: input.value, unit: input.unit,
          referenceLow: input.referenceLow ?? null, referenceHigh: input.referenceHigh ?? null,
          recordedAt: old.recordedAt, createdAt: now, source: input.source, status: 'active', correctsId: old.id,
        };
        labValues = [...labValues.map((l) => (l.id === old.id ? flipped as FileLabValue : l)), row];
        saved.push(row);
      }
      continue;
    }
    if (taken.has(slot)) { skippedDuplicates++; continue; }
    taken.add(slot);
    if (input.kind === 'measurement') {
      const row = createMeasurement({
        id: newId(), metricType: input.metricType, value: input.value,
        recordedAt: input.recordedAt, createdAt: now, source: input.source,
      });
      measurements = [...measurements, row];
      saved.push(row);
    } else {
      const row: FileLabValue = {
        id: newId(), metricName: input.metricName, value: input.value, unit: input.unit,
        referenceLow: input.referenceLow ?? null, referenceHigh: input.referenceHigh ?? null,
        recordedAt: input.recordedAt, createdAt: now, source: input.source, status: 'active', correctsId: null,
      };
      labValues = [...labValues, row];
      saved.push(row);
    }
  }
  const next = saved.length ? stampUpdatedAt({ ...file, measurements, labValues }, now) : file;
  return { file: next, saved, skippedDuplicates };
}
