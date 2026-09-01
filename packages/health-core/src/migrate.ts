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
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyFile,
  type RoadmapFile,
} from './roadmap-file';

/** Thrown when a file was written by a newer app version than this one. */
export class SchemaTooNewError extends Error {
  constructor(public fileVersion: number, public appVersion: number) {
    super(
      `Health Roadmap file is schema v${fileVersion}, but this app only understands v${appVersion}. ` +
        `Update the app before writing, or your newer data could be lost.`,
    );
    this.name = 'SchemaTooNewError';
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
  const future = typeof row.updatedAt === 'string' && row.updatedAt > anchor;
  // A NON-string stamp (epoch millis from an agent, a null) is incomparable:
  // `number > string` and `string > number` are both false, so with tied
  // lamports neither row is newer either way round and the merge stops being
  // symmetric. `""` sorts below every ISO string, restoring a total order.
  const mistyped = 'updatedAt' in row && typeof row.updatedAt !== 'string';
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
 */
function sanitizeCreatedAt<T>(row: T, anchor: string): T {
  if (!isObject(row) || typeof row.createdAt !== 'string' || row.createdAt <= anchor) return row;
  return { ...row, createdAt: anchor } as T;
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

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CURRENT_SCHEMA_VERSION;

  // Refuse to downgrade a newer file (forward-compat rule 2).
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }

  // --- v1 normalisation -----------------------------------------------------
  // Spread `raw` FIRST so any unknown top-level fields survive (rule 1), then
  // overwrite with a guaranteed-present, well-typed shape.
  const base = createEmptyFile(opts);
  const rawMeta = isObject(raw.meta) ? raw.meta : {};
  const rawProfile = isObject(raw.profile) ? raw.profile : {};
  const rawScreenings = isObject(raw.screenings) ? raw.screenings : {};

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
  // The file's own last write — the anchor every row clock is clamped to. Every
  // file at rest is merge output, and merge stamps meta.updatedAt last, so no
  // legitimate row post-dates it.
  const anchor = meta.createdAt > meta.updatedAt ? meta.createdAt : meta.updatedAt;
  // Non-object entries are dropped, not passed through: every consumer reads
  // `.id` off a row, so one `null` in an array made every SAVE throw — the
  // localStorage mirror the failure path falls back to included, leaving no
  // way to persist anything again.
  const rowsOf = <T>(rows: unknown): T[] => asArray<T>(rows).filter((r) => isObject(r));
  const stamped = <T>(rows: unknown): T[] => rowsOf<T>(rows).map((r) => sanitizeStamp(r, anchor));
  const dated = <T>(rows: unknown): T[] => rowsOf<T>(rows).map((r) => sanitizeCreatedAt(r, anchor));

  return {
    ...(raw as Record<string, unknown>),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta,
    profile: sanitizeStamp({
      ...rawProfile,
      updatedAt: typeof rawProfile.updatedAt === 'string' ? rawProfile.updatedAt : base.profile.updatedAt,
    }, anchor),
    measurements: dated(raw.measurements),
    medications: stamped(raw.medications),
    medicationHistory: stamped(raw.medicationHistory),
    supplements: stamped(raw.supplements),
    supplementHistory: stamped(raw.supplementHistory),
    screenings: sanitizeStamp({
      ...rawScreenings,
      updatedAt: typeof rawScreenings.updatedAt === 'string' ? rawScreenings.updatedAt : base.screenings.updatedAt,
    }, anchor),
    labValues: dated(raw.labValues),
    documents: rowsOf(raw.documents),
    reminderPreferences: stamped(raw.reminderPreferences),
    recommendationSnapshots: rowsOf(raw.recommendationSnapshots),
    // Absent stays absent — present-beats-absent is how a cancellation wins.
    ...(isObject(raw.reminderOptIn) ? { reminderOptIn: sanitizeStamp(raw.reminderOptIn, anchor) } : null),
  } as RoadmapFile;
}
