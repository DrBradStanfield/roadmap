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
 *  - meta.lamport → max(local, remote) + 1, capped at MAX_COUNTER (US-10 AC8b).
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
  recordSchemaVersion,
  stableStringify,
  type ErasedRows,
  type RoadmapFile, type RowArray,
  type FileMeasurement,
  type FileLabValue,
  type FileMedication,
  type FileSupplement,
  type FileReminderPreference,
  type FileDocument,
  type FieldStamped,
  type RoadmapProfile,
  type FileScreenings,
  type RecommendationSnapshot,
  type SyncStamp,
} from './roadmap-file';
import type { MeasurementStatus } from './validation';
import { isFoldRow, labRowSlot, v2FormOf } from './core-rows';
import { clockOf, cmpClock, cmpStored, cmpStr, dayOf, laterStamp, latestStamp, mergeByKey, stampInstant, stampIsNewer, type Clock } from './record-time';
import { mergeOptIn } from './reminder-rows';
// The time and stamp primitives live in record-time.ts; these keep the old import paths working.
export { cmpStr, dayOf, daysBetween, laterStamp, latestDayOnEarth, latestStamp, localDay, stampInstant } from './record-time';

/**
 * Ceiling for the file's counters (`meta.lamport`, `meta.eraseEpoch`) — far
 * above any real value (they tick once per write) and far below
 * MAX_SAFE_INTEGER, so the `+ 1` increments that order writes always advance.
 * migrate() clamps what it reads to this; a merge must not write past it, or
 * verify-after-write compares the clamped re-read with a larger lamport and
 * every save fails as a conflict storm (US-10 AC8b).
 */
export const MAX_COUNTER = 1e12;

/** The merged file's lamport: past both copies, but never past the ceiling. */
function nextLamport(local: number, remote: number): number {
  return Math.min(Math.max(local, remote) + 1, MAX_COUNTER);
}

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

/**
 * Recency comparison for an append-only row WITHIN a slot: newer = later
 * createdAt, tie-broken by larger id (deterministic + symmetric).
 * Returns true if `a` is newer than `b`.
 */
export function rowIsNewer(a: SlottableRow, b: SlottableRow): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * Content signature of an append-only row, EXCLUDING `id` (the field a second
 * writer may have reused) and any MONOTONIC field merged separately (`status`
 * on a measurement, `deleted` on a document). Same signature = the same fact.
 * A blood test moved out of `measurements` is signed in its old form, so a
 * `#dup-` id and its base-id winner do not change with the move (US-66 AC2).
 */
