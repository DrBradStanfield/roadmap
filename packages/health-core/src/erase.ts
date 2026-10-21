/**
 * The erased record: what "Delete All My Data" writes (US-11, US-09 AC20 and
 * AC23). Pure arithmetic over the copies the eraser has read; the reading,
 * the write and the cleanup are the caller's. The web widget's RoadmapStore
 * calls it, and so will the iPhone app, so both erase by one rule.
 */
import { mergeErasedRows, rowRootIds, stampInstant } from './merge';
import { migrateFile } from './migrate';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from './roadmap-file';
import type { SyncContext } from './sync-manager';

export interface EraseInputs {
  /** The stored record, read at erase time; null when it could not be read
   *  (only the device tier erases then: there is no other copy to list). */
  stored: RoadmapFile | null;
  /** The eraser's own working copy. */
  own: RoadmapFile;
  /** On a cloud, the device copy where failed saves wait; null when there is
   *  none or it could not be read into a record. */
  device: RoadmapFile | null;
  ctx: SyncContext;
}

export function buildErasedFile({ stored, own, device, ctx }: EraseInputs): RoadmapFile {
  // Bump the erase epoch so the empty file BEATS the merge — persist goes
  // through read-merge-write, whose never-lose-data semantics would otherwise
  // resurrect every record from the stored copy (and any other device's).
  // Bump past the stored epoch as well (US-11 AC7), and past the device
  // copy's: a failed save mirrors the erase there, and must win (AC9).
  const eraseEpoch = Math.max(...[stored, own, device].map((file) => file?.meta.eraseEpoch ?? 0)) + 1;
  // WHICH rows, so the merge drops them on every copy and keeps every row no
  // erase saw (US-09 AC23): the stored record's, this copy's and, on a
  // cloud, this device's file, where other tabs' failed saves wait.
  const copies = [stored, own, device].filter((file): file is RoadmapFile => file !== null);
  // The list keeps the claim the merge of every copy read makes: every erase
  // from `fromEpoch` on listed its ids. The device copy's history counts too,
  // so a legacy erase there that listed nothing keeps its gap (AC9). With no
  // list anywhere, this erase is the first to list.
  const before = [stored, device].reduce<Pick<RoadmapFile, 'meta' | 'erasedRows'>>((acc, file) => file ? {
    meta: { ...acc.meta, eraseEpoch: Math.max(acc.meta.eraseEpoch ?? 0, file.meta.eraseEpoch ?? 0) },
    erasedRows: mergeErasedRows(acc as RoadmapFile, file),
  } : acc, own).erasedRows;
  const ids = new Set(copies.flatMap((file) => [...rowRootIds(file), ...(file.erasedRows?.ids ?? [])]));
  const erasedRows = { fromEpoch: before?.fromEpoch ?? eraseEpoch, ids: [...ids].sort() };
  // An erase must not silently re-consent the user. Under US-17's default-on
  // model the empty file reads as "never decided", so the next app load would
  // enrol them again — undoing an explicit opt-out (AC4), and for an ENROLLED
  // user refilling the server row the pre-erase hook just tore down, with no
  // token left here to cancel it. So anyone who HAD an opt-in, active or
  // cancelled, comes out of the erase with reminders off; the manual toggle
  // still re-enrols, because that is the user asking. A higher eraseEpoch
  // wins the merge, and a losing copy keeps only rows the erase did not list
  // (US-09 AC23), never its opt-in, so the record on their other devices
  // can't save them either. Carry the decision, never the identity: no
  // token, no email address.
  const priorProvider = own.reminderOptIn?.provider ?? null;
  // WHEN, beside WHICH: read only by a copy that missed an earlier erase
  // that listed nothing (US-09 AC20, AC23). Floored 1 ms past the last
  // write this eraser has seen, so a slow clock here cannot let through a
  // row it already erased. A clock more than a day past now is broken, not
  // slow: it reads as now, so it cannot push the erase out over later rows.
  const now = stampInstant(ctx.now);
  const seen = [stored?.meta.updatedAt, own.meta.updatedAt].map(stampInstant);
  const floor = seen.filter((t) => t <= now + 86_400_000); // NaN fails too
  const erasedAt = new Date(Math.max(now, ...floor) + 1).toISOString();

  const file = migrateFile(null, ctx);
  file.schemaVersion = CURRENT_SCHEMA_VERSION;
  file.erasedRows = erasedRows;
  file.meta.eraseEpoch = eraseEpoch;
  file.meta.erasedAt = erasedAt;
  if (priorProvider) {
    file.reminderOptIn = {
      status: 'cancelled', token: '', email: '', provider: priorProvider,
      updatedAt: ctx.now, lamport: 1,
    };
  }
  return file;
}
