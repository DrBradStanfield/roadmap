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
 *    `meta` field touched — rule 6 (advance the file clock without rewinding
 *    the anchor for mutable row and field `updatedAt` clamps);
 *  - SI canonical values inside `healthInputSchema`'s range for measurements,
 *    and — since US-21 phase 3 — the catalogue's SI unit for a catalogued lab
 *    test, converted here from the spelling the lab printed, or refused when
 *    the catalogue does not know that spelling; a test the catalogue does not
 *    know keeps the unit it was reported in — rule 8;
 *  - catalogue keys for `metricName` — rule 10.
 *
 * v1 writes clinical VALUES only: no delete (deletion is a document tombstone
 * or an `eraseEpoch` bump, both the app's), and no medication, supplement or
 * screening op — those are last-write-wins current state, which a second
 * writer can only edit safely with the lamport discipline this does not take on.
 */
import {
  canonicalLabRow, canonicalLabValue, correctionOffScale, type CountFault, foldName, labCountFault, type LabCatalogEntry, labSlotKey,
  labUnitRefusal, normalizeLabUnit, resolveLabCatalogEntry, type StoredLabRow,
} from './lab-catalog';
import { METRIC_TO_FIELD } from './mappings';
import { resolveCoreMetricName } from './lab-extraction';
import { dayOf, latestStamp, localDay } from './merge';
import { isCalendarDay, isClinicalDay } from './measurement-history';
import { createLabValue, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { reportedToCanonical, UNIT_DEFS, type MetricType } from './units';
import { healthInputSchema, type MeasurementSource, METRIC_TYPES } from './validation';
import type { MEASUREMENT_REFUSAL_REASONS } from './product-events';

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
  /**
   * The number and unit as the lab PRINTED them. A catalogued test is
   * converted to the catalogue's SI unit here (US-21 phase 3) — reference
   * bounds by the same factor — and a spelling the catalogue does not know for
   * that test is refused, never rescaled by guess. A test the catalogue does
   * not know has no SI definition, so it is stored exactly as reported.
   */
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
   * The unit `newValue` is in, resolved against the metric or the catalogued
   * test of the row being corrected. Absent means `newValue` is already in the
   * unit the row is STORED in. A unit neither knows is refused rather than
   * silently ignored.
   */
  unit?: string;
  /**
   * What the caller believes the row holds right now, in the STORED number —
   * SI canonical, which is exactly what a read returned. A mismatch refuses the correction, so a
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

/** Rule 5 — a fresh UUID per row, always. Shared with state-edits.ts. */
export function newId(): string {
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
export function resolveRecordedAt(recordedAt: string | undefined, ctx: EditContext): string | EditRejection {
  const when = recordedAt ?? localDay(ctx.now);
  const day = dayOf(when);
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(when) || !isCalendarDay(day)) {
    return reject('invalid-date', `"${when}" is not a date`);
  }
  if (day > (ctx.latestDay ?? localDay(ctx.now))) {
    return reject('future-date', `${day} has not happened yet`);
  }
  return day;
}

/** Rule 9 as a day or null: absent or refused is null (the review's column date, US-13 AC8). */
export function validDay(day: string | null | undefined, ctx: EditContext): string | null {
  const resolved = day ? resolveRecordedAt(day, ctx) : null;
  return typeof resolved === 'string' ? resolved : null;
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
  const reported = reportedToCanonical(metricType as MetricType, value, unit);
  if (!reported) {
    return reject('unknown-unit', `${metricType} is measured in ${def.label.si} or ${def.label.conventional}, not "${unit}"`);
  }
  return reported.valueSI;
}

/**
 * Rule 8 for a lab value: the row a catalogued test is STORED in, or the
 * refusal. The three write doors — `appendLabValue`, `bulkAppendValues` and
 * the lab branch of `correctValue` — all come here, because a second opinion
 * about a factor is a wrong lab result.
 *
 * A test the catalogue does not know is returned untouched: there is no SI
 * definition to convert it to, and refusing it would throw the value away.
 */
function toStoredLab(
  entry: LabCatalogEntry | undefined, value: number, unit: string,
  referenceLow?: number | null, referenceHigh?: number | null,
): StoredLabRow | (EditRejection & { fault?: CountFault }) {
  const bounds = { referenceLow: referenceLow ?? null, referenceHigh: referenceHigh ?? null };
  if (!entry) return { value, unit, ...bounds };
  const canonical = canonicalLabRow(entry, { value, unit, ...bounds });
  if (!canonical) {
    // The refusal, in the shape a core metric's already takes: what it is
    // stored in, what spellings reach it, and the one that did not; or, for a
    // count per µL, what was wrong with the number (US-21 AC15).
    const fault = labCountFault(entry, { value, unit, ...bounds });
    return { ...reject('unknown-unit', labUnitRefusal(entry, unit, fault)), ...(fault ? { fault } : null) };
  }
  return canonical.stored;
}

/** Rule 8 — SI canonical, inside the range the app itself accepts. The
 *  assistant that typed the number reads it back in the refusal. */
function checkMeasurementValue(metricType: string, value: number): EditRejection | null {
  const fault = measurementValueFault(metricType, value);
  return fault?.reason === 'out-of-range' ? { ...fault, message: `${fault.message} (got ${value})` } : fault;
}

/** Rule 8's refusal without the number, for a bulk refusal (US-35 AC17) and a device import (device-import.ts). */
export function measurementValueFault(metricType: string, value: number): EditRejection | null {
  if (!Number.isFinite(value)) return reject('invalid-value', 'A value must be a finite number');
  const shape = healthInputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }>;
  const field = METRIC_TO_FIELD[metricType];
  const parsed = shape[field].safeParse(value);
  if (parsed.success) return null;
  return reject('out-of-range', parsed.error?.issues[0]?.message ?? 'Value out of range');
}

/**
 * The file with this row appended and `meta.updatedAt` moved to the write
 * clock — rule 6. Forward ONLY, like `mergeFiles` (merge.ts): `meta.updatedAt`
 * contributes to the anchor for mutable row and field `updatedAt` clamps. A
 * lagging writer must not rewind that anchor. Immutable measurement/lab
 * `createdAt` is kept as written; the new row keeps the real `now`.
 */
function withRow(file: RoadmapFile, key: 'measurements' | 'labValues', rows: Array<FileMeasurement | FileLabValue>, now: string): RoadmapFile {
  return stampUpdatedAt({ ...file, [key]: rows }, now);
}

/**
 * Rule 6 on its own, for a write that is not a row: `meta.updatedAt` moved to
 * the write clock, FORWARD only. `update_profile` (mcp-tools.ts) writes the
 * profile object rather than an array, and `migrate.ts` rewinds mutable
 * `updatedAt` stamps newer than the file's last-write anchor. A profile write
 * that skipped it would lose the merge it just won.
 */
export function stampUpdatedAt(file: RoadmapFile, now: string): RoadmapFile {
  const updatedAt = latestStamp(file.meta.updatedAt, now);
  return updatedAt === file.meta.updatedAt ? file : { ...file, meta: { ...file.meta, updatedAt } };
}

export type SlotKind = 'measurement' | 'lab';

/**
 * Rule 3's slot, spelled once: a core metric on a calendar day, or a lab
 * catalogue key on one — so "Gamma GT" and `ggt` are one slot. Every writer
 * that asks "is this slot taken" builds this key.
 */
export function slotKey(kind: SlotKind, metric: string, recordedAt: string): string {
  return kind === 'measurement' ? `m:${metric}@${dayOf(recordedAt)}` : `l:${labSlotKey(metric)}@${dayOf(recordedAt)}`;
}

function slotOfRow(row: FileMeasurement | FileLabValue): string {
  return 'metricType' in row ? slotKey('measurement', row.metricType, row.recordedAt ?? '') : slotKey('lab', row.metricName, row.recordedAt ?? '');
}

/** Every active row by its slot — one pass, for a writer with many rows to place. */
export function slotIndex(file: RoadmapFile): Map<string, FileMeasurement | FileLabValue> {
  const index = new Map<string, FileMeasurement | FileLabValue>();
  for (const row of [...file.measurements, ...file.labValues]) if (row.status === 'active') index.set(slotOfRow(row), row);
  return index;
}

/**
 * The active row holding one slot, or none. The two appends refuse on it,
 * `bulkAppendValues` skips on it, and `import_documents` slots its candidates
 * against it.
 */
export function findActiveInSlot(file: RoadmapFile, kind: SlotKind, metric: string, day: string): FileMeasurement | FileLabValue | undefined {
  const key = slotKey(kind, metric, day);
  const rows: Array<FileMeasurement | FileLabValue> = kind === 'measurement' ? file.measurements : file.labValues;
  return rows.find((row) => row.status === 'active' && slotOfRow(row) === key);
}

/**
 * What a new value finds in its slot, by the DISPLAYED string — what a person
 * would see — so float noise from a unit conversion never manufactures a
 * conflict. The connector judges a core metric here; a lab, on both surfaces,
 * by `sameLabQuantity` below, and the website's core cells by stored value
 * (US-13 AC3) — US-35 AC6.
 */
export type SlotState = 'free' | 'held_equal' | 'held_different';

export function slotState(existingDisplay: string | undefined, candidateDisplay: string): SlotState {
  if (existingDisplay === undefined) return 'free';
  return existingDisplay === candidateDisplay ? 'held_equal' : 'held_different';
}

/** One lab reading: the name it was filed or printed under, the number, and its unit. */
export type LabQuantity = { name: string; value: number; unit: string };

/**
 * Is a held lab row the same result as an offered one (US-35 AC6)? The record
 * holds a catalogued test in its SI unit (rule 8); a report prints its own. So
 * 50 nmol/L held and 50 ng/mL offered are different results. Each side converts
 * by its own name (BUN keeps its factor into the urea slot), and a unit the
 * catalogue refuses is never the same. An uncatalogued test compares its number
 * and unit as written, spelling folded. The website review table and the
 * connector both ask this, so they cannot disagree about "already recorded".
 */
export function sameLabQuantity(held: LabQuantity, offered: LabQuantity): boolean {
  const canonical = (q: LabQuantity) => {
    const entry = resolveLabCatalogEntry(q.name);
    return entry ? canonicalLabValue(entry, q.value, q.unit) : { value: q.value, unit: normalizeLabUnit(q.unit) };
  };
  const a = canonical(held);
  const b = canonical(offered);
  // Case matters: "G/L" is a cell count, "g/L" a mass.
  return a !== null && b !== null && a.unit === b.unit && sameValue(a.value, b.value);
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
  return placeMeasurement(file, { metricType, value, recordedAt, now, source: request.source });
}

/**
 * Rule 3 and the row, for a value already checked: refuse a slot an active
 * row holds, else append a fresh row (rule 5) and move the file clock (rule
 * 6). `appendMeasurement` reaches it after its own checks (metric, unit,
 * range, a past day). The web form reaches it directly, after only its
 * clinical-day check, so its rows keep the timestamp it stores and no range
 * refusal it never had (D4b, 2026-10-21): the slot rule is the one both share.
 */
export function placeMeasurement(
  file: RoadmapFile,
  request: { metricType: string; value: number; recordedAt: string; now: string; source?: MeasurementSource },
): EditResult<FileMeasurement> {
  const { metricType, value, recordedAt, now, source } = request;
  const taken = findActiveInSlot(file, 'measurement', metricType, recordedAt);
  if (taken) {
    return reject('slot-occupied', `${metricType} already has a value on ${dayOf(recordedAt)}`, taken);
  }
  const row = createMeasurement({ id: newId(), metricType, value, recordedAt, createdAt: now, ...(source ? { source } : null) });
  return { ok: true, file: withRow(file, 'measurements', [...file.measurements, row], now), row };
}

/**
 * Append one non-core lab value. A catalogued test is stored in the
 * catalogue's SI unit (rule 8, US-21 phase 3); an uncatalogued one keeps the
 * unit it was reported in. There is no range to check either way — only the
 * app's 13 core metrics have one.
 */
export function appendLabValue(file: RoadmapFile, request: AppendLabValueRequest): EditResult<FileLabValue> {
  const { value, now } = request;
  // Resolved once: the entry decides both the slot key and the conversion.
  const entry = resolveLabCatalogEntry(request.metricName);
  const metricName = entry?.key ?? foldName(request.metricName);
  if (!metricName) return reject('invalid-value', 'A lab value needs a test name');
  const coreMetric = resolveCoreMetricName(request.metricName);
  if (coreMetric) {
    return reject('core-metric', coreMetric === 'height'
      ? `"${request.metricName}" belongs in profile.heightCm — use update_profile to update heightCm in cm`
      : `"${request.metricName}" is the core metric ${coreMetric} — write it as a measurement, in SI units`);
  }
  if (!Number.isFinite(value)) return reject('invalid-value', 'A value must be a finite number');
  if (!request.unit.trim()) return reject('invalid-value', 'A lab value needs the unit the lab reported it in');
  const recordedAt = resolveRecordedAt(request.recordedAt, request);
  if (typeof recordedAt !== 'string') return recordedAt;

  const stored = toStoredLab(entry, value, request.unit, request.referenceLow, request.referenceHigh);
  if ('ok' in stored) return stored;

  const taken = findActiveInSlot(file, 'lab', metricName, recordedAt);
  if (taken) {
    return reject('slot-occupied', `${metricName} already has a value on ${dayOf(recordedAt)}`, taken);
  }

  const row = createLabValue({
    id: newId(), metricName, ...stored,
    recordedAt, createdAt: now, ...(request.source ? { source: request.source } : null),
  });
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

  // A unit CONVERTS (US-21 phase 3), the way the core branch above does; no
  // unit means the caller is already in the unit the row is stored in. An
  // uncatalogued test has no SI unit to convert to, so a unit there is refused.
  const labRow = lab as FileLabValue;
  const entry = resolveLabCatalogEntry(labRow.metricName);
  if (request.unit !== undefined && !entry) {
    return reject('unknown-unit', `${labRow.metricName} is stored in the unit it was reported in (${labRow.unit}) — correct the number only`);
  }
  const stored = request.unit === undefined
    ? { value: request.newValue, unit: labRow.unit }
    : toStoredLab(entry, request.newValue, request.unit);
  if ('ok' in stored) return stored;
  // The row carries the unit it is STORED in, which is the conversion's answer
  // and not the old row's label: a legacy row in a spelling the catalogue
  // refuses is corrected INTO the canonical unit, and saying otherwise would
  // be a wrong result that no message announces. The report's own reference
  // range was read in the old unit and no factor carries it across, so a
  // changed unit drops it rather than leaving it beside a number it misreads.
  const relabelled = stored.unit !== labRow.unit;
  // A count per µL is checked against the range the row already holds, as an
  // append checks its printed one (US-21 AC15), read on the canonical scale:
  // a legacy row in a factor-1 spelling (K/uL) holds its range there too.
  if (entry && request.unit !== undefined) {
    const held = canonicalLabRow(entry, labRow);
    if (held?.factor === 1 && correctionOffScale(entry, request.unit, stored.value, held.stored.referenceLow, held.stored.referenceHigh)) {
      return reject('unknown-unit', labUnitRefusal(entry, request.unit, 'scale'));
    }
  }
  const row: FileLabValue = {
    ...labRow,
    id: newId(), value: stored.value, unit: stored.unit, createdAt: now,
    ...(relabelled ? { referenceLow: null, referenceHigh: null } : null),
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
 * the write into a FHIR correction instead of a skip. Core values are already
 * SI canonical, but still validated here. The date is the day the reviewer
 * confirmed. A lab row still carries the unit
 * the report PRINTED — the conversion to SI happens here, at the write, so
 * there is one conversion site and the review table shows what the lab said.
 */
export type BulkRow =
  | { kind: 'measurement'; metricType: string; value: number; recordedAt: string; source: MeasurementSource; correctsId?: string }
  | {
      kind: 'lab'; metricName: string; value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null;
      recordedAt: string; source: MeasurementSource; correctsId?: string;
    };

/** One lab row the record would not store because the catalogue does not know
 *  that unit spelling for that test (US-21 phase 3): the key and the printed
 *  unit, never the value — that is what refusing the row protected. */
export interface LabUnitRefusal {
  key: string;
  unit: string;
  message: string;
  /** Set when the test takes the spelling and the NUMBER was refused (US-21 AC15). */
  fault?: CountFault;
}

export interface MeasurementRefusal {
  /** Zero-based index in the submitted batch. */
  index: number;
  metricType: string;
  reason: (typeof MEASUREMENT_REFUSAL_REASONS)[number];
  message: string;
  /** For `out-of-range`: which end of the accepted range it missed, so the
   *  refusal can name that end without the value (US-35 AC17). */
  bound?: 'above' | 'below';
}

export interface BulkAppendResult {
  file: RoadmapFile;
  saved: Array<FileMeasurement | FileLabValue>;
  /** Rows that found their slot taken, or named a `correctsId` that was no longer the slot's active row. */
  skippedDuplicates: number;
  /**
   * Lab rows refused because the catalogue does not know that unit spelling
   * for that test, or, under a spelling it takes, for the number (`fault`,
   * US-21 AC15). The caller SHOWS these — a silently dropped value is the
   * failure this whole change exists to prevent — and counts one
   * `lab_unit_refused` event per spelling refusal only.
   */
  refused: LabUnitRefusal[];
  /** Invalid core rows, distinct from occupied slots and lab-unit refusals. */
  measurementRefusals: MeasurementRefusal[];
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
  // US-29 AC4a: the reader drops such a row, so the save's readback would miss it and every later save fail.
  if (!rows.every((r) => isClinicalDay(r.recordedAt))) throw new Error('bulkAppendValues: every recordedAt must start with a real calendar day (YYYY-MM-DD)');
  // Each array copied once; rows are pushed and flipped in place after — O(rows + N).
  const measurements = [...file.measurements];
  const labValues = [...file.labValues];
  const saved: Array<FileMeasurement | FileLabValue> = [];
  let skippedDuplicates = 0;
  const taken = new Set(slotIndex(file).keys());
  // One index per list: a `correctsId` of the other kind must miss, not land on that list's row at the same position.
  const atMeasurement = new Map(measurements.map((m, i) => [m.id, i]));
  const atLab = new Map(labValues.map((l, i) => [l.id, i]));

  const refused: BulkAppendResult['refused'] = [];
  const measurementRefusals: MeasurementRefusal[] = [];

  for (const [index, input] of rows.entries()) {
    // A lab row is CONVERTED before its slot is touched: a refused row must
    // not flip the active row it was going to replace.
    let makeRow: (recordedAt: string, correctsId: string | null) => FileMeasurement | FileLabValue;
    if (input.kind === 'lab') {
      const entry = resolveLabCatalogEntry(input.metricName);
      const stored = toStoredLab(entry, input.value, input.unit, input.referenceLow, input.referenceHigh);
      if ('ok' in stored) {
        refused.push({ key: entry?.key ?? foldName(input.metricName), unit: input.unit, message: stored.message, ...(stored.fault ? { fault: stored.fault } : null) });
        continue;
      }
      makeRow = (recordedAt, correctsId) => createLabValue({
        id: newId(), metricName: input.metricName, ...stored,
        recordedAt, createdAt: now, source: input.source, correctsId,
      });
    } else {
      if (!(METRIC_TYPES as readonly string[]).includes(input.metricType)) {
        measurementRefusals.push({ index, metricType: input.metricType, reason: 'unknown-metric', message: 'Unknown core metric' });
        continue;
      }
      const invalid = measurementValueFault(input.metricType, input.value);
      if (invalid) {
        measurementRefusals.push(Number.isFinite(input.value)
          ? { index, metricType: input.metricType, reason: 'out-of-range', message: invalid.message, bound: input.value > UNIT_DEFS[input.metricType as MetricType].validationRange.si.max ? 'above' : 'below' }
          : { index, metricType: input.metricType, reason: 'invalid-value', message: invalid.message });
        continue;
      }
      makeRow = (recordedAt, correctsId) => createMeasurement({
        id: newId(), metricType: input.metricType, value: input.value,
        recordedAt, createdAt: now, source: input.source, correctsId,
      });
    }
    const slot = input.kind === 'measurement' ? slotKey('measurement', input.metricType, input.recordedAt) : slotKey('lab', input.metricName, input.recordedAt);
    const list: Array<FileMeasurement | FileLabValue> = input.kind === 'measurement' ? measurements : labValues;
    if (input.correctsId) {
      const index = (input.kind === 'measurement' ? atMeasurement : atLab).get(input.correctsId);
      const old = index === undefined ? undefined : list[index];
      if (!old || old.status !== 'active' || slotOfRow(old) !== slot) { skippedDuplicates++; continue; }
      list[index!] = { ...old, status: 'entered-in-error' };
      const row = makeRow(old.recordedAt, old.id);
      list.push(row);
      saved.push(row);
      continue;
    }
    if (taken.has(slot)) { skippedDuplicates++; continue; }
    taken.add(slot);
    const row = makeRow(input.recordedAt, null);
    list.push(row);
    saved.push(row);
  }
  const next = saved.length ? stampUpdatedAt({ ...file, measurements, labValues }, now) : file;
  return { file: next, saved, skippedDuplicates, refused, measurementRefusals };
}
