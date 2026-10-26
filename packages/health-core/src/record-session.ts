/**
 * The open record's session, shared by the web widget's RoadmapStore and the
 * iPhone app (ios/architecture.md D4): one working copy, saved one save at a
 * time, re-read and merged, erased, and guarded against writes made for an
 * erase the page no longer shows. What counts as a change to take in or to
 * announce lives here too. The device itself comes in as a RecordHost.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ConflictError, ROADMAP_FILE_NAME, type StorageAdapter } from './adapter';
import { buildErasedFile } from './erase';
import { CLOCK_KEYS, mergeFiles } from './merge';
import { SchemaTooNewError } from './migrate';
import type { RecordHost, SyncStorage } from './record-host';
import { ROADMAP_DOC } from './roadmap-doc';
import { CURRENT_SCHEMA_VERSION, stableStringify, type RoadmapFile } from './roadmap-file';
import { SyncManager, type SyncContext } from './sync-manager';

/** How long a burst of edits waits before one save carries them all. */
export const PERSIST_DEBOUNCE_MS = 800;

/**
 * How the open page keeps up with a record something else is writing (US-34).
 * The provider says so when it can — the adapter's `watch` — and the two
 * moments a user comes back to the page catch whatever a watch missed. The
 * slow poll is the fallback for backends with no change signal at all; a
 * watch-capable one never runs it. The throttle stops two return signals that
 * fire together (focus and visibilitychange on the web) from making two round
 * trips out of one return.
 */
export const REMOTE_POLL_MS = 60_000;
export const REMOTE_THROTTLE_MS = 5_000;

/** Which erase the record is at. It lives in `meta` beside the clocks but is
 *  not one: an erase that leaves the record as empty as it was is still a
 *  change, and the page drops the chat's banners for it (US-16 AC2a). */
function eraseOf(file: RoadmapFile): [number, string | null] {
  return [file.meta.eraseEpoch ?? 0, file.meta.erasedAt ?? null];
}

/** Which erase this copy is at, as one comparable string (US-16 AC2a). */
export function eraseIdentityOf(file: RoadmapFile): string {
  return JSON.stringify(eraseOf(file));
}

/** The record minus its own clocks — what a person would call a change. Keys
 *  are sorted, as everywhere else content is compared: a merge rebuilds the
 *  objects it touches, and a reordered key is not a change anyone made. */
export function contentOf(file: RoadmapFile): string {
  const { meta: _clocks, ...rest } = file;
  return stableStringify([eraseOf(file), rest]);
}

/**
 * What a person would SEE of the record: `contentOf` with each list read as a
 * set and every record's own clocks (`updatedAt`, `lamport`, `fieldStamps`)
 * left out. A merge re-sorts rows by id, and against an empty backend it
 * trades one singleton's stamp for the other's; neither is a change anyone
 * made. This decides only what is ANNOUNCED (US-34 AC3). Taking a merge in
 * still goes by `contentOf`: a skipped clock-only lead would leave the profile
 * lamport behind the cloud's, and the next profile edit would lose the merge.
 */
export function visibleContentOf(file: RoadmapFile): string {
  // The erase list is bookkeeping too, and so is the version it raises: a
  // change to them alone is nothing a person sees (US-09 AC23). The erase
  // itself is: it drops the chat's banners (US-16 AC2a).
  const { meta: _clocks, erasedRows: _list, schemaVersion: _version, ...rest } = file;
  const seen: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    seen[key] = Array.isArray(value) ? value.map((row) => stableStringify(row, CLOCK_KEYS)).sort() : value;
  }
  return stableStringify([eraseOf(file), seen], CLOCK_KEYS);
}

/** What an erase that cannot read the cloud record says. It cannot list what
 *  it removes, so it removes nothing (US-09 AC23). */
export const ERASE_UNREACHABLE = 'Your cloud storage could not be reached, so nothing was deleted. Try again once it answers.';

/** The stored originals of the documents still live in `file`: an erase
 *  leaves these (US-09 AC20, AC23; US-11 AC6). */
function liveOriginals(file: RoadmapFile): Set<string> {
  return new Set(file.documents.filter((d) => !d.deleted && d.fileRef).map((d) => d.fileRef));
}

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

/** What an awaited save that failed says. */
const SAVE_FAILED = 'Cloud sync failed — your latest changes are still on this device.';

export interface EraseResult { success: boolean; error?: string; warning?: string }

