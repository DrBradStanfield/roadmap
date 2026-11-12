/**
 * What a client gives the record engine: where the record lives and the
 * device capabilities around it (ios/architecture.md D4). The web widget
 * builds one from localStorage and its cloud adapters
 * (widget-src/src/storage/web-record-host.ts); the iPhone app will build one
 * from its container file and Dropbox or Drive. No DOM and no Node here.
 */
import type { ReadResult, StorageAdapter, WriteResult } from './adapter';
import { mergeFiles } from './merge';
import { ROADMAP_DOC } from './roadmap-doc';
import type { RoadmapFile } from './roadmap-file';
import type { SyncContext } from './sync-manager';

/** What failed, in a host's `report`. */
export type RecordFailureOp = 'persist' | 'pre-erase' | 'chat-erase' | 'clear-off-file' | 'after-save';

/** What `remoteChanged` tells the page: the erase a merge brought in, if any (US-16 AC2a). */
export interface RemoteChange { erase: string | null }

/** Two changes taken in before the page hears of them (a save loop's passes),
 *  as one: a later change that brings no erase keeps the earlier one's. */
export function laterChange(prior: RemoteChange | null, next: RemoteChange | null): RemoteChange | null {
  return next ? { erase: next.erase ?? prior?.erase ?? null } : prior;
}

/** Tell the page of a change taken in, when there is one. */
export function announce(host: RecordHost, change: RemoteChange | null): void {
  if (change) host.remoteChanged(change);
}

/**
 * Clear this device's off-file health data for the erase `after` is at
 * (US-11 AC1, AC6), sparing only the stored originals of documents that
 * outlive it (US-09 AC20, AC23): those live in `after`, and those live in
 * the device's own record copy once the erase is applied to it, so an
 * original the erase listed goes even where a stale device copy still names
 * it. A device copy that cannot be read names nothing. Throws what the host's
 * clear throws.
 */
export function clearOffFile(host: RecordHost, after: RoadmapFile, ctx: SyncContext): void {
  let kept = after;
  try {
    const body = host.deviceRecord?.();
    if (body != null) kept = mergeFiles(after, ROADMAP_DOC.migrate(body, ctx), ctx);
  } catch {
    /* unreadable: it names nothing */
  }
  host.clearOffFileData(new Set(kept.documents.filter((d) => !d.deleted && d.fileRef).map((d) => d.fileRef)));
}

/** A store that reads and writes synchronously (localStorage, a local file).
 *  Lets a page's last-ditch save land before the page goes (US-10 AC5), and a
 *  returning page skip a re-read when nothing moved (US-34 AC6). */
export interface SyncStorage {
  readSync(fileName: string): ReadResult;
  writeSync(fileName: string, body: object, expectedVersion: string | null): WriteResult;
  /** The file's stored revision; null when there is none. */
  revision(fileName: string): string | null;
  /** Remove the file, only at `expectedVersion` (ConflictError otherwise), so
   *  another page's write since stays (US-06 AC13). */
  removeSync?(fileName: string, expectedVersion: string | null): void;
}

/** On a cloud: the copy on this device that holds a save the cloud refused,
 *  and the marker that says it is there (US-09 AC4). */
export interface DeviceMirror {
  adapter: StorageAdapter;
  /** The device copy's synchronous path, when it has one (localStorage on the
   *  web): a page going away writes its unsaved changes there at once, since
   *  it cannot wait for the cloud save (US-06 AC13). */
  sync?: SyncStorage;
  pending: { get(): boolean; set(): void; clear(): void };
  /** The device copy's revision a connect's lift uploaded ('' for none), kept
   *  until the new cloud's first session opens (US-06 AC13, #974). Absent: no
   *  lift is recorded (the iPhone). */
  lifted?: { get(): string | null; set(revision: string): void; clear(): void };
  /** True once this device has logged off: no write may recreate the record
   *  here (US-09 AC2c). */
  writesStopped(): boolean;
  /** True while this browser still uses this cloud, so the device copy is
   *  still its mirror: false once another tab has switched to "This device"
   *  or another cloud (US-09 AC2), and then a page going away writes nothing
   *  there. Absent: never known, so an erase taken in removes no device copy,
   *  and a page going away still writes it (US-06 AC13). */
  stillChosen?(): boolean;
  /** Remove the device copy and what sits beside it, after an erase has
   *  reached the cloud (US-11). */
  wipe(): Promise<void>;
  /** The cloud record has loaded: from now on this device's log-off, made in
   *  another page, stops writes here too (US-09 AC2c), and so does one heard
   *  while it loaded (AC2h). Not before: a load that fails falls back to the
   *  device, whose copy is then its only store. */
  opened(): void;
}

