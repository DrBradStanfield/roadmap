/**
 * Reading a RoadmapFile from the user's cloud is an untrusted boundary: the
 * bytes may be a different schema version, a partial/corrupt write, or a file
 * written by a NEWER app version on another device. `migrate.ts` is the single
 * gate that turns raw parsed JSON into a safe, fully-formed `RoadmapFile`.
 *
 * Forward-compat rules (implementation plan §15 H7):
 *  1. NEVER strip unknown fields — an older app must round-trip fields a newer
 *     app added. We achieve this by spreading the raw object first, then filling
 *     in only the known/required shape; extras survive to the next write.
 *  2. If the file's schemaVersion is NEWER than this app understands, refuse to
 *     migrate (the caller must gate writes — "please update the app") rather
 *     than silently downgrading and corrupting newer data.
 *
 * There is intentionally NO back-compat migration *layer* at v1 (the schema is
 * built clean). Add a `case` per version here only if the shape ever changes.
 *
 * The boundary is also where a SECOND WRITER is contained (see merge.ts's
 * threat model): the user hand-editing their own file, or an AI agent with
 * filesystem tools. Their clocks are sanitised here — counters to finite
 * in-range integers, row timestamps to no later than the file's own last write
 * — so a bad value cannot freeze an LWW record, demote the user's own fresh
 * entry, or make the eraseEpoch gate discard a whole side of the merge.
 *
 * The clamp anchor is `meta.updatedAt`, so IT is checked first: any string used
 * to sort below every row (`""`) would otherwise rewrite every clock in the
 * file at once. Accepted residual: an anchor that is ancient but well-formed
 * still rewinds the rows written after it. That is self-inflicted (the writer
 * edited its own meta), and content is preserved — only the ordering clocks
 * move.
 */
import { canonicalLabRow, resolveLabCatalogEntry } from './lab-catalog';
import { isCalendarDay, isClinicalDay } from './measurement-history';
import { stampInstant, withoutListed } from './merge';
import {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  createEmptyFile,
  type ErasedRows,
  type FileLabValue,
  type RoadmapFile,
} from './roadmap-file';

