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
 *    their natural key, last-write-wins by LOGICAL clock (lamport), not wall-clock.
 *  - profile / screenings → singletons, the same logical-clock LWW field by
 *    field (`mergeFields`).
 *  - medicationHistory / supplementHistory / documents → append-only logs, union
 *    by (id, content); documents also OR the `deleted` tombstone.
 *  - recommendationSnapshots → deduped by date.
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
  stableStringify,
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
  /**
   * The instant this device started working on its own copy, because the cloud
   * could not be read (US-09 AC13). Only the epoch gate below reads it, and
   * only when `local` is the device copy and `remote` wins: the ROWS `local`
   * stamped at or after it (the arrays in `ROW_STAMPS`) are re-merged onto the
   * winner instead of going with the rest. Nothing else travels — `profile`,
   * `screenings` and `reminderOptIn` are last-write-wins singletons a stale
   * device clock could resurrect, `recommendationSnapshots` carries no stamp to
   * judge by, and `meta` (epoch, lamport, clocks) is the winner's by
   * definition. Absent, as in every other caller, the merge is what it was.
   */
  keepNewerThan?: string;
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
 * Logical-clock recency for a mutable record. lamport is primary (skew-proof);
 * wall-clock `updatedAt` then deterministic content hash break ties.
 * Returns true if `a` should win over `b`.
 */
function stampIsNewer(a: SyncStamp, b: SyncStamp): boolean {
  const la = a.lamport ?? 0;
  const lb = b.lamport ?? 0;
  if (la !== lb) return la > lb;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return stableStringify(a) > stableStringify(b);
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

/** Pick the newer of two singleton objects by logical clock. */
function pickNewer<T extends SyncStamp>(local: T, remote: T): T {
  return stampIsNewer(local, remote) ? local : remote;
}

/** pickNewer for OPTIONAL singletons: present always beats absent. */
function pickNewerOptional<T extends SyncStamp>(
  local: T | undefined,
  remote: T | undefined,
): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return pickNewer(local, remote);
}

/** The keys of a field-stamped singleton that are its clocks, not its fields. */
const CLOCK_KEYS = new Set(['updatedAt', 'lamport', 'fieldStamps']);

type Clock = Required<SyncStamp>;

/** A stamp as the merge compares and stores it: the two clocks, nothing else. */
function clockOf(stamp: SyncStamp): Clock {
  return { lamport: stamp.lamport ?? 0, updatedAt: stamp.updatedAt };
}

/**
 * When each field of a profile or the screening answers was last written, as
 * the merge reads it: a stamp, or null for a field nobody has written.
 *
 * Field stamps count only while the object's own stamp is no newer than the
 * newest of them. A writer that does not stamp fields (an app from before
 * 2026-09-25, or a hand edit under the agent rules) moves the object's stamp,
 * leaves the field stamps as it found them, and cannot say which fields it
 * changed. Then, and when there are no field stamps at all, every field,
 * present or absent, carries the object's stamp: the whole-object rule the
 * merge always had. Otherwise a field with no stamp of its own carries the
 * object's if it holds a value, and none if it does not.
 */
function fieldClock(obj: FieldStamped): (field: string) => Clock | null {
  const own = clockOf(obj);
  const stamps = new Map(Object.entries(obj.fieldStamps ?? {}).map(([field, stamp]) => [field, clockOf(stamp)]));
  let newest: Clock | null = null;
  for (const clock of stamps.values()) if (!newest || stampIsNewer(clock, newest)) newest = clock;
  if (!newest || stampIsNewer(own, newest)) return () => own;
  const values = obj as unknown as Record<string, unknown>;
  return (field) => stamps.get(field) ?? (values[field] === undefined ? null : own);
}

/** The keys a clock is read for: every field the object holds or has stamped. */
function fieldNames(...objs: FieldStamped[]): string[] {
  const names = new Set(objs.flatMap((obj) => [...Object.keys(obj), ...Object.keys(obj.fieldStamps ?? {})]));
  return [...names].filter((name) => !CLOCK_KEYS.has(name)).sort();
}

/**
 * Merge a profile or the screening answers field by field (US-10 AC6). Each
 * field takes its newer write, so a copy that changed one field no longer
 * carries its old copy of every other. The object's own stamp is the newer of
 * the two, and `fieldStamps` records each field's winner, so the next merge
 * reads the result the same way. Two copies with no field stamps merge
 * exactly as they always did: the whole newer object.
 */
