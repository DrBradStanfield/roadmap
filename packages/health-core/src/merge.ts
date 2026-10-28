/**
 * Conflict-free merge of two RoadmapFile revisions (implementation plan §5.3).
 *
 * `SyncManager.save()` does optimistic-concurrency read-merge-write: read the
 * remote file, merge it with the local working copy, write back with a version
 * precondition. This module is the pure, deterministic MERGE — no I/O, no clock
 * reads (caller injects `now`/`deviceId`), heavily unit-tested.
 *
 * Convergence guarantee: merge is deterministic and symmetric in its inputs, so
 * two devices that have seen the same set of writes compute the SAME file —
 * regardless of who merges whom. The pieces:
 *
 *  - measurements & labValues  → append-only, slot-keyed by (metric, day). Exactly
 *    one `active` row survives per slot (newest createdAt); everyone else is
 *    flipped to `entered-in-error`. Status is MONOTONIC (active→error, never back),
 *    so a correction seen by one device is never undone by the other.
 *  - medications / supplements / reminderPreferences → current-state, keyed by
 *    their natural key, last-write-wins: the newer edit by clock time, the
 *    lamport counter only on a tie (`cmpClock`, US-10 AC8).
 *  - profile / screenings → singletons, the same LWW field by field
 *    (`mergeFields`).
 *  - medicationHistory / supplementHistory / documents → append-only logs, union
 *    by (id, content); documents also OR the `deleted` tombstone.
 *  - recommendationSnapshots → deduped by date.
 *  - erasedRows → ids union; every listed row goes from both sides first.
 *  - meta.lamport → max(local, remote) + 1.
 *
 * SECOND-WRITER THREAT MODEL: local-first means the user can open and hand-edit
 * `health-roadmap.json`, and AI agents with filesystem tools now write it too.
 * That writer is sloppy or confused, not sophisticated — full adversarial
 * hardening (trusted time, signatures) is out of scope. So the invariants that
 * used to hold only because `RoadmapStore` was the sole writer are ENFORCED at
 * the file boundary instead of assumed:
 *
 *  - `migrate.ts` enforces type/range sanity on the clocks and timestamps.
 *  - Row immutability is enforced HERE, by `unionRows`, on every append-only
 *    array: measurements, labValues, medicationHistory, supplementHistory and
 *    documents. An id reused with DIFFERENT content is not an in-place edit of
 *    a clinical row, it is two rows.
 *
 * What is still ASSUMED, because the data model says so: the current-state
 * lists (medications, supplements, reminderPreferences) and the singletons
 * (profile, screenings, reminderOptIn) are last-write-wins, so a second writer
 * CAN overwrite them — the clock sanity in `migrate.ts` only guarantees the
 * user can overwrite them back. `correctsId` links are never verified: a
 * quarantined row can take the base id a chain points at.
 */
import {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  stableStringify,
  type ErasedRows,
  type RoadmapFile,
  type FileMeasurement,
  type FileLabValue,
  type FileMedication,
  type FileSupplement,
  type FileReminderPreference,
  type FileReminderOptIn,
  type FileDocument,
  type FieldStamped,
  type RoadmapProfile,
  type FileScreenings,
  type RecommendationSnapshot,
  type SyncStamp,
} from './roadmap-file';
import type { MeasurementStatus } from './validation';
import { labSlotKey } from './lab-catalog';

export interface MergeOptions {
  /** This device's id — stamped as the merge author on the result. */
  deviceId: string;
  /** ISO 8601 wall-clock for the merged file's meta.updatedAt. */
  now: string;
}

/** A row that participates in append-only slot resolution. */
interface SlottableRow {
  id: string;
  recordedAt: string;
  createdAt: string;
  status: MeasurementStatus;
}

/** Normalise an ISO timestamp to its calendar day — the slot granularity. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole UTC days from one ISO day to another; 0 when either does not parse. The one age rule every surface reads. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The calendar day an instant falls on IN THE WRITER'S OWN TIMEZONE — what a
 * person means by "today". `dayOf` reads the day out of a stored string and is
 * right for that; using it on a clock reading puts an 11am Auckland write on
 * yesterday, because the instant is still 23:00Z.
 */
