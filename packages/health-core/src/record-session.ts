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
import { clearOwed, eraseIdentityOf, eraseOf } from './erase-identity';
import { CLOCK_KEYS, mergeFiles } from './merge';
import { SchemaTooNewError } from './migrate';
import { announce, clearedAtOpen, clearOffFile, keepCleared, laterChange, liftMissed, tellSaveStatus, type DeviceMirror, type RecordHost, type RemoteChange, type SyncStorage } from './record-host';
import { ROADMAP_DOC } from './roadmap-doc';
import { changesOf, SAVE_START, saveStatus, transition, unsaved, writePending, type SaveEvent, type SaveState, type SaveStatus } from './save-state';
import { CURRENT_SCHEMA_VERSION, stableStringify, type RoadmapFile } from './roadmap-file';
import { SyncManager, type SyncContext } from './sync-manager';

export { eraseIdentityOf } from './erase-identity';

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

/** The device copy's revision on a cloud whose copy has a synchronous path;
 *  undefined on any other host (US-06 AC13). */
function deviceCopyRevision(host: RecordHost): string | null | undefined {
  return host.tier === 'cloud' ? host.mirror.sync?.revision(ROADMAP_FILE_NAME) : undefined;
}

/**
 * Model: edits change the working copy at once and schedule a debounced,
 * SERIALIZED save (one at a time; a burst becomes one write). The merge
 * (mergeFiles) owns multi-device safety; the session owns when to read,
 * write, mirror, announce and erase.
 */
export class RecordSession {
  private current!: RoadmapFile; // set by open()
  /** The save mode (lead A1), changed only by `dispatch`; below, the debounce
   *  handle, and `running`, the claim set and cleared with the saving mode. */
  private mode: SaveState = SAVE_START;
  private told: SaveStatus = saveStatus(SAVE_START); // saveStatus(mode), as last told to the host
  private persistTimer: unknown = null;
  private running: Promise<boolean> | null = null;
  /** True when a pending mirror existed but could not be read/merged at
   *  open() — persist success must then LEAVE the marker so the mirror is
   *  retried next load (e.g. once updated assets can parse its newer schema). */
  private mirrorSkipped = false;
  /** Leading-edge throttle for refreshFromRemote(), in epoch millis. */
  private lastRefresh = 0;
  /** The kinds of device refusal reported this session: every hide retries
   *  a refused save, and meets the same refusal (US-10 AC5). */
  private readonly refusalsReported = new Set<string>();
  /** Device tier: the stored revision this session last took in, by a load,
   *  a re-read or its own write. Never a read it did not merge in, such as a
   *  save's verify-after-write (US-34 AC6). */
  private revisionSeen: string | null = null;
  /** On a cloud: the device copy's revision as this page last left it, at
   *  open, at its departure write or at its failure mirror. An erase taken in
   *  removes only that copy, never one another page wrote since (US-06 AC13).
   *  Undefined on a host whose device copy has no synchronous path. */
  private deviceCopySeen: string | null | undefined;
  /** The erase the page shows (`showErase`); null until a page says, and
   *  then no write is checked against it. */
  private shown: string | null = null;
  /** The latest save's `SaveResult.warning`, for the erase to pass on. */
  private saveWarning: string | undefined;
  /** The erase this tab's off-file data is cleared up to: a later one owes a clear (US-11 AC6, AC7). */
  private clearedFor = '';
  private clearReportedFor = ''; // the erase whose failed clear was reported

  private constructor(
    private readonly host: RecordHost,
    private readonly deviceId: string,
    private readonly sync: SyncManager<RoadmapFile>,
    /** The user chose a cloud this session cannot reach, and runs on-device
     *  meanwhile (US-09 AC13): an erase here is refused (AC23). */
    private readonly cloudUnreachable: boolean,
  ) {}