function mergeFields<T extends FieldStamped>(local: T, remote: T): T {
  const stamped = (obj: T) => Object.keys(obj.fieldStamps ?? {}).length > 0;
  if (!stamped(local) && !stamped(remote)) return pickNewer(local, remote);
  const localAt = fieldClock(local);
  const remoteAt = fieldClock(remote);
  const l = local as unknown as Record<string, unknown>;
  const r = remote as unknown as Record<string, unknown>;
  const values: Array<[string, unknown]> = [];
  const stamps: Array<[string, Clock]> = [];
  for (const field of fieldNames(local, remote)) {
    const a = localAt(field);
    const b = remoteAt(field);
    // Tied stamps are one write seen twice, or a hand edit that moved no
    // clock: the larger value wins, so both sides pick the same one.
    const takeLocal = !b || (!!a && (stampIsNewer(a, b) ||
      (!stampIsNewer(b, a) && (stableStringify(l[field]) ?? '') > (stableStringify(r[field]) ?? ''))));
    const [value, clock] = takeLocal ? [l[field], a] : [r[field], b];
    if (value !== undefined) values.push([field, value]);
    if (clock) stamps.push([field, clock]);
  }
  const { updatedAt, lamport } = pickNewer(local, remote);
  // Built from entries, never by assignment: a field named `__proto__` in a
  // hand-edited file must stay a field.
  return {
    ...Object.fromEntries(values),
    updatedAt,
    ...(lamport === undefined ? null : { lamport }),
    ...(stamps.length > 0 ? { fieldStamps: Object.fromEntries(stamps) } : null),
  } as T;
}

/**
 * A write to some fields of a profile or the screening answers (US-10 AC6).
 * The fields written take one new stamp, a lamport past every clock the
 * object holds; every other field keeps the clock the merge reads for it now,
 * so the object's new stamp is not taken for theirs. Pass only the fields
 * that changed. Returns a new object; the one given is untouched.
 */
export function stampFields<T extends FieldStamped>(obj: T, changes: Partial<T>, now: string): T {
  const at = fieldClock(obj);
  const kept = fieldNames(obj).flatMap((field): Array<[string, Clock]> => {
    const clock = at(field);
    return clock ? [[field, clock]] : [];
  });
  const stamp = { lamport: 1 + Math.max(obj.lamport ?? 0, ...kept.map(([, clock]) => clock.lamport)), updatedAt: now };
  return {
    ...obj,
    ...changes,
    ...stamp,
    fieldStamps: Object.fromEntries([...kept, ...Object.keys(changes).map((field): [string, Clock] => [field, stamp])]),
  };
}

/**
 * The stamp that says WHEN each append-only row was written, per array. One
 * table, so a new array is added here and nowhere else. `recommendationSnapshots`
 * is absent on purpose: its entries carry no stamp and are regenerated, never
 * appended to.
 */
const ROW_STAMPS = {
  measurements: (r: FileMeasurement) => r.createdAt,
  labValues: (r: FileLabValue) => r.createdAt,
  documents: (r: FileDocument) => r.addedAt,
  medications: (r: FileMedication) => r.updatedAt,
  medicationHistory: (r: FileMedication) => r.updatedAt,
  supplements: (r: FileSupplement) => r.updatedAt,
  supplementHistory: (r: FileSupplement) => r.updatedAt,
  reminderPreferences: (r: FileReminderPreference) => r.updatedAt,
} as const;

type StampedArray = keyof typeof ROW_STAMPS;

/**
 * What a device that was cut off from the cloud (US-09 AC13) may bring back to
 * the file that just won the epoch gate: its own rows, and nothing else.
 *
 * A fallback session works on the LAST local copy — or, more often, an empty one
 * at epoch 0. If the cloud has ever been erased its epoch is higher, so the gate
 * hands it the whole file and everything the user typed meanwhile goes without a
 * word. This keeps the rows stamped at or after `since` and takes EVERY other
 * field from the winner, so the result is the winner's file plus those rows. The
 * caller then runs the ordinary equal-epoch merge, which puts them through the
 * same slot, key and union rules as any other row: no slot ends with two active
 * rows, no id lands twice, and the erase itself still stands.
 *
 * Taking the non-row fields from the winner is what makes this safe. `profile`,
 * `screenings` and `reminderOptIn` are single last-write-wins objects, so a
 * device copy that predates the erase could otherwise win one of them on its
 * stale clock and resurrect it; `recommendationSnapshots` has no stamp to judge
 * by; `meta` (epoch, lamport, clocks) is the winner's by definition. None of
 * them can travel — a fallback edit to the profile or the screening answers is
 * still lost to the gate.
 *
 * Returns null when the session wrote nothing, so the gate returns the winner
 * untouched.
 */
