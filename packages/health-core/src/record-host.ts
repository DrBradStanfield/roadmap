/**
 * What a client gives the record engine: where the record lives and the
 * device capabilities around it (ios/architecture.md D4). The web widget
 * builds one from localStorage and its cloud adapters
 * (widget-src/src/storage/web-record-host.ts); the iPhone app will build one
 * from its container file and Dropbox or Drive. No DOM and no Node here.
 */
import type { ReadResult, StorageAdapter, WriteResult } from './adapter';

/** A store that reads and writes synchronously (localStorage, a local file).
 *  Lets a page's last-ditch save land before the page goes (US-10 AC5), and a
 *  returning page skip a re-read when nothing moved (US-34 AC6). */
export interface SyncStorage {
  readSync(fileName: string): ReadResult;
  writeSync(fileName: string, body: object, expectedVersion: string | null): WriteResult;
  /** The file's stored revision; null when there is none. */
  revision(fileName: string): string | null;
}

/** On a cloud: the copy on this device that holds a save the cloud refused,
 *  and the marker that says it is there (US-09 AC4). */
export interface DeviceMirror {
  adapter: StorageAdapter;
  pending: { get(): boolean; set(): void; clear(): void };
  /** True once this device has logged off: no write may recreate the record
   *  here (US-09 AC2c). */
  writesStopped(): boolean;
  /** Remove the device copy and what sits beside it, after an erase has
   *  reached the cloud (US-11). */
  wipe(): Promise<void>;
  /** An erase made in this page that no read of the cloud has shown yet
   *  (US-11 AC9), as the engine's own text: kept for this tab only, across a
   *  reload, and dropped at log-off. Leave it out and a stale read after an
   *  erase shows until a re-read meets the erase. */
  unconfirmedErase?: { get(): string | null; set(value: string): void; clear(): void };
  /** The cloud record has loaded: from now on this device's log-off, made in
   *  another page, stops writes here too (US-09 AC2c). Not before: a load
   *  that fails falls back to the device, whose copy is then its only store. */
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
  /** A re-read or a save brought in something a person would see (US-34). */
  remoteChanged(): void;
  /** Why a device store refused a write, as one word from a closed set
   *  ('other' when it cannot say). Asked only on the device tier. */
  failureCause(error: unknown): string;
  /** Something the user cannot fix failed and must still be seen: a save
   *  (`persist`), or a best-effort erase step (`pre-erase`, the caller's
   *  server teardown; `chat-erase`, the chat history's tombstones). `repeat`:
   *  this kind of device refusal was already reported this session. Gets the
   *  error and closed tags only, never record content. */
  report(error: unknown, at: { op: 'persist' | 'pre-erase' | 'chat-erase'; cause?: string; repeat: boolean }): void;
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
