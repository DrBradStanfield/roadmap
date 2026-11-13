/**
 * The record erase, moved whole out of record-session.ts (file budget):
 * erase, "delete all my data" and the unreadable-record replace, each a free
 * function on the session, which keeps a one-line method for each.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ConflictError, ROADMAP_FILE_NAME } from './adapter';
import { buildErasedFile } from './erase';
import { mergeFiles } from './merge';
import { SchemaTooNewError } from './migrate';
import type { SyncStorage } from './record-host';
import type { RecordSession } from './record-session';
import { ROADMAP_DOC } from './roadmap-doc';
import { CURRENT_SCHEMA_VERSION, stableStringify, type RoadmapFile } from './roadmap-file';

/** What an erase that cannot read the cloud record says. It cannot list what
 *  it removes, so it removes nothing (US-09 AC23). */
export const ERASE_UNREACHABLE = 'Your cloud storage could not be reached, so nothing was deleted. Try again once it answers.';
/** A second erase asked for while one runs; both clients refuse it first. */
export const ERASE_BUSY = 'Already deleting your data.';
/** An erase asked in a tab off the record this browser has chosen; refused first (US-11 AC6). */
export const ERASE_STALE_TAB = 'This tab is out of date. Reload it, then delete your data.';

/** The refusal for a stored record a newer app wrote, read from its raw
 *  `schemaVersion` before any shape check; null for bytes that do not parse,
 *  or a version this app knows (US-11 AC9). */
function newerSchema(store: SyncStorage): SchemaTooNewError | null {
  let body: unknown;
  try {
    ({ body } = store.readSync(ROADMAP_FILE_NAME));
  } catch {
    return null;
  }
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof version === 'number' && version > CURRENT_SCHEMA_VERSION ? new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION) : null;
}

export interface EraseResult { success: boolean; error?: string; warning?: string }

/** The steps "delete all my data" runs before the record's own erase. */
export interface EraseSteps {
  /** Teardown on a server the caller owns (the reminders row), best-effort. */
  teardown?: () => Promise<void>;
  /** The chat history to tombstone; null when there is none. */
  chat?: () => Promise<{ eraseAll(): Promise<void> } | null>;
}

/**
 * Erase the record. `beforeErase` runs once the stored record has been read,
 * and only then: it is the irreversible part the caller owns (the reminders
 * teardown on Brad's server, the chat-history tombstones), so an erase
 * refused here has changed nothing anywhere (US-09 AC23).
 */