  /** Load the record from the host's store and return a ready session. */
  static async open(host: RecordHost, { cloudUnreachable = false } = {}): Promise<RecordSession> {
    const deviceId = host.deviceId();
    const sync = new SyncManager(host.store, deviceId, ROADMAP_DOC, { now: () => new Date(host.clock.now()).toISOString() });
    const session = new RecordSession(host, deviceId, sync, cloudUnreachable);
    session.revisionSeen = host.sync?.revision(ROADMAP_FILE_NAME) ?? null; // both before the read
    session.deviceCopySeen = deviceCopyRevision(host);
    session.current = session.deviceClosed() ? ROADMAP_DOC.migrate(null, session.ctx()) : await sync.load();
    const mirror = host.tier === 'cloud' ? host.mirror : null;
    if (mirror) {
      mirror.opened();
      // An erase this load took in leaves no pre-erase copy behind, under the
      // same guards as one taken in later (US-06 AC13).
      session.releaseErasedCopy(mirror, true);
    }
    // A previous cloud session failed to save and mirrored its changes on-device
    // (saveLoop()'s catch), or a write missed the connect's lift: merge them in and
    // schedule a save to lift them up; the marker clears once a cloud save does. Only while the copy is this page's.
    if (mirror && session.mirrorOurs(mirror) && (liftMissed(mirror, session.deviceCopySeen) || mirror.pending.get())) {
      // Fault-tolerant like the mirror-WRITE side: an unreadable mirror must
      // not brick the load — continue on the cloud file. What happens to the
      // marker depends on WHY it was unreadable (see the catch below). A plain
      // merge: a fallback session runs on a file at epoch 0, and against an
      // erased cloud its rows survive because no erase listed them (US-09
      // AC23).
      try {
        const ctx = session.ctx();
        const { body } = await mirror.adapter.read(ROADMAP_FILE_NAME);
        if (body != null && session.mirrorOurs(mirror)) { // again: a log-off may land during the read (US-09 AC2c)
          session.current = ROADMAP_DOC.merge(ROADMAP_DOC.migrate(body, ctx), session.current, ctx);
          session.dispatch({ type: 'edited' });
        } else if (session.mirrorOurs(mirror)) {
          mirror.pending.clear(); // stale marker, nothing mirrored
        }
      } catch (error) {
        if (error instanceof SchemaTooNewError) {
          // Written by a newer bundle — readable once assets update. Keep the
          // marker (mirrorSkipped stops persist-success from clearing it).
          session.mirrorSkipped = true;
        } else if (session.mirrorOurs(mirror)) {
          // Unparseable local data can never be read OR replaced (the mirror
          // write reads before merging, so it throws on the same bytes). A
          // sticky marker would show "waiting to sync" forever for data
          // nothing can recover — clear it; the bytes themselves stay put.
          mirror.pending.clear();
        }
      }
    }
    session.clearedFor = clearedAtOpen(host, session.current);
    session.settleClear();
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

  /** What a status line shows of the save (lead A1). */
  get saveStatus(): SaveStatus { return saveStatus(this.mode); }

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
   *  this copy is at another one, or while its own erase runs, from its confirm:
   *  the write would carry a pre-erase screen into the erased record (US-16
   *  AC2a). A refusal is the caller's error answer, never a throw. */
  refuses(erase = this.shownErase): boolean {
    return this.mode.mode === 'erasing' || erase !== this.eraseIdentity;
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
    this.dispatch({ type: 'edited' });
    return true;
  }

  /**
   * Erase the record. `beforeErase` runs once the stored record has been read,
   * and only then: it is the irreversible part the caller owns (the reminders
   * teardown on Brad's server, the chat-history tombstones), so an erase
   * refused here has changed nothing anywhere (US-09 AC23).
   */
  async erase(beforeErase?: () => Promise<void>): Promise<EraseResult> {
    // Refused before anything moves: a session on-device because the cloud could not be read, as an erase
    // lists the rows it removes from the record it reads (a reload would not help it); a tab off the record
    // this browser has chosen, read live here (US-11 AC6); and a second erase while one runs (US-16 AC2f).
    const host = this.host;
    const refusal = this.cloudUnreachable ? ERASE_UNREACHABLE : host.ownsOffFileData?.() === false ? ERASE_STALE_TAB
      : this.mode.mode === 'erasing' ? ERASE_BUSY : null;
    if (refusal) return { success: false, error: refusal };
    // On this device, the revision of the bytes read: an unreadable record is
    // replaced only at it, so another tab's repair is never written over (AC9).
    const revision = host.sync?.revision(ROADMAP_FILE_NAME) ?? null;
    let readError: unknown = null;
    // From the confirm on every write is refused, or it would answer "saved"
    // for a change the erase removes (lead A6). The debounce is put aside.
    this.dispatch({ type: 'eraseBegan' });
    try {
      // The WHOLE stored record, read now: another tab or device may have erased
      // and started again since this copy was read, and an erase at an equal
      // epoch unions with that record instead of beating it (US-11 AC7). On a
      // cloud an unreadable record refuses the erase. On this device an
      // unreadable record leaves this copy's epoch, as before: there is no
      // other copy to list.
      const stored = await this.sync.load().catch((error) => { readError = error; return null; });
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
          .then(({ body }) => (body == null ? null : ROADMAP_DOC.migrate(body, this.ctx())))
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
          (merged, file) => (file ? mergeFiles(merged, file, this.ctx()) : merged),
          this.current,
        ).reminderOptIn;
      } catch {
        optIn = undefined; // keep this copy's own
      }
      if (optIn?.status === 'active' && stableStringify(optIn) !== stableStringify(this.current.reminderOptIn ?? null)) {
        this.current = { ...this.current, reminderOptIn: optIn };
      }
      await beforeErase?.();
      // From here every failure comes back as a refusal, never a rejection: the
      // caller's step has run, and its page must leave its deleting state.
      this.saveWarning = undefined;
      try { this.current = buildErasedFile({ stored, own: this.current, device, ctx: this.ctx() }); } catch (e) { return { success: false, error: (e as Error).message }; }
      this.clearedFor = this.eraseIdentity; // an erase made here owes no clear: its own follows the write, or the page's
      this.dispatch({ type: 'eraseSwapped' });
    } finally {
      this.dispatch({ type: 'eraseAborted' }); // a no-op in the swap's turn: only an erase stopped short gives its save back
    }
    // Once the flush lands the record IS erased: a later cleanup failure is a
    // warning, so the caller still clears its screen and mirror (US-11 AC3b).
    let erased = false;
    try {
      try {
        if (readError && host.tier === 'device') await this.replaceUnreadable(host.sync, revision);
        else await this.flush();
      } finally {
        this.dispatch({ type: 'eraseEnded' });
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
      this.tryClear();
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
    if (!(await this.persist())) throw new Error(SAVE_FAILED);
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
    if (writePending(this.mode) || this.deviceClosed()) return false;
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
      this.settleClear();
      return false;
    }
    // A local edit that landed during the read would be lost by taking the
    // merge — it merged against a copy taken before the edit existed.
    if (this.current !== local) return false;
    this.revisionSeen = revision;
    // The counting is the page's: it fires `remote_change_applied` when it
    // has actually re-rendered. A change of clocks alone is taken in and
    // announced to nobody: there is nothing new to show.
    announce(this.host, this.adopt(merged));
    return true;
  }

