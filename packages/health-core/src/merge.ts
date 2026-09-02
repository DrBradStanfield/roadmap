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
 *  - profile / screenings → singletons, same logical-clock LWW.
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
 */
function baseIdOf(id: string): string {
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
    const winner = localEpoch > remoteEpoch ? local : remote;
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

    profile: pickNewer<RoadmapProfile>(local.profile, remote.profile),
    screenings: pickNewer<FileScreenings>(local.screenings, remote.screenings),
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