/** The steps "delete all my data" runs before the record's own erase. */
export interface EraseSteps {
  /** Teardown on a server the caller owns (the reminders row), best-effort. */
  teardown?: () => Promise<void>;
  /** The chat history to tombstone; null when there is none. */
  chat?: () => Promise<{ eraseAll(): Promise<void> } | null>;
}

/**
 * Merge a raw record body into `target` (migrate + read-merge-write). The one
 * cross-store transfer: the failure mirror, the connect-time lift-up and the
 * pre-switch copy-down all go through it.
 */
export async function saveRecordInto(target: StorageAdapter, body: unknown, ctx: SyncContext): Promise<void> {
  await new SyncManager(target, ctx.deviceId, ROADMAP_DOC, { now: () => ctx.now }).save(ROADMAP_DOC.migrate(body, ctx));
}

/**
 * Model: edits change the working copy at once and schedule a debounced,
 * SERIALIZED save (one at a time; a burst becomes one write). The merge
 * (mergeFiles) owns multi-device safety; the session owns when to read,
 * write, mirror, announce and erase.
 */
export class RecordSession {
  private current: RoadmapFile;
  private persistTimer: unknown = null;
  /** The save in flight, if one is: a persist() call made meanwhile joins it. */
  private running: Promise<boolean> | null = null;
  private dirtyDuringPersist = false;
  /** True when a pending mirror existed but could not be read/merged at
   *  open() — persist success must then LEAVE the marker so the mirror is
   *  retried next load (e.g. once updated assets can parse its newer schema). */
  private mirrorSkipped = false;
  /** Leading-edge throttle for refreshFromRemote(), in epoch millis. */
  private lastRefresh = 0;
  /** Every change to the working copy counts one (touch). A save moves
   *  `savedChanges` up to the count it started from, and only when it lands,
   *  so a failed save leaves its changes unsaved for the next hide to retry. */
  private changes = 0;
  private savedChanges = 0;
  /** The kinds of device refusal reported this session: every hide retries
   *  a refused save, and meets the same refusal (US-10 AC5). */
  private readonly refusalsReported = new Set<string>();
  /** Device tier: the stored revision this session last took in, by a load,
   *  a re-read or its own write. Never a read it did not merge in, such as a
   *  save's verify-after-write (US-34 AC6). */
  private revisionSeen: string | null = null;
  /** The erase the page shows (`showErase`); null until a page says, and
   *  then no write is checked against it. */
  private shown: string | null = null;
  /** From the erase's swap to the end of its write. */
  private erasing = false;
  /** The latest save's `SaveResult.warning`, for the erase to pass on. */
  private saveWarning: string | undefined;

  private constructor(
    private readonly host: RecordHost,
    private readonly deviceId: string,
    private readonly sync: SyncManager<RoadmapFile>,
    file: RoadmapFile,
    /** The user chose a cloud this session cannot reach, and runs on-device
     *  meanwhile (US-09 AC13): an erase here is refused (AC23). */
    private readonly cloudUnreachable: boolean,
  ) {
    this.current = file;
  }

  /** Load the record from the host's store and return a ready session. */
  static async open(host: RecordHost, { cloudUnreachable = false } = {}): Promise<RecordSession> {
    const deviceId = host.deviceId();
    const sync = new SyncManager(host.store, deviceId, ROADMAP_DOC, { now: () => new Date(host.clock.now()).toISOString() });
    const revision = host.sync?.revision(ROADMAP_FILE_NAME) ?? null;
    const session = new RecordSession(host, deviceId, sync, await sync.load(), cloudUnreachable);
    session.revisionSeen = revision;
    const mirror = host.tier === 'cloud' ? host.mirror : null;
    mirror?.opened();
    // A previous cloud session failed to save and mirrored its changes
    // on-device (see saveLoop()'s catch). Merge them in now and schedule a
    // save to lift them up; the marker clears only once a cloud save succeeds.
    if (mirror?.pending.get()) {
      // Fault-tolerant like the mirror-WRITE side: an unreadable mirror must
      // not brick the load — continue on the cloud file. What happens to the
      // marker depends on WHY it was unreadable (see the catch below). A plain
      // merge: a fallback session runs on a file at epoch 0, and against an
      // erased cloud its rows survive because no erase listed them (US-09
      // AC23).
      try {
        const ctx = session.ctx();
        const { body } = await mirror.adapter.read(ROADMAP_FILE_NAME);
        if (body != null) {
          session.current = ROADMAP_DOC.merge(ROADMAP_DOC.migrate(body, ctx), session.current, ctx);
          session.touch();
        } else {
          mirror.pending.clear(); // stale marker, nothing mirrored
        }
      } catch (error) {
        if (error instanceof SchemaTooNewError) {
          // Written by a newer bundle — readable once assets update. Keep the
          // marker (mirrorSkipped stops persist-success from clearing it).
          session.mirrorSkipped = true;
        } else {
          // Unparseable local data can never be read OR replaced (the mirror
          // write reads before merging, so it throws on the same bytes). A
          // sticky marker would show "waiting to sync" forever for data
          // nothing can recover — clear it; the bytes themselves stay put.
          mirror.pending.clear();
        }
      }
    }
    return session;
  }