  /**
   * Last-ditch save for a page closing or hiding, and only of what is
   * unsaved, a failed save's changes included (US-10 AC5). A store with a
   * synchronous path merges into the one file every page shares, so the
   * write has landed when this returns, whatever the async save may come to
   * await; then it takes the merge in, as a save does. Any other store, and a
   * refused synchronous write, fall back to the async save; on a cloud the
   * device copy holds the changes meanwhile (mirrorNow).
   */
  flushSync(): void {
    if (!unsaved(this.mode)) return;
    const store = this.host.sync;
    if (store && !this.deviceClosed()) {
      try {
        const ctx = this.ctx();
        const { body, version } = store.readSync(ROADMAP_DOC.fileName);
        const merged = ROADMAP_DOC.merge(this.current, ROADMAP_DOC.migrate(body, ctx), ctx);
        this.revisionSeen = store.writeSync(ROADMAP_DOC.fileName, merged, version).version;
        this.dispatch({ type: 'synced' });
        announce(this.host, this.adopt(merged));
        return;
      } catch {
        // Another page's write in between: the async save re-reads, merges
        // and lands it. A newer app's record, unreadable bytes or a full disk:
        // it meets the same refusal, and reports it (US-10 AC5).
      }
    } else if (this.host.tier === 'cloud') {
      this.mirrorNow(this.host.mirror);
    }
    void this.persist();
  }