interface HostBase {
  store: StorageAdapter;
  /** Health data this device keeps outside the record (drafts, kept answers,
   *  stored originals), cleared by an erase made here (US-11 AC1) or taken in
   *  from another device (AC6). `keepOriginals`: the `fileRef`s whose stored
   *  originals stay, the engine's call (`RecordSession.clearOffFileData`);
   *  every other original goes. */
  clearOffFileData(keepOriginals: ReadonlySet<string>): void;
  /** The raw body of the record copy this device keeps beside the session's
   *  store (on the web, the localStorage record a guest or on-device fallback
   *  tab writes), read synchronously; null when there is none. May throw when
   *  the bytes cannot be read. Leave it out when the host has no such copy. */
  deviceRecord?(): unknown;
  /** The store's own change signal (US-34): call `onChange` when the record
   *  may have changed elsewhere; answer the stop. Leave it out when the
   *  store has none, and the live re-read polls instead. */
  watch?(onChange: () => void): () => void;
  /** This device's id, for the merge's `lastDeviceId`. Read once, at open. */
  deviceId(): string;
  /** Read at each use, never captured, so a test's fake clock applies. */
  clock: { now(): number };
  /** The engine's only timers (JavaScriptCore has none of its own). Called at
   *  each use, never captured, so a test's fake timers apply. */
  timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** A re-read or a save brought in something a person would see (US-34).
   *  `erase`: the erase identity it moved the record to, when it carried
   *  another writer's erase; null for any other change. */
  remoteChanged(change: RemoteChange): void;
  /** Why a device store refused a write, as one word from a closed set
   *  ('other' when it cannot say). Asked only on the device tier. */
  failureCause(error: unknown): string;
  /** Something the user cannot fix failed and must still be seen: a save
   *  (`persist`), or a best-effort erase step (`pre-erase`, the caller's
   *  server teardown; `chat-erase`, the chat history's tombstones), the
   *  off-file clear an erase taken in owes (`clear-off-file`, retried in this
   *  session until it lands), or a throw after a save's write landed (`after-save`). `repeat`:
   *  this kind of device refusal, or this erase's failed clear, was already
   *  reported this session. Gets the error and closed tags only, never
   *  record content. */
  report(error: unknown, at: { op: RecordFailureOp; cause?: string; repeat: boolean }): void;
}

/**
 * `device`: the store is the record's only copy (localStorage on the web, the
 * app's container file on the phone). An unreadable stored record does not
 * block an erase there, and a failed save has nowhere else to go.
 * `cloud`: the record lives in the user's cloud, with a device mirror behind
 * it for a save the cloud refused.
 */
export type RecordHost =
  | (HostBase & {
      tier: 'device';
      /** The store's synchronous path: required, because the device copy is
       *  the record's only one and must land before the page goes. */
      sync: SyncStorage;
      /** After an erase: clear the other record files here (chat history) and
       *  move the erase fence, so no stale writer brings them back (US-11). */
      clearNamedFiles(): void;
      /** The content-free marker `clearNamedFiles` moves: a chat session
       *  that sees it move drops its pre-erase copy (US-11 AC3b). */
      eraseFence(): string | null;
    })
  | (HostBase & { tier: 'cloud'; mirror: DeviceMirror; sync?: never });

/**
 * At a session's open: a device copy written after the connect's lift read it
 * (another tab's departure, US-06 AC13) is marked for this session to take in,
 * whatever became of the shared marker meanwhile: an old-cloud tab's save may
 * have cleared it (#974). Once the new cloud is remembered, no old-cloud tab
 * clears the marker again (RecordSession.releaseMarker). Only a session on the
 * remembered cloud reads the record, and then it goes.
 */
export function liftMissed(mirror: DeviceMirror, copyRevision: string | null | undefined): boolean {
  const lifted = mirror.lifted?.get();
  if (lifted == null || !mirror.stillChosen?.()) return false; // an old-cloud page leaves it
  mirror.lifted!.clear();
  if ((copyRevision ?? '') === lifted) return false;
  mirror.pending.set();
  return true;
}