export function localDay(instant: string | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * How far ahead of UTC the earliest-rising timezone runs (Kiritimati, UTC+14).
 */
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

/**
 * The latest calendar day anyone on Earth has reached at `now`. A server in
 * UTC cannot know the user's timezone, so this — not its own local day — is
 * the only future check it can make without refusing the day an Auckland user
 * is living in (US-31 AC6/AC11).
 */
export function latestDayOnEarth(now: string | Date): string {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  return dayOf(new Date(ms + MAX_UTC_OFFSET_MS).toISOString());
}

/** Stable string comparison (-1 | 0 | 1). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recency comparison for an append-only row WITHIN a slot: newer = later
 * createdAt, tie-broken by larger id (deterministic + symmetric).
 * Returns true if `a` is newer than `b`.
 */
function rowIsNewer(a: SlottableRow, b: SlottableRow): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * Content signature of an append-only row, EXCLUDING `id` (the field a second
 * writer may have reused) and any MONOTONIC field merged separately (`status`
 * on a measurement, `deleted` on a document). Same signature = the same fact.
 */
function contentOf(row: object, omit: readonly string[]): string {
  const rest = { ...(row as Record<string, unknown>) };
  delete rest.id;
  for (const key of omit) delete rest[key];
  return stableStringify(rest);
}

/** 32-bit FNV-1a as hex — a short, stable tag for a quarantined row's id. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The id a row was written under, before any quarantine suffix. Grouping on it
 * makes the whole assignment a pure function of the (id, content) pairs in the
 * inputs — a third device's divergent copy re-runs it over all the contents
 * instead of layering a second suffix on the first result. Generated ids are
 * UUIDs, so `#dup-` can only appear on a row the quarantine produced. ALL
 * trailing suffixes go: a writer that layers a second one on a quarantined id
 * belongs in the original id's group, and since no base can then end in
 * `#dup-<8 hex>`, an assigned id can never collide with another group's.
 *
 * Only that suffix: migrate.ts's `#si` conversion id (US-21 phase 3) must
 * survive here, or a converted row would merge into its own parent's group.
 */
export function baseIdOf(id: string): string {
  return id.replace(/(?:#dup-[0-9a-f]{8})+$/, '');
}

/**
 * The id a row's original was written under: `baseIdOf` with the `#si`
 * conversion suffix stripped too, so an erase that lists a row takes its
 * quarantined copies and its unit conversion with it (US-09 AC23).
 */
export function rootIdOf(id: string): string {
  return id.replace(/(?:#dup-[0-9a-f]{8}|#si)+$/, '');
}

/**
 * Union append-only rows by id, keeping every distinct CONTENT. The one place
 * row immutability is enforced — every append-only array goes through it.
 *
 * Same id + same content is one row seen twice: keep one, folding in the
 * monotonic fields `omit` left out of the signature (`absorb`). Same id +
 * different content means a second writer reused an id (see the header) —
 * keeping the first-seen copy would edit an immutable clinical row in place AND
 * make the merge asymmetric, so both rows survive: the deterministic winner
 * (smallest content signature) keeps the base id, every other is quarantined
 * under `<id>#dup-<hash-of-content>`. The assignment is a pure function of the
 * (id, content) pairs on both sides — quarantined rows regroup under their base
 * id — so it survives re-merging and any order of devices: every device that
 * has seen the same writes lands on the same rows.
 *
 * The winner is the SMALLEST signature, which means a divergent row can capture
 * the base id (and any `correctsId` chain pointing at it) from the row that was
 * written under it first. Both contents are preserved and the choice is
 * deterministic; there is no trustworthy tiebreaker, since `createdAt` is
 * exactly what a sloppy second writer forges.
 */
function unionRows<T extends { id: string }>(
  rows: T[],
  omit: readonly string[] = [],
  absorb: (target: T, source: T) => void = () => {},
): T[] {
  const distinct = new Map<string, { row: T; base: string; content: string }>();
  const winnerByBase = new Map<string, string>();
  for (const row of rows) {
    const base = baseIdOf(row.id);
    const content = contentOf(row, omit);
    const winner = winnerByBase.get(base);
    if (winner === undefined || content < winner) winnerByBase.set(base, content);
    const key = `${base}\u0000${content}`;
    const seen = distinct.get(key);
    if (seen) absorb(seen.row, row);
    else distinct.set(key, { row: { ...row }, base, content });
  }

  // Sorted so that even a hash collision between two contents in one base group
  // resolves the same way whichever side merged first.
  const groups = [...distinct.values()].sort(
    (a, b) => cmpStr(a.base, b.base) || cmpStr(a.content, b.content),
  );
  const out = new Map<string, T>();
  for (const { row, base, content } of groups) {
    const id = content === winnerByBase.get(base) ? base : `${base}#dup-${shortHash(content)}`;
    const seen = out.get(id);
    if (seen) absorb(seen, row);
    else {
      row.id = id;
      out.set(id, row);
    }
  }
  return [...out.values()];
}

/**
 * unionRows for slot rows: `status` is monotonic (active → entered-in-error).
 * On corrupt input a slot can converge with ZERO active rows — every copy
 * arrived already flipped, and nothing here un-flips a monotonic status. The
 * values are still in the file; only the "current value" reads skip them.
 */
function unionSlotRows<T extends SlottableRow>(rows: T[]): T[] {
  return unionRows(rows, ['status'], (target, source) => {
    if (source.status === 'entered-in-error') target.status = 'entered-in-error';
  });
}

/**
 * Merge two lists of append-only rows that obey the one-active-per-slot
 * invariant. Slot = (metricKey, day-of-recordedAt). Generic over the metric
 * field name (`metricType` for measurements, `metricName` for lab values).
 */
function mergeSlotted<T extends SlottableRow>(
  local: T[],
  remote: T[],
  metricKeyOf: (row: T) => string,
): T[] {
  // 1. Union by id + content. 2. Group by slot.
  const bySlot = new Map<string, T[]>();
  for (const row of unionSlotRows([...remote, ...local])) {
    const slot = `${metricKeyOf(row)}@${dayOf(row.recordedAt)}`;
    const arr = bySlot.get(slot);
    if (arr) arr.push(row);
    else bySlot.set(slot, [row]);
  }

  // 3. Within each slot, keep exactly one `active` (the newest). Any other
  //    still-active rows (same-day double entry, or a correction race) are
  //    demoted to 'entered-in-error' — preserved in history, never deleted.
  const out: T[] = [];
  for (const rows of bySlot.values()) {
    const actives = rows.filter((r) => r.status === 'active');
    if (actives.length > 1) {
      let winner = actives[0];
      for (const r of actives) if (rowIsNewer(r, winner)) winner = r;
      for (const r of rows) {
        if (r.status === 'active' && r.id !== winner.id) r.status = 'entered-in-error';
      }
    }
    out.push(...rows);
  }

  out.sort((a, b) => cmpStr(a.id, b.id));
  return out;
}

/**
 * Recency for a mutable record: the clock order (`cmpClock`), then the
 * deterministic content tie-break. Returns true if `a` should win over `b`.
 */
function stampIsNewer(a: SyncStamp, b: SyncStamp): boolean {
  const order = cmpClock(clockOf(a), clockOf(b));
  return order !== 0 ? order > 0 : stableStringify(a) > stableStringify(b);
}

/** Per-key last-write-wins for current-state lists (medications, supplements, prefs). */
function mergeByKey<T extends SyncStamp>(
  local: T[],
  remote: T[],
  keyOf: (row: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const row of remote) map.set(keyOf(row), row);
  for (const row of local) {
    const key = keyOf(row);
    const existing = map.get(key);
    if (!existing || stampIsNewer(row, existing)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => cmpStr(keyOf(a), keyOf(b)));
}

/**
 * Union two append-only change logs (medication/supplement history). Same
 * immutability rule as the slot rows, minus the slots: a history log has no
 * one-active-per-day contest to resolve, so a quarantined row is simply kept.
 */
function unionLog<T extends { id: string }>(local: T[], remote: T[]): T[] {
  return unionRows([...remote, ...local]).sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * Documents union: same immutability rule, plus the `deleted` tombstone, which
 * is MONOTONIC — if either side has deleted a row, the merged row is deleted
 * (mirrors the measurements' active→entered-in-error flip; without this, a
 * delete would resurrect from any copy that hadn't seen it). `deleted` is
 * therefore excluded from the content signature: a deleted and an undeleted
 * copy of one document are one row, not two.
 */
function mergeDocuments(local: FileDocument[], remote: FileDocument[]): FileDocument[] {
  return unionRows([...remote, ...local], ['deleted'], (target, source) => {
    if (source.deleted) target.deleted = true;
  }).sort((a, b) => cmpStr(a.id, b.id));
}

/** Dedup recommendation snapshots by date; on collision keep the richer one. */
function mergeSnapshots(
  local: RecommendationSnapshot[],
  remote: RecommendationSnapshot[],
): RecommendationSnapshot[] {
  const map = new Map<string, RecommendationSnapshot>();
  for (const snap of remote) map.set(snap.date, snap);
  for (const snap of local) {
    const existing = map.get(snap.date);
    if (!existing) {
      map.set(snap.date, snap);
      continue;
    }
    const richer =
      snap.suggestions.length > existing.suggestions.length ||
      (snap.suggestions.length === existing.suggestions.length &&
        stableStringify(snap) > stableStringify(existing));
    if (richer) map.set(snap.date, snap);
  }
  return [...map.values()].sort((a, b) => cmpStr(a.date, b.date));
}

/** The newer of two OPTIONAL singletons by `cmpClock`: present always
 *  beats absent. */
function pickNewerOptional<T extends SyncStamp>(
  local: T | undefined,
  remote: T | undefined,
): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return stampIsNewer(local, remote) ? local : remote;
}

/** The keys of a field-stamped singleton that are its clocks, not its fields. */
export const CLOCK_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'lamport', 'fieldStamps']);

type Clock = Required<SyncStamp>;

/** A stamp as the merge compares and stores it: the two clocks, nothing else. */
function clockOf(stamp: SyncStamp): Clock {
  return { lamport: stamp.lamport ?? 0, updatedAt: stamp.updatedAt };
}

/** A stamp's time as the merge orders it: the instant, or -Infinity for a
 *  time that is unknown (`""` after migrate) or does not parse. */
function timeOf(iso: string | undefined): number {
  const t = stampInstant(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * -1, 0 or 1: the newer edit by clock time wins (US-10 AC8, Brad 2026-10-22);
 * the lamport only breaks a tie in time. Two spellings of one instant with one
 * lamport compare 0, so a winner falls to the value or content tie-break, never
 * to the spelling. Wall-clock time is not skew-proof: a device whose clock runs
 * ahead wins until real time passes it, or until an edit made after seeing it,
 * which stamps no earlier (`laterStamp`).
 */
function cmpClock(a: Clock, b: Clock): number {
  const [ta, tb] = [timeOf(a.updatedAt), timeOf(b.updatedAt)];
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.lamport === b.lamport ? 0 : a.lamport < b.lamport ? -1 : 1;
}

/** `cmpClock`, then the spelling: which of two clocks to STORE, so a tie
 *  writes the same spelling whichever side merges. Never picks a value. */
function cmpStored(a: Clock, b: Clock): number {
  return cmpClock(a, b) || cmpStr(a.updatedAt, b.updatedAt);
}

/**
 * The time a write stamps: `now`, or the stamp it replaces when that is later
 * (US-10 AC8). With the counter one past it too, an edit always beats the
 * value it was made on, even one a clock running ahead stamped. The merge
 * itself cannot read `now` and stay pure, so this is the skew guard.
 */
export function laterStamp(now: string, replaced: string | undefined): string {
  return timeOf(replaced) > timeOf(now) ? (replaced as string) : now;
}

/** A field's value, own properties only: a field named `__proto__` in a
 *  hand-edited file is a field, and one no object holds is undefined. */
function fieldValue(obj: FieldStamped, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, field) ? (obj as unknown as Record<string, unknown>)[field] : undefined;
}

/**
 * When each field of a profile or the screening answers was last written, as
 * the merge reads it: a clock, or null for a field nobody has written. It is a
 * pure function of the one object, which is what makes the merge give one
 * answer in any order (US-10 AC6).
 *
 * The stamp invariant: the object's own stamp is at or above every field
 * stamp. `stampFields` keeps it by stamping a write past every clock the
 * object holds; `mergeFields` by taking the newest winning field clock as the
 * result's stamp. Field stamps count while the object's stamp is not past the
 * newest of them. When it runs ahead, a writer that does not stamp fields (an
 * app from before 2026-09-25, or a hand edit under the agent rules) moved it,
 * left the field stamps as it found them, and cannot say which fields it
 * changed. Then, and when there are no field stamps at all, every field the
 * object holds, or has a stamp for, carries the object's stamp. A field it
 * neither holds nor stamps was never written: no writer deletes a key, so an
 * absence says nothing.
 */
function fieldClock(obj: FieldStamped): (field: string) => Clock | null {
  const own = clockOf(obj);
  const stamps = new Map(Object.entries(obj.fieldStamps ?? {}).map(([field, stamp]) => [field, clockOf(stamp)]));
  let newest: Clock | null = null;
  for (const clock of stamps.values()) if (!newest || cmpClock(clock, newest) > 0) newest = clock;
  const stale = !newest || cmpClock(own, newest) > 0;
  return (field) =>
    (stale ? undefined : stamps.get(field)) ?? (stamps.has(field) || fieldValue(obj, field) !== undefined ? own : null);
}

/** The keys a clock is read for: every field the object holds or has stamped. */
function fieldNames(...objs: FieldStamped[]): string[] {
  const names = new Set(objs.flatMap((obj) => [...Object.keys(obj), ...Object.keys(obj.fieldStamps ?? {})]));
  return [...names].filter((name) => !CLOCK_KEYS.has(name)).sort();
}

/**
 * Merge a profile or the screening answers field by field (US-10 AC6). Each
 * field takes its newer write, so a copy that changed one field no longer
 * carries its old copy of every other. `fieldStamps` records each field's
 * winning clock and the object's own stamp is the newest of them, so the
 * result reads back exactly as it was merged, and the merge is commutative,
 * associative and idempotent. Two copies from before field stamps merge the
 * same way: the union of their fields, the newer object's value where both
 * hold one, and the result gains `fieldStamps`.
 *
 * An object that holds no field, and stamps none, says nothing. The empty
 * record made for a missing file is one, stamped now; its fresh stamp once
 * beat every field of a copy whose lamport was 0 or absent, and emptied it. Of
 * two such objects the older stamp stays, so a fresh empty record changes
 * nothing.
 */
function mergeFields<T extends FieldStamped>(local: T, remote: T): T {
  const localAt = fieldClock(local);
  const remoteAt = fieldClock(remote);
  const values: Array<[string, unknown]> = [];
  const stamps: Array<[string, Clock]> = [];
  let newest: Clock | null = null;
  for (const field of fieldNames(local, remote)) {
    const a = localAt(field);
    const b = remoteAt(field);
    if (!a && !b) continue;
    const l = fieldValue(local, field);
    const r = fieldValue(remote, field);
    // A field never written loses to any write. Tied clocks are one write seen
    // twice, or a hand edit that moved no clock: the larger value wins, so
    // every order picks the same one.
    const order = !b ? 1 : !a ? -1 : cmpClock(a, b);
    const takeLocal = order > 0 ||
      (order === 0 && l !== r && (stableStringify(l) ?? '') > (stableStringify(r) ?? ''));
    const value = takeLocal ? l : r;
    const clock = order > 0 ? a! : order < 0 ? b! : cmpStored(a!, b!) <= 0 ? a! : b!;
    if (value !== undefined) values.push([field, value]);
    stamps.push([field, clock]);
    if (!newest || cmpStored(clock, newest) > 0) newest = clock;
  }
  const older = cmpStored(clockOf(local), clockOf(remote)) <= 0 ? clockOf(local) : clockOf(remote);
  // Built from entries, never by assignment: a field named `__proto__` in a
  // hand-edited file must stay a field.
  return {
    ...Object.fromEntries(values),
    ...(newest ?? older),
    ...(stamps.length > 0 ? { fieldStamps: Object.fromEntries(stamps) } : null),
  } as T;
}

/**
 * A write to some fields of a profile or the screening answers (US-10 AC6).
 * The fields written take one new stamp, a lamport past every clock the
 * object holds, at `now` or the latest of those clocks if later (AC8); every
 * other field keeps the clock the merge reads for it now, so the object's new
 * stamp is not taken for theirs. Pass only the fields
 * that changed. Returns a new object; the one given is untouched.
 */
export function stampFields<T extends FieldStamped>(obj: T, changes: Partial<T>, now: string): T {
  const at = fieldClock(obj);
  const kept = fieldNames(obj).flatMap((field): Array<[string, Clock]> => {
    const clock = at(field);
    return clock ? [[field, clock]] : [];
  });
  const clocks = [clockOf(obj), ...kept.map(([, clock]) => clock)];
  const stamp = {
    lamport: 1 + Math.max(...clocks.map((clock) => clock.lamport)),
    updatedAt: clocks.reduce((time, clock) => laterStamp(time, clock.updatedAt), now),
  };
  return {
    ...obj,
    ...changes,
    ...stamp,
    fieldStamps: Object.fromEntries([...kept, ...Object.keys(changes).map((field): [string, Clock] => [field, stamp])]),
  };
}

/**
 * The arrays whose rows carry an id, and the stamp that says when each row was
 * written. One table, so a new array is added here and nowhere else: an erase
 * lists these rows, and the merge drops them by it (US-09 AC23).
 * `reminderPreferences` and `recommendationSnapshots` are absent on purpose:
 * they carry no id, and the epoch gate gives them to the winner whole.
 */
const ROW_STAMPS = {
  measurements: (r: FileMeasurement) => r.createdAt,
  labValues: (r: FileLabValue) => r.createdAt,
  documents: (r: FileDocument) => r.addedAt,
  medications: (r: FileMedication) => r.updatedAt,
  medicationHistory: (r: FileMedication) => r.updatedAt,
  supplements: (r: FileSupplement) => r.updatedAt,
  supplementHistory: (r: FileSupplement) => r.updatedAt,
} as const;

type StampedArray = keyof typeof ROW_STAMPS;

/**
 * The arrays whose stamp is a true creation time, the only ones `erasedAt`
 * rescues past an erase that listed nothing (US-09 AC20, AC23). The rest are
 * stamped by `updatedAt`, which a stale copy bumps on a row that predates the
 * erase (a removed supplement, a statin cascade), so their stamp is no proof
 * the row was created after it.
 */
const CREATED_STAMPS: readonly StampedArray[] = ['measurements', 'labValues', 'documents'];

/** The stamp grammar `migrate.ts` accepts: a day, alone or with a time after a
 *  T, a t or a space, and an optional zone (Z, z, +HHMM or +HH:MM; an hour-only
 *  +HH only after a space, Postgres's text style). */
const STAMP_PARTS = /^(\d{4}-\d{2}-\d{2})(?:(?:[Tt](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})?)|(?: (\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?)?))?$/;

/**
 * An ISO stamp as an instant; NaN when it is not a string or not a stamp, and
 * NaN compares false. A date-time with no zone reads as UTC, as a date-only
 * string already does, never as this machine's local time. The stamp is
 * rebuilt in the one form ECMAScript defines before parsing, and a day the
 * calendar lacks or a time past 23:59:59 is NaN, so V8 and the iPhone's
 * JavaScriptCore give the same answer for every string (US-10 AC8 review, R3, N1).
 */
export function stampInstant(iso: unknown): number {
  const m = typeof iso === 'string' ? STAMP_PARTS.exec(iso) : null;
  if (!m) return NaN;
  const [day, time, fraction, zone] = [m[1], m[2] ?? m[5], m[3] ?? m[6], m[4] ?? m[7]];
  // Engines differ on what they roll over (V8 reads 2026-02-30 as March 2),
  // so a day the calendar lacks, an hour of 24 or a leap second is no time.
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi, s = 0] = (time ?? '00:00').split(':').map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return NaN;
  if (time === undefined) return Date.parse(day);
  const offset = !zone || /^[Zz]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
  return Date.parse(`${day}T${time}${fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : ''}${offset}`);
}

/** The later of two ISO stamps as instants; of one instant in two spellings,
 *  the larger string, so the choice is the same in either order. */
export function latestStamp(a: string, b: string): string {
  const [ta, tb] = [timeOf(a), timeOf(b)];
  return ta !== tb ? (ta > tb ? a : b) : a > b ? a : b;
}

/** The root id of every row in the file: what an erase made now would list
 *  (US-09 AC23). A row whose id is not a string has no root, and is skipped. */
export function rowRootIds(file: RoadmapFile): string[] {
  return (Object.keys(ROW_STAMPS) as StampedArray[]).flatMap((key) =>
    (file[key] as Array<{ id: unknown }>).flatMap((row) => (typeof row.id === 'string' ? [rootIdOf(row.id)] : [])));
}

/** `file` without the rows `listed` names, from every array that carries ids;
 *  the same object when it names none (US-09 AC23). */
export function withoutListed(file: RoadmapFile, listed: ReadonlySet<string>): RoadmapFile {
  if (listed.size === 0) return file;
  const out: Record<string, unknown> = { ...file };
  for (const key of Object.keys(ROW_STAMPS) as StampedArray[]) {
    out[key] = (file[key] as Array<{ id: unknown }>).filter((row) => typeof row.id !== 'string' || !listed.has(rootIdOf(row.id)));
  }
  return out as unknown as RoadmapFile;
}

/**
 * The merged erase list (US-09 AC23). The ids always union. Across the gate
 * the winner's `fromEpoch` stands, and a winner with no list gives
 * `eraseEpoch + 1`: the ids stay, and the list claims nothing. At equal
 * epochs an absent list may be a separate erase at that epoch that listed
 * nothing, so it claims nothing there either; of two lists the larger
 * `fromEpoch` stands, because it claims less.
 */
/** Whether the file's list claims its own epoch's erase (`fromEpoch` at or
 *  below `eraseEpoch`); `eraseEpoch + 1` claims nothing (US-09 AC23). */
function listsThisEpoch(file: RoadmapFile): boolean {
  return file.erasedRows !== undefined && file.erasedRows.fromEpoch <= (file.meta.eraseEpoch ?? 0);
}

export function mergeErasedRows(local: RoadmapFile, remote: RoadmapFile): ErasedRows | undefined {
  const [a, b] = [local.erasedRows, remote.erasedRows];
  if (!a && !b) return undefined;
  const ids = [...new Set([...(a?.ids ?? []), ...(b?.ids ?? [])])].sort(cmpStr);
  const [epochA, epochB] = [local.meta.eraseEpoch ?? 0, remote.meta.eraseEpoch ?? 0];
  if (epochA === epochB) return { fromEpoch: a && b ? Math.max(a.fromEpoch, b.fromEpoch) : epochA + 1, ids };
  const [winner, epoch] = epochA > epochB ? [a, epochA] : [b, epochB];
  return { fromEpoch: winner ? winner.fromEpoch : epoch + 1, ids };
}

/**
 * What the losing side of the epoch gate may bring to the winner: its rows
 * that `admit` passes, and nothing else. The result is the winner's file plus
 * those rows. The caller then runs the ordinary equal-epoch merge, which puts
 * them through the same slot, key and union rules as any other row: no slot
 * ends with two active rows, no id lands twice, and the erase itself still
 * stands.
 *
 * Taking the non-row fields from the winner is what makes this safe. `profile`,
 * `screenings` and `reminderOptIn` are single last-write-wins objects, so a
 * copy that predates the erase could otherwise win one of them on its stale
 * clock and resurrect it; `reminderPreferences` and `recommendationSnapshots`
 * carry no id an erase could list; `meta` (epoch, lamport, clocks) is the
 * winner's by definition. None of them travel — an edit to the profile or the
 * screening answers on the losing copy is still lost to the gate.
 *
 * Returns null when nothing passes, so the gate returns the winner untouched.
 */
function rowsSince(
  loser: RoadmapFile,
  winner: RoadmapFile,
  admit: (key: StampedArray, stamp: string) => boolean,
): RoadmapFile | null {
  const kept: Record<string, unknown[]> = {};
  let wrote = false;
  // Carry rescued clocks into the file's last-write anchor so migration
  // does not rewind rescued mutable updatedAt stamps. Immutable createdAt
  // and addedAt are preserved regardless of this anchor.
  let latest = winner.meta.updatedAt;
  for (const key of Object.keys(ROW_STAMPS) as StampedArray[]) {
    const stamp = ROW_STAMPS[key] as (row: unknown) => string;
    // A row with no string id has no identity to merge on (US-09 AC23).
    const rows = (loser[key] as Array<{ id: unknown }>).filter((row) => typeof row.id === 'string' && admit(key, stamp(row)));
    for (const row of rows) if (stampInstant(stamp(row)) > stampInstant(latest)) latest = stamp(row);
    if (rows.length > 0) wrote = true;
    kept[key] = rows;
  }
  // The higher lamport rides along, so the re-merge's max + 1 is over BOTH copies.
  const lamport = Math.max(loser.meta.lamport, winner.meta.lamport);
  return wrote
    ? ({ ...winner, ...kept, meta: { ...winner.meta, updatedAt: latest, lamport } } as RoadmapFile)
    : null;
}

/** The later of two erase times, as instants, as a meta fragment; empty when
 *  neither has one. A tie between two spellings of one instant takes the
 *  larger string, so the merge stays symmetric. */
function laterErase(a: string | undefined, b: string | undefined): { erasedAt?: string } {
  const [ta, tb] = [a, b].map((s) => (Number.isNaN(stampInstant(s)) ? -Infinity : stampInstant(s)));
  const bLater = a === undefined || (b !== undefined && (tb > ta || (tb === ta && b > a)));
  const at = bLater ? b : a;
  return at === undefined ? {} : { erasedAt: at };
}

/**
 * Merge `remote` (just read from the cloud) into `local` (this device's working
 * copy), producing the file to write back. Deterministic and symmetric.
 */
export function mergeFiles(
  localCopy: RoadmapFile,
  remoteCopy: RoadmapFile,
  opts: MergeOptions,
): RoadmapFile {
  // An erased row never comes back, whichever copy holds it and whatever its
  // clocks say: the listed rows go first, from both sides (US-09 AC23).
  const erasedRows = mergeErasedRows(localCopy, remoteCopy);
  const listed = new Set(erasedRows?.ids);
  const local = withoutListed(localCopy, listed);
  const remote = withoutListed(remoteCopy, listed);
  // A listed file is one a reader from before the list must refuse.
  const listing = {
    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion, erasedRows ? CURRENT_SCHEMA_VERSION : BASE_SCHEMA_VERSION),
    ...(erasedRows ? { erasedRows } : null),
  };
  // "Delete All My Data" gate: a higher eraseEpoch wins. The union semantics
  // below deliberately never lose data — which is exactly wrong for deletion:
  // without this gate, any other copy would resurrect the erased records on
  // its next sync. The losing side never saw the erase; which of its rows
  // survive is decided below.
  const localEpoch = local.meta.eraseEpoch ?? 0;
  const remoteEpoch = remote.meta.eraseEpoch ?? 0;
  // The file's clock only ever moves forward. Migration clamps mutable row
  // and field updatedAt to the file's last write, so a lagging device must not
  // rewind that anchor. Immutable createdAt/addedAt are never clamped.
  const updatedAt = [opts.now, local.meta.updatedAt, remote.meta.updatedAt].reduce(latestStamp);
  if (localEpoch !== remoteEpoch) {
    const localWins = localEpoch > remoteEpoch;
    const [top, loser] = localWins ? [local, remote] : [remote, local];
    const winner = { ...top, ...listing };
    // Re-merge what the loser may keep — on the winner's file, at the
    // winner's epoch — through the ordinary path below, which for those two
    // inputs is an equal-epoch merge. When every erase the loser missed listed
    // its ids, a row none of them listed is one no erase saw, so all its
    // unlisted rows stay (US-09 AC23). Past an erase that listed nothing, only
    // the rows it created at or after the winner's `erasedAt` (AC20): `>=`
    // keeps a row that shares the erase's millisecond, and a stamp that does
    // not parse is dropped.
    const list = top.erasedRows;
    const erasedAt = winner.meta.erasedAt;
    const admit = list && Math.min(localEpoch, remoteEpoch) >= list.fromEpoch - 1
      ? () => true
      : erasedAt === undefined
        ? null
        : (key: StampedArray, stamp: string) => CREATED_STAMPS.includes(key) && stampInstant(stamp) >= stampInstant(erasedAt);
    const kept = admit ? rowsSince(loser, winner, admit) : null;
    if (kept) {
      // `now: updatedAt` carries the max over BOTH metas into the re-merge —
      // the pruned copy wears the winner's meta, so the loser's own clock
      // would otherwise be dropped here (the never-rewind guard above).
      const next = { ...opts, now: updatedAt };
      return localWins ? mergeFiles(winner, kept, next) : mergeFiles(kept, winner, next);
    }
    return {
      ...winner,
      meta: {
        ...winner.meta,
        updatedAt,
        lastDeviceId: opts.deviceId,
        lamport: Math.max(local.meta.lamport, remote.meta.lamport) + 1,
        eraseEpoch: Math.max(localEpoch, remoteEpoch),
      },
    };
  }

  return {
    // Spread both first so unknown/future top-level fields are preserved at
    // runtime (H7). Known fields below overwrite these.
    ...remote,
    ...local,

    ...listing,
    meta: {
      createdAt:
        local.meta.createdAt < remote.meta.createdAt ? local.meta.createdAt : remote.meta.createdAt,
      updatedAt,
      lastDeviceId: opts.deviceId,
      lamport: Math.max(local.meta.lamport, remote.meta.lamport) + 1,
      eraseEpoch: localEpoch, // equal on both sides in this branch
      // When one side's list covers this epoch and the other's does not, the
      // listing erase's rows go by id; the time that still decides is the
      // unlisted erase's, or a copy that missed it would lose rows typed
      // between the two (US-09 AC23). A list that claims nothing counts as
      // no list.
      ...(listsThisEpoch(local) === listsThisEpoch(remote)
        ? laterErase(local.meta.erasedAt, remote.meta.erasedAt)
        : laterErase((listsThisEpoch(local) ? remote : local).meta.erasedAt, undefined)),
    },

    profile: mergeFields<RoadmapProfile>(local.profile, remote.profile),
    screenings: mergeFields<FileScreenings>(local.screenings, remote.screenings),
    reminderOptIn: pickNewerOptional<FileReminderOptIn>(
      local.reminderOptIn,
      remote.reminderOptIn,
    ),

    measurements: mergeSlotted<FileMeasurement>(
      local.measurements,
      remote.measurements,
      (r) => r.metricType,
    ),
    labValues: mergeSlotted<FileLabValue>(local.labValues, remote.labValues, (r) => labSlotKey(r.metricName)),

    medications: mergeByKey<FileMedication>(
      local.medications,
      remote.medications,
      (r) => r.medicationKey,
    ),
    supplements: mergeByKey<FileSupplement>(
      local.supplements,
      remote.supplements,
      (r) => r.supplementKey,
    ),
    reminderPreferences: mergeByKey<FileReminderPreference>(
      local.reminderPreferences,
      remote.reminderPreferences,
      (r) => r.category,
    ),

    medicationHistory: unionLog<FileMedication>(local.medicationHistory, remote.medicationHistory),
    supplementHistory: unionLog<FileSupplement>(local.supplementHistory, remote.supplementHistory),
    documents: mergeDocuments(local.documents, remote.documents),

    recommendationSnapshots: mergeSnapshots(
      local.recommendationSnapshots,
      remote.recommendationSnapshots,
    ),
  } as RoadmapFile;
}