  /**
   * Cloud tier, page going away: the save below may never land, so the
   * unsaved changes go to the device copy now, merged and marked pending as
   * a failed save's are, and the next session lifts them up (US-06 AC13,
   * US-09 AC4). The merge keeps a row only the device copy holds and drops
   * one an erase listed. Only while the copy is this page's (mirrorOurs).
   * Best-effort: an unreadable or full device copy leaves only the async save.
   */
  private mirrorNow(mirror: DeviceMirror): void {
    if (!mirror.sync || !this.mirrorOurs(mirror)) return;
    try {
      // The device tier's merge above: the merge moves the clock, so no edit is rewound.
      const ctx = this.ctx();
      const { body, version } = mirror.sync.readSync(ROADMAP_FILE_NAME);
      const merged = ROADMAP_DOC.merge(this.current, ROADMAP_DOC.migrate(body, ctx), ctx);
      mirror.pending.set();
      this.deviceCopySeen = mirror.sync.writeSync(ROADMAP_FILE_NAME, merged, version).version;
    } catch {
      /* the async save below is all that is left */
    }
  }

  /** Clear this device's off-file health data for this copy's erase, and keep it once the clear worked; the page
   *  calls it after an erase whose write failed (record-host `clearOffFile`). */
  clearOffFileData(): void {
    clearOffFile(this.host, this.current, this.ctx());
    keepCleared(this.host, this.eraseIdentity);
    this.clearedFor = this.eraseIdentity;
  }

  /** The clear a later erase owes this tab: tried at each load, save and re-read until it lands (US-11 AC6, AC7). */
  private settleClear(): void {
    if (clearOwed(this.eraseIdentity, this.clearedFor)) this.tryClear();
  }
  /** Clear, reporting a failure once per erase per session; the kept erase then stays, so the next load clears again. */
  private tryClear(): void {
    try { this.clearOffFileData(); } catch (error) {
      this.host.report(error, { op: 'clear-off-file', repeat: this.clearReportedFor === this.eraseIdentity });
      this.clearReportedFor = this.eraseIdentity;
    }
  }
  /** A device page that may not read or write this device's health files: it reads none and saves none (US-09 AC2c). */
  private deviceClosed(): boolean { return this.host.tier === 'device' && this.host.deviceFilesOpen?.() === false; }
  /** The device copy is still this cloud page's mirror: no log-off (US-09 AC2c), and no other tab moved this browser off this cloud, whose device file is then that tab's record (AC2). Read live. */
  private mirrorOurs(mirror: DeviceMirror): boolean { return !mirror.writesStopped() && mirror.stillChosen?.() !== false; }

  /** Device tier: write the erased record over bytes no record reads, at the
   *  revision they were read at. Another tab that wrote since wins the race:
   *  the save then reads its record and merges, as any save does (US-11 AC9). */
  private async replaceUnreadable(store: SyncStorage, revision: string | null): Promise<void> {
    try {
      this.revisionSeen = store.writeSync(ROADMAP_FILE_NAME, this.current, revision).version;
      this.dispatch({ type: 'synced' });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await this.flush();
    }
  }

  /** The merge context: this device, and now. */
  private ctx(): SyncContext {
    return { deviceId: this.deviceId, now: new Date(this.host.clock.now()).toISOString() };
  }