function pruneToFallbackRows(device: RoadmapFile, winner: RoadmapFile, since: string): RoadmapFile | null {
  // `>=`, not `>`: the marker is stamped at the moment the fallback starts, so
  // the session's first row can share its millisecond. Keeping one row too many
  // is recoverable; dropping one is not.
  const kept: Record<string, unknown[]> = {};
  let wrote = false;
  // The file's clock must stay at or ahead of every row in it: `migrate.ts`
  // clamps a row that post-dates `meta.updatedAt` back to it, which would
  // rewrite the very rows this is rescuing.
  let latest = winner.meta.updatedAt;
  for (const key of Object.keys(ROW_STAMPS) as StampedArray[]) {
    const stamp = ROW_STAMPS[key] as (row: unknown) => string;
    const rows = (device[key] as unknown[]).filter((row) => stamp(row) >= since);
    for (const row of rows) if (stamp(row) > latest) latest = stamp(row);
    if (rows.length > 0) wrote = true;
    kept[key] = rows;
  }
  return wrote
    ? ({ ...winner, ...kept, meta: { ...winner.meta, updatedAt: latest } } as RoadmapFile)
    : null;
}

/**
 * The oldest stamp on any row in the file (null when it holds none). A device
 * whose data has never reached the cloud is unsynced from here on, which is the
 * `keepNewerThan` a failed first lift marks (US-09 AC13).
 */
export function earliestRowStamp(file: RoadmapFile): string | null {
  let earliest: string | null = null;
  for (const key of Object.keys(ROW_STAMPS) as StampedArray[]) {
    const stamp = ROW_STAMPS[key] as (row: unknown) => string;
    for (const row of file[key] as unknown[]) {
      const at = stamp(row);
      if (earliest === null || at < earliest) earliest = at;
    }
  }
  return earliest;
}

/**
 * Merge `remote` (just read from the cloud) into `local` (this device's working
 * copy), producing the file to write back. Deterministic and symmetric.
 */
export function mergeFiles(
  local: RoadmapFile,
  remote: RoadmapFile,
  opts: MergeOptions,
): RoadmapFile {
  // "Delete All My Data" gate: a higher eraseEpoch wins WHOLESALE. The union
  // semantics below deliberately never lose data — which is exactly wrong for
  // deletion: without this gate, any other copy would resurrect the erased
  // records on its next sync. The losing side's content predates the erase,
  // so discarding it is the intended outcome on every device.
  const localEpoch = local.meta.eraseEpoch ?? 0;
  const remoteEpoch = remote.meta.eraseEpoch ?? 0;
  // The file's clock only ever moves forward. `migrate.ts` clamps every row
  // timestamp to meta.updatedAt, so a device whose wall clock runs backwards
  // would otherwise write a file whose own rows post-date its meta — and have
  // the next load rewrite all of them.
  const updatedAt = [opts.now, local.meta.updatedAt, remote.meta.updatedAt].reduce((a, b) =>
    a > b ? a : b,
  );
  if (localEpoch !== remoteEpoch) {
    const localWins = localEpoch > remoteEpoch;
    const winner = localWins ? local : remote;
    // The device fell back, wrote, and lost the gate: re-merge its own rows —
    // on the winner's file, at the winner's epoch — through the ordinary path
    // below, which for those two inputs is an equal-epoch merge.
    if (!localWins && opts.keepNewerThan) {
      const pruned = pruneToFallbackRows(local, winner, opts.keepNewerThan);
      // `now: updatedAt` carries the max over BOTH metas into the re-merge —
      // the pruned copy wears the winner's meta, so the device's own clock
      // would otherwise be dropped here (the never-rewind guard above).
      if (pruned) return mergeFiles(pruned, winner, { ...opts, now: updatedAt });
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

    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
    meta: {
      createdAt:
        local.meta.createdAt < remote.meta.createdAt ? local.meta.createdAt : remote.meta.createdAt,
      updatedAt,
      lastDeviceId: opts.deviceId,
      lamport: Math.max(local.meta.lamport, remote.meta.lamport) + 1,
      eraseEpoch: localEpoch, // equal on both sides in this branch
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