export async function eraseSession(s: RecordSession, beforeErase?: () => Promise<void>): Promise<EraseResult> {
  // Refused before anything moves: a session on-device because the cloud could not be read, as an erase
  // lists the rows it removes from the record it reads (a reload would not help it); a tab off the record
  // this browser has chosen, read live here (US-11 AC6); and a second erase while one runs (US-16 AC2f).
  const host = s.host;
  const refusal = s.cloudUnreachable ? ERASE_UNREACHABLE : host.ownsOffFileData?.() === false ? ERASE_STALE_TAB
    : s.saveMode === 'erasing' ? ERASE_BUSY : null;
  if (refusal) return { success: false, error: refusal };
  // On this device, the revision of the bytes read: an unreadable record is
  // replaced only at it, so another tab's repair is never written over (AC9).
  const revision = host.sync?.revision(ROADMAP_FILE_NAME) ?? null;
  let readError: unknown = null;
  // What a write that lands nowhere puts back (lead S57).
  const before = { file: s.current, clearedFor: s.clearedFor, saveWarning: s.saveWarning };
  // From the confirm on every write is refused, or it would answer "saved"
  // for a change the erase removes (lead A6). The debounce is put aside.
  s.dispatch({ type: 'eraseBegan' });
  try {
    // The WHOLE stored record, read now: another tab or device may have erased
    // and started again since this copy was read, and an erase at an equal
    // epoch unions with that record instead of beating it (US-11 AC7). On a
    // cloud an unreadable record refuses the erase. On this device an
    // unreadable record leaves this copy's epoch, as before: there is no
    // other copy to list.
    const stored = await s.sync.load().catch((error) => { readError = error; return null; });
    // A newer app's record is never written over, whatever else fails in it:
    // update first (US-11 AC9).
    const tooNew = readError && host.tier === 'device' ? newerSchema(host.sync) : null;
    if (!stored && (host.tier === 'cloud' || tooNew)) return { success: false, error: tooNew ? tooNew.message : ERASE_UNREACHABLE };
    // The device file, on a cloud, is where other tabs' failed saves wait. One that cannot be read,
    // or read into a record, lists nothing; a successful erase removes it below. Read before the
    // caller's step, which needs its opt-in too.
    const device = host.tier === 'device'
      ? null
      : await host.mirror.adapter.read(ROADMAP_FILE_NAME)
        .then(({ body }) => (body == null ? null : ROADMAP_DOC.migrate(body, s.ctx())))
        .catch(() => null);
    // The caller's step reads the opt-in from this copy, to cancel its server row. Another device,
    // or another tab whose save failed, may have opted in since this copy was read: when the merge
    // of every copy read (epoch first, then the newer stamp) keeps an ACTIVE opt-in, give it to this
    // copy, so that row is the one cancelled (US-11 AC4). Never anything less: an erase this copy
    // missed may hold no opt-in at all, and this copy's own active row must still be cancelled and
    // turned off. No save is scheduled; the erase replaces this copy.
    let optIn: RoadmapFile['reminderOptIn'];
    try {
      optIn = [stored, device].reduce<RoadmapFile>(
        (merged, file) => (file ? mergeFiles(merged, file, s.ctx()) : merged),
        s.current,
      ).reminderOptIn;
    } catch {
      optIn = undefined; // keep this copy's own
    }
    if (optIn?.status === 'active' && stableStringify(optIn) !== stableStringify(s.current.reminderOptIn ?? null)) {
      s.current = { ...s.current, reminderOptIn: optIn };
    }
    await beforeErase?.();
    // From here every failure comes back as a refusal, never a rejection: the
    // caller's step has run, and its page must leave its deleting state.
    s.saveWarning = undefined;
    try { s.current = buildErasedFile({ stored, own: s.current, device, ctx: s.ctx() }); } catch (e) { return { success: false, error: (e as Error).message }; }
    s.clearedFor = s.eraseIdentity; // an erase made here owes no clear: its own follows the write, or the page's
    s.dispatch({ type: 'eraseSwapped' });
  } finally {
    s.dispatch({ type: 'eraseAborted' }); // a no-op in the swap's turn: only an erase stopped short gives its save back
  }
  // Once the flush lands the record IS erased: a later cleanup failure is a
  // warning, so the caller still clears its screen and mirror (US-11 AC3b).
  let erased = false;
  try {
    try {
      if (readError && host.tier === 'device') await s.replaceUnreadable(host.sync, revision);
      else await s.flush();
    } finally {
      s.dispatch({ type: 'eraseEnded' });
    }
    erased = true;
    // The erase reached the cloud — wipe the on-device residue too (failure
    // mirror + marker + named files/documents), so no pre-erase copy outlives
    // the erase on this device (US-11). On a failed flush we keep the mirror
    // instead: it now holds the ERASED file, whose bumped eraseEpoch wins the
    // merge and carries the erase to the cloud next session.
    // Document blobs and the unsaved drafts sit outside the record file. They go in every mode (a device-tier
    // user gets no wipe below), except the originals of documents the erase did not remove (another tab's, saved
    // meanwhile). A clear that fails is reported on its own: the cleanup below still runs, the next load clears.
    s.tryClear();
    if (host.tier === 'device') {
      // The other record files (chat history): their contents are already
      // tombstoned (the caller's beforeErase erases chat history first).
      // Also rotate the content-free fence so another tab cannot merge its
      // old snapshot into the missing file.
      host.clearNamedFiles();
    } else {
      // The wipe takes the whole device copy, every stored original with
      // it: a row a device-tier tab saved after the erase read that copy
      // goes too (the residual US-11 AC6 names).
      host.mirror.pending.clear();
      await host.mirror.wipe();
    }
    return { success: true, ...(s.saveWarning ? { warning: s.saveWarning } : {}) };
  } catch (e) {
    const message = (e as Error).message;
    if (erased) return { success: true, warning: message };
    // Neither the cloud nor the device copy took the erase: the write failed
    // before it landed, and the failure mirror did not land. It would live
    // only in memory, and a reload would bring every value back. Put this
    // copy back as it was, so the page says the record was not erased and
    // keeps showing it (lead S57). A write that may have landed keeps the
    // erased copy, as before. The pending marker stays: it lifts only the
    // pre-erase copy, into a pre-erase cloud.
    if (host.tier === 'cloud' && s.writtenNowhere) {
      ({ file: s.current, clearedFor: s.clearedFor, saveWarning: s.saveWarning } = before);
      return { success: false };
    }
    return { success: false, error: message };
  }
}

/**
 * "Delete all my data": the stored record is read first (erase()), then, in
 * this order and only then, the caller's server teardown and the chat
 * history's tombstones, then the record erase itself (US-09 AC23, US-11 AC2).
 * Both steps are best-effort: an unreachable server or a chat cloud that
 * will not answer must never trap the user's data, so each failure is
 * reported and the erase goes on. `chatErased` says whether the chat step
 * landed, so the page never claims a deletion that did not happen.
 */
export async function deleteAllDataSession(s: RecordSession, steps: EraseSteps = {}): Promise<EraseResult & { chatErased: boolean }> {
  let chatErased = false;
  const result = await s.erase(async () => {
    try {
      await steps.teardown?.();
    } catch (error) {
      s.host.report(error, { op: 'pre-erase', repeat: false });
    }
    // Through the caller's own chat session, so an open chat panel's copy is
    // the one erased, and BEFORE the record erase, which then clears the
    // device tier's named files underneath it (US-11 AC3).
    try {
      await (await steps.chat?.())?.eraseAll();
      chatErased = true;
    } catch (error) {
      s.host.report(error, { op: 'chat-erase', repeat: false });
    }
  });
  return { ...result, chatErased };
}

/** Device tier: write the erased record over bytes no record reads, at the
 *  revision they were read at. Another tab that wrote since wins the race:
 *  the save then reads its record and merges, as any save does (US-11 AC9). */
export async function replaceUnreadableSession(s: RecordSession, store: SyncStorage, revision: string | null): Promise<void> {
  try {
    s.revisionSeen = store.writeSync(ROADMAP_FILE_NAME, s.current, revision).version;
    s.dispatch({ type: 'synced' });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    await s.flush();
  }
}