  /** Take a merge in as the working copy, and answer what it brought in that
   *  a person would see, for the caller to announce (null: nothing). One that
   *  carries an erase made on another device clears this device's off-file
   *  health data, as the erase clears it where it is made (US-11 AC1, AC6;
   *  one clear for both, O5) — but never the original of a document the
   *  merge keeps (US-09 AC20, AC23). */
  private adopt(merged: RoadmapFile): RemoteChange | null {
    const seen = visibleContentOf(this.current);
    // An erase from elsewhere, a later one at the same epoch included (adversary R6).
    const erasedElsewhere = eraseIdentityOf(merged) !== this.eraseIdentity;
    // Taken in before the clear: an edit the host makes from it lands on the
    // merge, and a clear that throws never leaves the pre-erase copy nor
    // hides the erase from the page (US-11 AC7).
    this.current = merged;
    this.settleClear();
    // Nor a full pre-erase copy of the record on this device (US-06 AC13).
    if (erasedElsewhere && this.host.tier === 'cloud' && !unsaved(this.mode)) this.releaseErasedCopy(this.host.mirror);
    return visibleContentOf(merged) === seen ? null : { erase: erasedElsewhere ? eraseIdentityOf(merged) : null };
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
  private releaseMarker(mirror: DeviceMirror): void {
    if (mirror.stillChosen?.() === false || (mirror.sync && (!mirror.pending.get() || !this.coveredCopy(mirror.sync)))) return;
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
  private releaseErasedCopy(mirror: DeviceMirror, loaded = false): void {
    const sync = mirror.sync;
    if (!sync?.removeSync || !mirror.stillChosen?.()) return;
    const copy = this.coveredCopy(sync, loaded);
    if (!copy || copy.version !== this.deviceCopySeen) return;
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
  private coveredCopy(sync: SyncStorage, preErase = false): { version: string | null } | null {
    try {
      const { body, version } = sync.readSync(ROADMAP_FILE_NAME);
      const ctx = this.ctx();
      const copy = ROADMAP_DOC.migrate(body, ctx);
      if (preErase && eraseIdentityOf(copy) === this.eraseIdentity) return null;
      return contentOf(mergeFiles(this.current, copy, ctx)) === contentOf(this.current) ? { version } : null;
    } catch {
      return null;
    }
  }

  /** Move the save state and run the debounce effects it returns (an edit
   *  arms a debounced persist); answer where a pass it asks for starts. */
  private dispatch(event: SaveEvent): number | null {
    const step = transition(this.mode, event);
    this.mode = step.state;
    let pass: number | null = null;
    for (const effect of step.effects) {
      if (effect.type === 'pass') { pass = effect.from; continue; }
      if (this.persistTimer !== null) this.host.timers.clear(this.persistTimer); // a host's timer id may be 0
      const fire = () => { this.persistTimer = null; void this.persist(); };
      this.persistTimer = effect.type === 'arm' ? this.host.timers.set(fire, PERSIST_DEBOUNCE_MS) : null;
    }
    this.told = tellSaveStatus(this.host, this.told, saveStatus(this.mode)); // once the effects run
    return pass;
  }

  /**
   * Serialized read-merge-write, run by saveLoop(). A call made while a save
   * runs joins it, and answers when the whole save ends. It never forces
   * another pass itself: every change made meanwhile does that (passLanded), so
   * a debounce firing mid-pass or an empty flush adds no write (US-10 AC5a).
   * A later pass that fails fails the call too: a false failure, never a false success. Answering at once let
   * an awaited flush, and so an erase, report a save that had not happened
   * (US-11 AC7).
   * @returns false when the save failed (already reported to the host).
   */
  private persist(): Promise<boolean> {
    // Nothing to save writes nothing: a save always merges, and every merge
    // moves the lamport on. Covers an empty flush and the debounce left over
    // from an edit a save's own next pass already took (US-10 AC5a).
    // A running save is joined, never doubled: `running` is the claim, set and
    // cleared in the same turns as the saving mode.
    if (this.running) {
      this.dispatch({ type: 'save' });
      return this.running;
    }
    const from = this.dispatch({ type: 'save' });
    if (from !== null) {
      const run: Promise<boolean> = this.saveLoop(from, () => this.running === run);
      this.running = run;
    }
    return this.running ?? Promise.resolve(true);
  }

  /** Re-runs while edits land during the await. `owns`: `running` is still
   *  this save's, never one a save asked for from adopt() started since. */
  private async saveLoop(pass: number | null, owns: () => boolean): Promise<boolean> {
    // A remote change this save folds in is one refreshFromRemote() will never
    // find: it stands aside while a write is pending, and the merge below has
    // already taken the change into the working copy (US-34 AC1). Announce it
    // here or the screen stays stale until a reload.
    let remoteFolded: RemoteChange | null = null;
    try {
      while (pass !== null) {
        // A closed device page fails the pass before its read, once awaited: the claim is set by then.
        const result = await (this.deviceClosed() ? Promise.reject(new Error('Device files closed')) : this.sync.save(this.current));
        this.revisionSeen = result.version; // what it wrote, never what its verify read
        if (result.warning) this.saveWarning = result.warning;
        const next = this.dispatch({ type: 'passLanded', from: pass });
        // The pass and its claim end together, before adopt() or a listener
        // can ask for a save: that save starts its own pass, never joins this one.
        if (next === null && owns()) this.running = null;
        // Fold remote changes back in without dropping edits made during the
        // await; merge is the source of truth for combining the two.
        remoteFolded = laterChange(remoteFolded, this.adopt(mergeFiles(this.current, result.file, this.ctx())));
        pass = next;
      }
      announce(this.host, remoteFolded);
      // A skipped (unreadable) mirror holds data this save did NOT include —
      // keep its marker so the next load retries it.
      if (this.host.tier === 'cloud' && !this.mirrorSkipped) this.releaseMarker(this.host.mirror);
      return true;
    } catch (error) {
      // A throw once the last pass landed and its claim ended (an adopt() or a
      // listener after it): the write stands, and a newer save may own the
      // mode and the copy. It is reported, and fails neither (US-11 AC7).
      if (!owns()) {
        this.host.report(error, { op: 'after-save', repeat: false });
        return true;
      }
      this.dispatch({ type: 'passFailed' });
      this.running = null;
      // A pass that landed before this one failed may have folded a remote
      // change in: the page must still hear of it (adversary R3).
      announce(this.host, remoteFolded);
      if (this.deviceClosed()) return false; // nothing to report: the page may not save here
      // The background cloud save failed — this MUST be observable (unreported, it's silent data-at-risk),
      // and the changes must NOT stay memory-only: mirror the working copy on-device so a page close can't
      // lose it, and leave the marker so the next cloud session merges it back up (US-09 AC4; Sentry
      // JAVASCRIPT-REMIX-3X — a mid-session token-refresh failure made every save throw while the UI still
      // showed the connected state). Most persist() call sites are fire-and-forget (`void this.persist()`),
      // so returning false (not rethrowing) keeps them from re-creating an unhandled rejection; awaited
      // callers (flush) check the result. Not once another tab moved this browser off this cloud: the
      // device file is then that tab's record (US-06 AC13, Brad R1).
      const mirror = this.host.tier === 'cloud' ? this.host.mirror : null;
      if (mirror && this.mirrorOurs(mirror)) {
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
          const held = changesOf(this.mode); // what this write holds: the device line needs it to land (US-09 AC30)
          if (ctx.now > this.current.meta.updatedAt) this.current.meta.updatedAt = ctx.now;
          await saveRecordInto(mirror.adapter, this.current, ctx);
          this.dispatch({ type: 'mirrored', changes: held });
          this.deviceCopySeen = deviceCopyRevision(this.host);
        } catch {
          /* device storage unavailable — memory-only is the best we have */
        }
      }
      // Only the device tier names its refusal (6M): a cloud failure's cause
      // is the transport, which the host's report already classifies. A device
      // refuses every retry the same way, and each hide retries a refused
      // save, so each kind of refusal is reported once per session. The kind
      // includes what the error wrapped: `other` pools refusals the browser
      // did not name, and the host tells them apart by it (US-09 AC28).
      const cause = this.host.tier === 'device' ? this.host.failureCause(error) : undefined;
      let repeat = false;
      if (cause) {
        const wrapped = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
        const kind = `${error instanceof Error ? error.name : ''}/${cause}/${wrapped instanceof Error ? wrapped.name : ''}`;
        repeat = this.refusalsReported.has(kind);
        this.refusalsReported.add(kind);
      }
      this.host.report(error, { op: 'persist', cause, repeat });
      return false;
    }
  }
}