function contentOf(row: object, omit: readonly string[]): string {
  const rest = { ...(v2FormOf(row) as Record<string, unknown>) };
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
 * conversion, `#core` fold and `#mv-` move suffixes stripped too, so an
 * erase that lists a row takes its quarantined copies, its unit conversion,
 * its fold into a core value and its moved copy with it (US-09 AC23, US-66
 * AC5, US-04 AC5a).
 */
export function rootIdOf(id: string): string {
  return id.replace(/(?:#dup-[0-9a-f]{8}|#si|#core|#mv-[0-9a-f]{8})+$/, '');
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
export function unionSlotRows<T extends SlottableRow>(rows: T[]): T[] {
  return unionRows(rows, ['status'], (target, source) => {
    if (source.status === 'entered-in-error') target.status = 'entered-in-error';
  });
}

/**
 * Merge two lists of append-only rows that obey the one-active-per-slot
 * invariant. Slot = (metricKey, day-of-recordedAt). `metricKeyOf` reads the
 * row (`metricType` for measurements, `labRowSlot` for lab values). A row
 * `yields` is active only when no other active row holds its slot: a fold
 * into a core value loses to a real one, whatever the clocks say (US-66 AC5).
 */
function mergeSlotted<T extends SlottableRow>(
  local: T[],
  remote: T[],
  metricKeyOf: (row: T) => string,
  yields: (row: T) => boolean = () => false,
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
      const beats = (a: T, b: T) => (yields(a) === yields(b) ? rowIsNewer(a, b) : yields(b));
      for (const r of actives) if (beats(r, winner)) winner = r;
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

/** Dedup recommendation snapshots by date, within a side as across: on a
 *  collision keep the richer one (US-10 AC15). */
function mergeSnapshots(
  local: RecommendationSnapshot[],
  remote: RecommendationSnapshot[],
): RecommendationSnapshot[] {
  const map = new Map<string, RecommendationSnapshot>();
  for (const snap of [...remote, ...local]) {
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
export function pickNewerOptional<T extends SyncStamp>(
  local: T | undefined,
  remote: T | undefined,
): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return stampIsNewer(local, remote) ? local : remote;
}

/** The keys of a field-stamped singleton that are its clocks, not its fields. */
export const CLOCK_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'lamport', 'fieldStamps']);

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

/** Whether a field's local side wins, given `cmpClock(local, remote)`. A
 *  field never written loses to any write. Tied clocks are one write seen
 *  twice, or a hand edit that moved no clock: the larger value wins, so every
 *  order picks the same one. */
function fieldWins(order: number, local: unknown, remote: unknown): boolean {
  return order > 0 ||
    (order === 0 && local !== remote && (stableStringify(local) ?? '') > (stableStringify(remote) ?? ''));
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
    const order = !b ? 1 : !a ? -1 : cmpClock(a, b);
    const takeLocal = fieldWins(order, l, r);
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
 * The stamped fields of `ours` that `stored` does not hold: each one where
 * merging `ours` in would change what `stored` keeps (US-10 AC6a). The rule is
 * `mergeFields`' own, so a field another writer stamped later is held.
 */
export function fieldsBehind<T extends FieldStamped>(ours: T, stored: T): string[] {
  const ourAt = fieldClock(ours);
  const storedAt = fieldClock(stored);
  return fieldNames(ours).filter((field) => {
    const clock = ourAt(field);
    const kept = storedAt(field);
    return clock !== null && fieldWins(kept ? cmpClock(clock, kept) : 1, fieldValue(ours, field), fieldValue(stored, field));
  });
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
} as const satisfies Record<RowArray, (r: never) => string>; // every row array, from roadmap-file.ts (lead A1-3)

type StampedArray = keyof typeof ROW_STAMPS;

/**
 * The arrays whose stamp is a true creation time, the only ones `erasedAt`
 * rescues past an erase that listed nothing (US-09 AC20, AC23). The rest are
 * stamped by `updatedAt`, which a stale copy bumps on a row that predates the
 * erase (a removed supplement, a statin cascade), so their stamp is no proof
 * the row was created after it.
 */
const CREATED_STAMPS: readonly StampedArray[] = ['measurements', 'labValues', 'documents'];

/** The root an app from before US-04 AC5a gives a row: only `#dup-…`, `#si`
 *  and `#core` stripped, so a moved row's is its own id. */
function rootBeforeMoveOf(id: string): string {
  return id.replace(/(?:#dup-[0-9a-f]{8}|#si|#core)+$/, '');
}

/** The root id of every row in the file: what an erase made now would list
 *  (US-09 AC23). A row whose id is not a string has no root, and is skipped.
 *  A moved row is listed under its own id too, as an app from before US-04
 *  AC5a roots it, so that app drops it. */
export function rowRootIds(file: RoadmapFile): string[] {
  return (Object.keys(ROW_STAMPS) as StampedArray[]).flatMap((key) =>
    (file[key] as Array<{ id: unknown }>).flatMap((row) => (typeof row.id === 'string'
      ? [...new Set([rootIdOf(row.id), rootBeforeMoveOf(row.id)])]
      : [])));
}

/** `file` without the rows `listed` names, from every array that carries ids;
 *  the same object when it names none (US-09 AC23). A row goes if its root is
 *  the root of a listed id. An app from before US-04 AC5a lists a moved row
 *  whose original is gone under the moved row's own id, `X#mv-A`; reducing
 *  that to `X` also takes `X#mv-B`, the same test moved again on a copy that
 *  had not seen the erase (Codex review of PR #337). The list itself keeps
 *  the older spelling, so that app still reads it. */
export function withoutListed(file: RoadmapFile, listed: ReadonlySet<string>): RoadmapFile {
  if (listed.size === 0) return file;
  const roots = new Set([...listed].map(rootIdOf));
  const out: Record<string, unknown> = { ...file };
  for (const key of Object.keys(ROW_STAMPS) as StampedArray[]) {
    out[key] = (file[key] as Array<{ id: unknown }>).filter((row) => typeof row.id !== 'string' || !roots.has(rootIdOf(row.id)));
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

/** Erase time `b` is later than `a`, the merge's and the erase identity's one order (US-11 AC6): none is earliest, then
 *  instants (no time is -Infinity), a tie takes the larger string. `laterErase`: the later as a meta fragment, or none. */
export function eraseTimeLater(b: string | undefined, a: string | undefined): boolean {
  const [ta, tb] = [a, b].map((s) => (Number.isNaN(stampInstant(s)) ? -Infinity : stampInstant(s)));
  return b !== undefined && (a === undefined || tb > ta || (tb === ta && b > a));
}
function laterErase(a: string | undefined, b: string | undefined): { erasedAt?: string } {
  return eraseTimeLater(b, a) ? { erasedAt: b! } : a === undefined ? {} : { erasedAt: a };
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
  // A listed file, or one holding a core row, is one an older reader must
  // refuse (US-09 AC23, US-66 AC15). Never lower than either side.
  const listing = {
    schemaVersion: Math.max(recordSchemaVersion(local), recordSchemaVersion(remote), recordSchemaVersion({ erasedRows })),
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
      // One row per key here too, as in any merge (US-10 AC15).
      ...mergeKeyed(winner, NO_KEYED),
      meta: {
        ...winner.meta,
        updatedAt,
        lastDeviceId: opts.deviceId,
        lamport: nextLamport(local.meta.lamport, remote.meta.lamport),
        eraseEpoch: Math.max(localEpoch, remoteEpoch),
      },
    };
  }

  const merged = {
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
      lamport: nextLamport(local.meta.lamport, remote.meta.lamport),
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
    reminderOptIn: mergeOptIn(local.reminderOptIn, remote.reminderOptIn),

    measurements: mergeSlotted<FileMeasurement>(
      local.measurements,
      remote.measurements,
      (r) => r.metricType,
    ),
    labValues: mergeSlotted<FileLabValue>(local.labValues, remote.labValues, labRowSlot, isFoldRow),

    ...mergeKeyed(local, remote),

    medicationHistory: unionLog<FileMedication>(local.medicationHistory, remote.medicationHistory),
    supplementHistory: unionLog<FileSupplement>(local.supplementHistory, remote.supplementHistory),
    documents: mergeDocuments(local.documents, remote.documents),
  } as RoadmapFile;
  // Stamped on what the merge holds: the merge that first writes opt-in `tokens` lifts the file (US-17 AC19).
  return { ...merged, schemaVersion: recordSchemaVersion(merged) };
}

type KeyedLists = Pick<RoadmapFile, 'medications' | 'supplements' | 'reminderPreferences' | 'recommendationSnapshots'>;
const NO_KEYED: KeyedLists = { medications: [], supplements: [], reminderPreferences: [], recommendationSnapshots: [] };

/** The lists that keep one row per key, within a copy as across (US-10 AC15). */
function mergeKeyed(local: KeyedLists, remote: KeyedLists): KeyedLists {
  return {
    medications: mergeByKey<FileMedication>(local.medications, remote.medications, (r) => r.medicationKey),
    supplements: mergeByKey<FileSupplement>(local.supplements, remote.supplements, (r) => r.supplementKey),
    reminderPreferences: mergeByKey<FileReminderPreference>(local.reminderPreferences, remote.reminderPreferences, (r) => r.category),
    recommendationSnapshots: mergeSnapshots(local.recommendationSnapshots, remote.recommendationSnapshots),
  };
}
