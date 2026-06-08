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
 *  - medicationHistory / supplementHistory / documents → append-only logs, union by id.
 *  - recommendationSnapshots → deduped by date.
 *  - meta.lamport → max(local, remote) + 1.
 */
import {
  stableStringify,
  type RoadmapFile,
  type FileMeasurement,
  type FileLabValue,
  type FileMedication,
  type FileSupplement,
  type FileReminderPreference,
  type FileDocument,
  type RoadmapProfile,
  type FileScreenings,
  type RecommendationSnapshot,
  type SyncStamp,
} from './roadmap-file';
import type { MeasurementStatus } from './validation';

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

/** Stable string comparison (-1 | 0 | 1). */
function cmpStr(a: string, b: string): number {
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
 * Merge two lists of append-only rows that obey the one-active-per-slot
 * invariant. Slot = (metricKey, day-of-recordedAt). Generic over the metric
 * field name (`metricType` for measurements, `metricName` for lab values).
 */
function mergeSlotted<T extends SlottableRow>(
  local: T[],
  remote: T[],
  metricKeyOf: (row: T) => string,
): T[] {
  // 1. Union by id. A row is immutable except for its monotonic status flip,
  //    so if either side has it as 'entered-in-error', the merged row is too.
  const byId = new Map<string, T>();
  for (const row of [...remote, ...local]) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, { ...row });
      continue;
    }
    const status: MeasurementStatus =
      existing.status === 'entered-in-error' || row.status === 'entered-in-error'
        ? 'entered-in-error'
        : 'active';
    byId.set(row.id, { ...existing, status });
  }

  // 2. Group by slot.
  const bySlot = new Map<string, T[]>();
  for (const row of byId.values()) {
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

/** Union two append-only logs by id (rows are immutable; keep one copy). */
function unionById<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of remote) map.set(row.id, row);
  for (const row of local) if (!map.has(row.id)) map.set(row.id, row);
  return [...map.values()].sort((a, b) => cmpStr(a.id, b.id));
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

/**
 * Merge `remote` (just read from the cloud) into `local` (this device's working
 * copy), producing the file to write back. Deterministic and symmetric.
 */
export function mergeFiles(
  local: RoadmapFile,
  remote: RoadmapFile,
  opts: MergeOptions,
): RoadmapFile {
  return {
    // Spread both first so unknown/future top-level fields are preserved at
    // runtime (H7). Known fields below overwrite these.
    ...remote,
    ...local,

    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
    meta: {
      createdAt:
        local.meta.createdAt < remote.meta.createdAt ? local.meta.createdAt : remote.meta.createdAt,
      updatedAt: opts.now,
      lastDeviceId: opts.deviceId,
      lamport: Math.max(local.meta.lamport, remote.meta.lamport) + 1,
    },

    profile: pickNewer<RoadmapProfile>(local.profile, remote.profile),
    screenings: pickNewer<FileScreenings>(local.screenings, remote.screenings),

    measurements: mergeSlotted<FileMeasurement>(
      local.measurements,
      remote.measurements,
      (r) => r.metricType,
    ),
    labValues: mergeSlotted<FileLabValue>(local.labValues, remote.labValues, (r) => r.metricName),

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

    medicationHistory: unionById<FileMedication>(local.medicationHistory, remote.medicationHistory),
    supplementHistory: unionById<FileSupplement>(local.supplementHistory, remote.supplementHistory),
    documents: unionById<FileDocument>(local.documents, remote.documents),

    recommendationSnapshots: mergeSnapshots(
      local.recommendationSnapshots,
      remote.recommendationSnapshots,
    ),
  } as RoadmapFile;
}