  /** The working copy. Change it only through `edit`. */
  get file(): RoadmapFile {
    return this.current;
  }

  get backendId() {
    return this.sync.backendId;
  }

  /** When the last re-read started, in epoch millis (US-34 throttle). */
  get lastRefreshAt(): number {
    return this.lastRefresh;
  }

  /** Device tier: the stored revision this session last took in (US-34 AC6). */
  get seenRevision(): string | null {
    return this.revisionSeen;
  }

  /** Which erase this copy is at, as one comparable string (US-16 AC2a). */
  get eraseIdentity(): string {
    return eraseIdentityOf(this.current);
  }

  /** The erase the page shows: the stamp of a write that brings none. */
  showErase(identity: string): void {
    this.shown = identity;
  }
  get shownErase(): string {
    return this.shown ?? this.eraseIdentity;
  }

  /** Every write takes `erase`, the erase the page showed when the write was
   *  asked for (a keystroke, a chat reply, a timer armed), and is refused when
   *  this copy is at another one, or while its own erase swaps in and writes:
   *  the write would carry a pre-erase screen into the erased record (US-16
   *  AC2a). A refusal is the caller's error answer, never a throw. */
  refuses(erase = this.shownErase): boolean {
    return this.erasing || erase !== this.eraseIdentity;
  }

  /**
   * The one way to change the working copy: `change` mutates the file it is
   * given, or returns the file that replaces it, and a save is scheduled.
   * False, and nothing changed, when `refuses(erase)`.
   */
  edit(change: (file: RoadmapFile) => RoadmapFile | void, erase?: string): boolean {
    if (this.refuses(erase)) return false;
    const next = change(this.current);
    if (next) this.current = next;
    this.touch();
    return true;
  }