/** Thrown when a file was written by a newer app version than this one. */
export class SchemaTooNewError extends Error {
  constructor(public fileVersion: number, public appVersion: number) {
    super(
      `Health by Dr Brad file is schema v${fileVersion}, but this app only understands v${appVersion}. ` +
        `Update the app before writing, or your newer data could be lost.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * Thrown when the bytes are a record's neighbours rather than a record: a JSON
 * array, a bare string, an object with no `schemaVersion`, or one that carries
 * a `schemaVersion` and junk where its rows belong. `migrateFile` would turn
 * any of them into a BLANK record — right for a first run, a catastrophe for a
 * write — so the document spec refuses them before they reach it.
 */
export class RecordShapeError extends Error {
  constructor(readonly detail: string) {
    super(`Not a health-roadmap.json — ${detail}`);
    this.name = 'RecordShapeError';
  }
}

/** Guard for the untrusted-JSON boundary — shared by every synced-file migrate. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Ceiling for the file's counters (`meta.lamport`, `meta.eraseEpoch`) — far
 * above any real value (they tick once per write) and far below
 * MAX_SAFE_INTEGER, so the `+ 1` increments that order writes always advance.
 */
const MAX_COUNTER = 1e12;

/**
 * A timestamp from an untrusted writer. Shape-checked, not range-checked: the
 * merge only ever COMPARES these strings, so all that matters is that a garbage
 * value cannot sort outside the real ones.
 */
function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : fallback;
}

/** `a` is later than `b`: as instants when both parse, so an offset or a
 *  precision cannot reorder them (US-09 AC20); as strings otherwise, the order
 *  a value that is not a time always sorted in. */
function after(a: string, b: string): boolean {
  const [ta, tb] = [stampInstant(a), stampInstant(b)];
  return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Every shape a writer stamps with: a day alone, or with a time and an optional zone. */
const STAMP = /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** A complete stamp (US-23 AC6a): a real calendar day, alone or with a time,
 *  that parses. A real day followed by a broken time or offset, or by junk,
 *  is not one. `Date.parse` alone takes '2026-05-01 junk' and 2026-02-30. */
function isStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP.test(value) && isCalendarDay(value.slice(0, 10))
    && !Number.isNaN(stampInstant(value));
}

/** A counter from an untrusted writer: finite, non-negative, integral, bounded. */
function counterOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), MAX_COUNTER);
}

/**
 * Sanitise the writer-supplied clocks on one last-write-wins record. An
 * out-of-range lamport or a future `updatedAt` would win every merge from here
 * on, freezing a value (a medication statement, a reminder cancellation) the
 * user can no longer correct from any device.
 *
 * Clamped against the file's OWN last write, never against wall-clock `now`:
 * two devices reading the same bytes must compute the same row, or the clamp
 * itself would fork the file.
 */
function sanitizeStamp<T>(row: T, anchor: string): T {
  if (!isObject(row)) return row;
  const lamport = counterOf(row.lamport, 0);
  const clamped = 'lamport' in row && lamport !== row.lamport;
  // Validate the whole stamp before comparing: `after` orders a string that is
  // not a time as a string, so 'not-a-date' read as future and took the
  // anchor, a real date (US-23 AC6a).
  const known = isStamp(row.updatedAt);
  const future = known && after(row.updatedAt as string, anchor);
  // A stamp that is not a time (epoch millis from an agent, a null,
  // 'not-a-date', 2026-02-30, a broken time) is an unknown time. A non-string
  // one is also incomparable: `number > string` and `string > number` are both
  // false, so with tied lamports the merge stops being symmetric. `""` sorts
  // below every ISO string, so it orders against any PRESENT stamp; a row with
  // no `updatedAt` at all is still ordered by present-beats-absent, not by this.
  const mistyped = 'updatedAt' in row && !known && row.updatedAt !== '';
  if (!clamped && !future && !mistyped) return row;
  return {
    ...row,
    ...(clamped ? { lamport } : null),
    ...(future ? { updatedAt: anchor } : null),
    ...(mistyped ? { updatedAt: '' } : null),
  } as T;
}

/**
 * Same, for an append-only row: `createdAt` picks the one `active` row per slot,
 * so a future date demotes every later genuine entry to 'entered-in-error'.
 * `recordedAt` is deliberately left alone — it is the clinical date of the
 * value, and moving it would move the row into a different day slot.
 * Document `addedAt` is also left alone: clamping it to each file's own
 * anchor splits one document's content identity and can revive a deletion.
 */
function sanitizeCreatedAt<T>(row: T, anchor: string): T {
  if (!isObject(row) || !('createdAt' in row) || row.createdAt === '') return row;
  // Validated first, as `updatedAt` is (US-23 AC6a): a stamp that is not a
  // time is an unknown time, never the anchor.
  if (!isStamp(row.createdAt)) return { ...row, createdAt: '' } as T;
  return after(row.createdAt, anchor) ? { ...row, createdAt: anchor } as T : row;
}

/** The printed row's id plus this suffix, so every device computes the SAME id
 *  for the same conversion and `mergeFiles` folds their copies into one row. */
const SI_SUFFIX = '#si';

/**
 * US-21 phase 3 — rows written before lab values were stored in SI. A clinical
 * row is never edited in place, so the legacy row is CORRECTED: the converted
 * value is appended with `correctsId`, and the printed row flips to
 * `entered-in-error` (monotonic, so an older client still converges).
 *
 * Only rows whose NUMBER changes are corrected — a same-scale spelling ("ug/L"
 * for µg/L) holds the right number already, and a correction row there would
 * assert a value was wrong when it never was. That makes this idempotent, and
 * cheap: a record with nothing to convert returns the array it was given.
 */
function withSiCorrections(rows: FileLabValue[]): FileLabValue[] {
  let corrected = false;
  const out = rows.flatMap((row): FileLabValue[] => {
    if (row.status !== 'active' || typeof row.value !== 'number' || typeof row.unit !== 'string') return [row];
    const entry = resolveLabCatalogEntry(row.metricName);
    const si = entry && canonicalLabRow(entry, row);
    if (!si || si.factor === 1) return [row];
    corrected = true;
    return [
      { ...row, status: 'entered-in-error' },
      { ...row, ...si.stored, id: `${row.id}${SI_SUFFIX}`, status: 'active', correctsId: row.id },
    ];
  });
  return corrected ? out : rows;
}

/**
 * The erase list, kept only when it is whole: `ids` strings, and `fromEpoch`
 * an integer from 1 to `eraseEpoch + 1`. Anything else is dropped whole,
 * which reads as an erase that listed nothing, the stricter rule (US-09 AC23).
 */
function erasedRowsOf(value: unknown, eraseEpoch: number): ErasedRows | undefined {
  if (!isObject(value) || !Array.isArray(value.ids) || !value.ids.every((id) => typeof id === 'string')) return undefined;
  const { fromEpoch } = value;
  return Number.isInteger(fromEpoch) && (fromEpoch as number) >= 1 && (fromEpoch as number) <= eraseEpoch + 1
    ? { fromEpoch: fromEpoch as number, ids: value.ids as string[] }
    : undefined;
}

/**
 * Normalise raw parsed JSON into a complete RoadmapFile.
 *
 * @param raw    The result of JSON.parse on the file bytes (or null/garbage).
 * @param opts   deviceId + now, used only to synthesise meta for a fresh/blank file.
 * @throws SchemaTooNewError if raw.schemaVersion > CURRENT_SCHEMA_VERSION.
 */
export function migrateFile(
  raw: unknown,
  opts: { deviceId: string; now: string },
): RoadmapFile {
  // Empty / unreadable → a fresh record.
  if (!isObject(raw)) {
    return createEmptyFile(opts);
  }

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : BASE_SCHEMA_VERSION;

  // Refuse to downgrade a newer file (forward-compat rule 2).
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }

  // --- v1 normalisation -----------------------------------------------------
  // Spread `raw` FIRST so any unknown top-level fields survive (rule 1), then
  // overwrite with a guaranteed-present, well-typed shape.
  const base = createEmptyFile(opts);
  const rawMeta = isObject(raw.meta) ? raw.meta : {};

  // Spread rawMeta FIRST (rule 1 applies to meta too): rebuilding only the
  // known fields silently dropped everything else — including `eraseEpoch`,
  // which broke the "Delete All My Data" wholesale-win guarantee on every
  // read (a stale device's flush resurrected erased data; US-11 regression
  // tests in roadmap-store-data-safety.test.ts / sync-manager.test.ts).
  const meta = {
    ...rawMeta,
    createdAt: isoOr(rawMeta.createdAt, base.meta.createdAt),
    updatedAt: isoOr(rawMeta.updatedAt, base.meta.updatedAt),
    lastDeviceId: typeof rawMeta.lastDeviceId === 'string' ? rawMeta.lastDeviceId : base.meta.lastDeviceId,
    lamport: counterOf(rawMeta.lamport, base.meta.lamport),
    eraseEpoch: rawMeta.eraseEpoch === undefined
      ? base.meta.eraseEpoch
      : counterOf(rawMeta.eraseEpoch, 0),
  };
  // A complete ISO date-time (a real calendar date, time to at least the minute, Z or an
  // offset) that parses, rewritten in UTC; anything else is dropped, so the
  // erase reads as one from before erasedAt existed and the gate keeps none of
  // the losing side (US-09 AC20).
  if ('erasedAt' in meta) {
    const at = meta.erasedAt;
    // `isStamp`: Date.parse rolls 2026-02-30 over to March 2.
    const ok = isStamp(at) && ISO_DATE_TIME.test(at);
    if (ok) meta.erasedAt = new Date(at).toISOString();
    else delete meta.erasedAt;
  }
  // The file's own last write — the anchor every row clock is clamped to. Every
  // file at rest is merge output, and merge stamps meta.updatedAt last, so no
  // legitimate row post-dates it.
  const anchor = after(meta.createdAt, meta.updatedAt) ? meta.createdAt : meta.updatedAt;
  // Non-object entries are dropped, not passed through: every consumer reads
  // `.id` off a row, so one `null` in an array made every SAVE throw — the
  // localStorage mirror the failure path falls back to included, leaving no
  // way to persist anything again.
  const rowsOf = <T>(rows: unknown): T[] => asArray<T>(rows).filter((r) => isObject(r));
  const stamped = <T>(rows: unknown): T[] => rowsOf<T>(rows).map((r) => sanitizeStamp(r, anchor));
  // US-29 AC4: omit malformed clinical days; never invent a date or move a
  // valid observation to another slot. Keep the original timestamp and zone.
  const dated = <T extends { recordedAt: string }>(rows: unknown): T[] => rowsOf<T>(rows)
    .filter((r) => isClinicalDay(r.recordedAt))
    .map((r) => sanitizeCreatedAt(r, anchor));
  // Profile and screenings: the object's own stamp, and each field's (US-10
  // AC6). A field stamp that is not a stamp is dropped, so its field reads the
  // object's stamp; a map with none left is dropped whole. A missing or
  // mistyped `updatedAt` is an unknown time, `""`, as on any row: migration
  // time would let an agent's unstamped write beat a real edit.
  const singleton = (value: unknown) => {
    const { fieldStamps, ...rest } = isObject(value) ? value : {};
    const clocks = Object.entries(isObject(fieldStamps) ? fieldStamps : {})
      .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
      .map(([field, s]) => [field, sanitizeStamp({ lamport: s.lamport, updatedAt: s.updatedAt }, anchor)]);
    return {
      ...sanitizeStamp({ updatedAt: '', ...rest }, anchor),
      ...(clocks.length > 0 ? { fieldStamps: Object.fromEntries(clocks) } : null),
    };
  };

  // A listed file is stamped the version that carries the list, so a reader
  // from before it refuses the file; any other keeps its own (US-09 AC23).
  const erasedRows = erasedRowsOf(raw.erasedRows, meta.eraseEpoch ?? 0);
  const { erasedRows: _unchecked, ...rest } = raw;
  const file = {
    ...rest,
    schemaVersion: erasedRows || version >= CURRENT_SCHEMA_VERSION ? CURRENT_SCHEMA_VERSION : BASE_SCHEMA_VERSION,
    ...(erasedRows ? { erasedRows } : null),
    meta,
    profile: singleton(raw.profile),
    measurements: dated(raw.measurements),
    medications: stamped(raw.medications),
    medicationHistory: stamped(raw.medicationHistory),
    supplements: stamped(raw.supplements),
    supplementHistory: stamped(raw.supplementHistory),
    screenings: singleton(raw.screenings),
    labValues: withSiCorrections(dated<FileLabValue>(raw.labValues)),
    documents: rowsOf(raw.documents),
    reminderPreferences: stamped(raw.reminderPreferences),
    recommendationSnapshots: rowsOf(raw.recommendationSnapshots),
    // Absent stays absent — present-beats-absent is how a cancellation wins.
    ...(isObject(raw.reminderOptIn) ? { reminderOptIn: sanitizeStamp(raw.reminderOptIn, anchor) } : null),
  } as RoadmapFile;
  // Every reader drops the listed rows, so the widget, `read_record` and the
  // CLI agree on what the record holds.
  return withoutListed(file, new Set(erasedRows?.ids));
}
