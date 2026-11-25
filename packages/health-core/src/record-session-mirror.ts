/**
 * A cloud session's device copy, moved whole out of record-session.ts (file
 * budget): the departure write, the marker's release after a save, and the
 * copy's removal once an erase from elsewhere covers it. Each is a free
 * function on the session, which keeps a one-line method for each.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { eraseIdentityOf } from './erase-identity';
import { mergeFiles } from './merge';
import type { DeviceMirror, RecordHost, SyncStorage } from './record-host';
import type { RecordSession } from './record-session';
import { contentOf } from './record-session-content';
import { ROADMAP_DOC } from './roadmap-doc';

/** The device copy's revision on a cloud whose copy has a synchronous path;
 *  undefined on any other host (US-06 AC13). */
export function deviceCopyRevision(host: RecordHost): string | null | undefined {
  return host.tier === 'cloud' ? host.mirror.sync?.revision(ROADMAP_FILE_NAME) : undefined;
}

/** After a failed device write past an erase's swap: whether the device copy
 *  may carry this erase or a later one, read from the copy itself so a retry
 *  that stored before it failed counts (S69 R2). No synchronous path (the
 *  iPhone's: its erase is put back, lead S57) or no copy: false. A store that
 *  cannot be read: true, unknown errs toward the cancel. A copy that cannot
 *  be parsed or migrated: false, since the mirror write reads and migrates it
 *  before writing, so it was never replaced. Otherwise its migrated epoch at
 *  or past the erased record's. */
export function deviceCopyHoldsErase(s: RecordSession): boolean {
  const sync = s.host.tier === 'cloud' ? s.host.mirror.sync : undefined;
  if (!sync) return false;
  let body: unknown;
  try {
    ({ body } = (sync.readSyncStrict ?? sync.readSync).call(sync, ROADMAP_FILE_NAME));
  } catch (error) {
    return !(error instanceof StorageError && error.cause instanceof SyntaxError); // unparsable: put back
  }
  if (body == null) return false;
  try {
    return (ROADMAP_DOC.migrate(body, s.ctx()).meta.eraseEpoch ?? 0) >= (s.current.meta.eraseEpoch ?? 0);
  } catch {
    return false;
  }
}

/**
 * Cloud tier, page going away: the save below may never land, so the
 * unsaved changes go to the device copy now, merged and marked pending as
 * a failed save's are, and the next session lifts them up (US-06 AC13,
 * US-09 AC4). The merge keeps a row only the device copy holds and drops
 * one an erase listed. Only while the copy is this page's (mirrorOurs).
 * Best-effort: an unreadable or full device copy leaves only the async save,
 * and is reported (`mirror-write`), as a repeat after the session's first (US-06 AC13a).
 */
export function mirrorNowSession(s: RecordSession, mirror: DeviceMirror): void {
  if (!mirror.sync || !s.mirrorOurs(mirror)) return;
  try {
    // The device tier's merge above: the merge moves the clock, so no edit is rewound.
    const ctx = s.ctx();
    const { body, version } = mirror.sync.readSync(ROADMAP_FILE_NAME);
    const merged = ROADMAP_DOC.merge(s.current, ROADMAP_DOC.migrate(body, ctx), ctx);
    mirror.pending.set();
    s.deviceCopySeen = mirror.sync.writeSync(ROADMAP_FILE_NAME, merged, version).version;
  } catch (error) {
    reportDeparture(s, error); // the async save below is all that is left
  }
}

/** Sessions whose departure write already failed and was reported. */
const departureReported = new WeakSet<RecordSession>();

/** A failed departure write, told to the host (error and closed tags only); a report that throws never stops the async save. */
function reportDeparture(s: RecordSession, error: unknown): void {
  try {
    s.host.report(error, { op: 'mirror-write', repeat: departureReported.has(s) });
  } catch {
    /* a reporter that fails: the async save still runs */
  }
  departureReported.add(s);
}

/**
 * After a cloud save: the marker a failed save or a page going away set
 * (US-09 AC4, US-06 AC13) clears only once the device copy holds nothing
 * the saved record lacks. A copy that holds more, such as another tab's
 * departure written since this save began, keeps it for the next load to
 * lift up, and so does one that cannot be read. The copy itself stays: a
 * load that cannot reach the cloud starts from it (US-09 AC13). A copy with
 * no synchronous path (the iPhone's, whose marker holds its own generation)
 * clears as before. A browser moved to another provider never clears (#974).
 */
export function releaseMarkerSession(s: RecordSession, mirror: DeviceMirror): void {
  if (mirror.stillChosen?.() === false || (mirror.sync && (!mirror.pending.get() || !s.coveredCopy(mirror.sync)))) return;
  mirror.pending.clear();
}

/**
 * An erase taken in from another device (US-11): the device copy goes, with
 * its marker, when the erased record holds all of it, this browser still
 * uses this cloud (no other tab has moved it to "This device" or another
 * cloud, US-09 AC2), and the copy is the one this page last read or wrote.
 * Any other copy stays. The removal is checked at the revision read, best
 * effort as writeSync is: localStorage has no cross-tab compare-and-swap.
 * At a load (`loaded`), the copy must also be from before the erase the
 * load took in: a copy written since stays for an offline start.
 */
export function releaseErasedCopySession(s: RecordSession, mirror: DeviceMirror, loaded = false): void {
  const sync = mirror.sync;
  if (!sync?.removeSync || !mirror.stillChosen?.()) return;
  const copy = s.coveredCopy(sync, loaded);
  if (!copy || copy.version !== s.deviceCopySeen) return;
  try {
    sync.removeSync(ROADMAP_FILE_NAME, copy.version);
  } catch {
    return;
  }
  mirror.pending.clear();
}

/** The device copy's revision when the working copy holds all of it (no
 *  copy at all reads as an empty record, which holds nothing more); null
 *  when it holds more or cannot be read, or (`preErase`) when it is at the
 *  working copy's erase. */
export function coveredCopySession(s: RecordSession, sync: SyncStorage, preErase = false): { version: string | null } | null {
  try {
    const { body, version } = sync.readSync(ROADMAP_FILE_NAME);
    const ctx = s.ctx();
    const copy = ROADMAP_DOC.migrate(body, ctx);
    if (preErase && eraseIdentityOf(copy) === s.eraseIdentity) return null;
    return contentOf(mergeFiles(s.current, copy, ctx)) === contentOf(s.current) ? { version } : null;
  } catch {
    return null;
  }
}