  /**
   * Erase the record. `beforeErase` runs once the stored record has been read,
   * and only then: it is the irreversible part the caller owns (the reminders
   * teardown on Brad's server, the chat-history tombstones), so an erase
   * refused here has changed nothing anywhere (US-09 AC23).
   */
  async erase(beforeErase?: () => Promise<void>): Promise<EraseResult> {
    // An erase lists the rows it removes, so it must read the record it
    // removes them from. A session on-device because the cloud could not be
    // read cannot, and refuses before anything moves.
    if (this.cloudUnreachable) return { success: false, error: ERASE_UNREACHABLE };
    // A change still on the debounce is one the erase throws away: saving it
    // during the read would only send a pre-erase copy up ahead of the erase.
    const debounced = this.persistTimer !== null;
    this.cancelDebounce();
    // The WHOLE stored record, read now: another tab or device may have erased
    // and started again since this copy was read, and an erase at an equal
    // epoch unions with that record instead of beating it (US-11 AC7). On a
    // cloud an unreadable record refuses the erase, and the change on the
    // debounce goes back on it. On this device an unreadable record leaves
    // this copy's epoch, as before: there is no other copy to list.
    // On this device, the revision of the bytes read: an unreadable record is
    // replaced only at it, so another tab's repair is never written over (AC9).
    const revision = this.host.sync?.revision(ROADMAP_FILE_NAME) ?? null;
    let readError: unknown = null;
    const stored = await this.sync.load().catch((error) => { readError = error; return null; });
    // A newer app's record is never written over, whatever else fails in it:
    // update first (US-11 AC9).
    const tooNew = readError && this.host.tier === 'device' ? newerSchema(this.host.sync) : null;
    if (!stored && (this.host.tier === 'cloud' || tooNew)) {
      if (debounced) this.touch();
      return { success: false, error: tooNew ? tooNew.message : ERASE_UNREACHABLE };
    }
    await beforeErase?.();
    // From here every failure comes back as a refusal, never a rejection: the
    // caller's step has run, and its page must leave its deleting state.
    // Once the flush lands the record IS erased: a later cleanup failure is a
    // warning, so the caller still clears its screen and mirror (US-11 AC3b).
    let erased = false;
    try {
      this.cancelDebounce();
      // The device file, on a cloud, is where other tabs' failed saves wait.
      // One that cannot be read, or read into a record, lists nothing; a
      // successful erase removes it below.
      const host = this.host;
      const device = host.tier === 'device'
        ? null
        : await host.mirror.adapter.read(ROADMAP_FILE_NAME)
          .then(({ body }) => (body == null ? null : ROADMAP_DOC.migrate(body, this.ctx())))
          .catch(() => null);
      this.erasing = true;
      this.saveWarning = undefined;
      this.current = buildErasedFile({ stored, own: this.current, device, ctx: this.ctx() });
      this.touch(); // a change like any other: a failed flush leaves it for a hide to retry
      try {
        if (readError && host.tier === 'device') await this.replaceUnreadable(host.sync, revision);
        else await this.flush();
      } finally {
        this.erasing = false;
      }
      erased = true;
      // The erase reached the cloud — wipe the on-device residue too (failure
      // mirror + marker + named files/documents), so no pre-erase copy outlives
      // the erase on this device (US-11). On a failed flush we keep the mirror
      // instead: it now holds the ERASED file, whose bumped eraseEpoch wins the
      // merge and carries the erase to the cloud next session.
      // Document blobs and the unsaved drafts sit outside the record file, so
      // the erased file alone doesn't reach them. They go in every mode — a
      // device-tier user gets no wipe below (it would delete the erased file
      // just written), and used to keep them — except the originals of
      // documents the erase did not remove (another tab's, saved meanwhile).
      this.clearOffFileData();
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
      return { success: true, ...(this.saveWarning ? { warning: this.saveWarning } : {}) };
    } catch (e) {
      const message = (e as Error).message;
      return erased ? { success: true, warning: message } : { success: false, error: message };
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
  async deleteAllData(steps: EraseSteps = {}): Promise<EraseResult & { chatErased: boolean }> {
    let chatErased = false;
    const result = await this.erase(async () => {
      try {
        await steps.teardown?.();
      } catch (error) {
        this.host.report(error, { op: 'pre-erase', repeat: false });
      }
      // Through the caller's own chat session, so an open chat panel's copy is
      // the one erased, and BEFORE the record erase, which then clears the
      // device tier's named files underneath it (US-11 AC3).
      try {
        await (await steps.chat?.())?.eraseAll();
        chatErased = true;
      } catch (error) {
        this.host.report(error, { op: 'chat-erase', repeat: false });
      }
    });
    return { ...result, chatErased };
  }

  /** Force-persist any pending changes (call before navigation). */
  async flush(): Promise<void> {
    this.cancelDebounce();
    if (!(await this.persist())) throw new Error(SAVE_FAILED);
  }

  /** True while the working copy is AHEAD of the cloud: a save in flight, or
   *  one still sitting on the debounce. */
  private get writePending(): boolean {
    return this.running !== null || this.persistTimer !== null;
  }

  /** True while a change to the working copy has not landed, a failed save's
   *  included (US-10 AC5). */
  private get unsaved(): boolean {
    return this.changes !== this.savedChanges;
  }

  /**
   * Re-read the record and merge what came back (US-34). Answers false when
   * nothing changed — including every case where re-reading would be wrong:
   * a local edit is waiting to go up (the debounce timer, or a save in
   * flight), so the working copy is AHEAD of the cloud and merging a stale
   * read over it would fight the pending write; and the file is missing
   * (another tab's log-off, a file deleted in the cloud): the empty record it
   * reads as holds nothing the merge takes over this copy (US-10 AC6), so
   * there is nothing to take in. The device tier re-reads another tab's save
   * the same way (US-34 AC6). A re-read never writes, so a removed record is
   * not put back here.
   */
  async refreshFromRemote(): Promise<boolean> {
    if (this.writePending) return false;
    const at = this.host.clock.now();
    if (at - this.lastRefresh < REMOTE_THROTTLE_MS) return false;
    this.lastRefresh = at;

    const before = contentOf(this.current);
    // The copy this merge is based on. A save can start AND finish while the
    // read is in the air, and `writePending` is false again by the time it
    // lands — so the test that the working copy did not move is the working
    // copy itself, not whether a write happens to be in flight now.
    const local = this.current;
    // Taken before the read: a write landing in between costs a second read,
    // never a missed one.
    const revision = this.host.sync?.revision(ROADMAP_DOC.fileName) ?? null;
    const merged = mergeFiles(local, await this.sync.load(), this.ctx());
    // A merge always bumps the file's own clock, so the comparison is on the
    // CONTENT, not on a version: re-rendering on every poll would count a
    // change nobody made.
    if (contentOf(merged) === before) {
      this.revisionSeen = revision;
      return false;
    }
    // A local edit that landed during the read would be lost by taking the
    // merge — it merged against a copy taken before the edit existed.
    if (this.current !== local) return false;
    this.revisionSeen = revision;
    // The counting is the page's: it fires `remote_change_applied` when it
    // has actually re-rendered. A change of clocks alone is taken in and
    // announced to nobody: there is nothing new to show.
    if (this.adopt(merged)) this.host.remoteChanged();
    return true;
  }

  /**
   * Last-ditch save for a page closing or hiding, and only of what is
   * unsaved, a failed save's changes included (US-10 AC5). A store with a
   * synchronous path merges into the one file every page shares, so the
   * write has landed when this returns, whatever the async save may come to
   * await; then it takes the merge in, as a save does. Any other store, and a
   * refused synchronous write, fall back to the async save.
   */
  flushSync(): void {
    if (!this.unsaved) return;
    this.cancelDebounce();
    const store = this.host.sync;
    if (store) {
      try {
        const ctx = this.ctx();
        const { body, version } = store.readSync(ROADMAP_DOC.fileName);
        const merged = ROADMAP_DOC.merge(this.current, ROADMAP_DOC.migrate(body, ctx), ctx);
        this.revisionSeen = store.writeSync(ROADMAP_DOC.fileName, merged, version).version;
        this.savedChanges = this.changes;
        if (this.adopt(merged)) this.host.remoteChanged();
        return;
      } catch {
        // Another page's write in between: the async save re-reads, merges
        // and lands it. A newer app's record, unreadable bytes or a full disk:
        // it meets the same refusal, and reports it (US-10 AC5).
      }
    }
    void this.persist();
  }

  /**
   * Clear this device's off-file health data for the erase this copy is at
   * (US-11 AC1, AC6), sparing only the stored originals of documents that
   * outlive it (US-09 AC20, AC23): those live in this copy, and those live in
   * the device's own record copy once the erase is applied to it, so an
   * original the erase listed goes even where a stale device copy still names
   * it. A device copy that cannot be read names nothing, as in erase().
   * The page calls it too, after an erase whose write failed.
   */
  clearOffFileData(): void {
    this.clearOffFile(this.current);
  }

  private clearOffFile(after: RoadmapFile): void {
    const ctx = this.ctx();
    let kept = after;
    try {
      const body = this.host.deviceRecord?.();
      if (body != null) kept = mergeFiles(after, ROADMAP_DOC.migrate(body, ctx), ctx);
    } catch {
      /* unreadable: it names nothing */
    }
    this.host.clearOffFileData(liveOriginals(kept));
  }

  /** Device tier: write the erased record over bytes no record reads, at the
   *  revision they were read at. Another tab that wrote since wins the race:
   *  the save then reads its record and merges, as any save does (US-11 AC9). */
  private async replaceUnreadable(store: SyncStorage, revision: string | null): Promise<void> {
    this.cancelDebounce();
    try {
      this.revisionSeen = store.writeSync(ROADMAP_FILE_NAME, this.current, revision).version;
      this.savedChanges = this.changes;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await this.flush();
    }
  }

  /** The merge context: this device, and now. */
  private ctx(): SyncContext {
    return { deviceId: this.deviceId, now: new Date(this.host.clock.now()).toISOString() };
  }

  /** Take a merge in as the working copy, and answer whether it brought in
   *  something a person would see, for the caller to announce. One that
   *  carries an erase made on another device clears this device's off-file
   *  health data, as the erase clears it where it is made (US-11 AC1, AC6;
   *  one clear for both, O5) — but never the original of a document the
   *  merge keeps (US-09 AC20, AC23). */
  private adopt(merged: RoadmapFile): boolean {
    const seen = visibleContentOf(this.current);
    // An erase from elsewhere, a later one at the same epoch included (adversary R6).
    if (eraseIdentityOf(merged) !== this.eraseIdentity) this.clearOffFile(merged);
    this.current = merged;
    return visibleContentOf(merged) !== seen;
  }

  /** Mark dirty + schedule a debounced persist. */
  private touch(): void {
    this.changes += 1;
    if (this.running) this.dirtyDuringPersist = true;
    this.cancelDebounce();
    this.persistTimer = this.host.timers.set(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Cancel the debounced save: the caller saves now, or throws the change away. */
  private cancelDebounce(): void {
    // `!== null`, as writePending reads it: a host's timer id may be 0.
    if (this.persistTimer !== null) this.host.timers.clear(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * Serialized read-merge-write, run by saveLoop(). A call made while a save
   * runs joins it: the save goes round again for the new changes, and the
   * call answers when the whole save ends. A later pass that fails fails the
   * call too: a false failure, never a false success. Answering at once let
   * an awaited flush, and so an erase, report a save that had not happened
   * (US-11 AC7).
   * @returns false when the save failed (already reported to the host).
   */
  private persist(): Promise<boolean> {
    if (this.running) {
      this.dirtyDuringPersist = true;
      return this.running;
    }
    return (this.running = this.saveLoop());
  }

  /** Re-runs while edits land during the await. */
  private async saveLoop(): Promise<boolean> {
    // A remote change this save folds in is one refreshFromRemote() will never
    // find: it stands aside while a write is pending, and the merge below has
    // already taken the change into the working copy (US-34 AC1). Announce it
    // here or the screen stays stale until a reload.
    let remoteFolded = false;
    try {
      do {
        this.dirtyDuringPersist = false;
        const saving = this.changes;
        const result = await this.sync.save(this.current);
        this.revisionSeen = result.version; // what it wrote, never what its verify read
        if (result.warning) this.saveWarning = result.warning;
        this.savedChanges = saving;
        // Fold remote changes back in without dropping edits made during the
        // await; merge is the source of truth for combining the two.
        if (this.adopt(mergeFiles(this.current, result.file, this.ctx()))) remoteFolded = true;
      } while (this.dirtyDuringPersist);
      // Ended before anyone hears of it: a listener that saves again starts a
      // new save, instead of joining this finished one.
      this.running = null;
      if (remoteFolded) this.host.remoteChanged();
      // A skipped (unreadable) mirror holds data this save did NOT include —
      // keep its marker so the next load retries it.
      if (this.host.tier === 'cloud' && !this.mirrorSkipped) this.host.mirror.pending.clear();
      return true;
    } catch (error) {
      this.running = null; // as above: ended before the marker is announced
      // A pass that landed before this one failed may have folded a remote
      // change in: the page must still hear of it (adversary R3).
      if (remoteFolded) this.host.remoteChanged();
      // The background cloud save failed — this MUST be observable (unreported,
      // it's silent data-at-risk), and the changes must NOT stay memory-only:
      // mirror the working copy on-device so a page close can't lose it, and
      // leave the marker so the next cloud session merges it back up (US-09
      // AC4; Sentry JAVASCRIPT-REMIX-3X — a mid-session token-refresh failure
      // made every save throw while the UI still showed the connected state).
      // Most persist() call sites are fire-and-forget (`void this.persist()`),
      // so returning false (not rethrowing) keeps them from re-creating an
      // unhandled rejection; awaited callers (flush) check the result.
      const mirror = this.host.tier === 'cloud' ? this.host.mirror : null;
      if (mirror && !mirror.writesStopped()) {
        mirror.pending.set();
        // Deliberately the merged transfer primitive, NOT a plain overwrite: the
        // device file may hold guest-era data this session never loaded (no
        // marker set), and an overwrite would destroy its only copy. The merge
        // preserves it — and lifts it up with the mirror on the next session.
        // It migrates this copy first. Advance meta.updatedAt so mutable row
        // and field updatedAt stamps are not rewound to the last successful
        // sync. Immutable measurement/lab createdAt is kept as written.
        try {
          const ctx = this.ctx();
          if (ctx.now > this.current.meta.updatedAt) this.current.meta.updatedAt = ctx.now;
          await saveRecordInto(mirror.adapter, this.current, ctx);
        } catch {
          /* device storage unavailable — memory-only is the best we have */
        }
      }
      // Only the device tier names its refusal (6M): a cloud failure's cause
      // is the transport, which the host's report already classifies. A device
      // refuses every retry the same way, and each hide retries a refused
      // save, so each kind of refusal is reported once per session.
      const cause = this.host.tier === 'device' ? this.host.failureCause(error) : undefined;
      let repeat = false;
      if (cause) {
        const kind = `${error instanceof Error ? error.name : ''}/${cause}`;
        repeat = this.refusalsReported.has(kind);
        this.refusalsReported.add(kind);
      }
      this.host.report(error, { op: 'persist', cause, repeat });
      return false;
    }
  }
}
