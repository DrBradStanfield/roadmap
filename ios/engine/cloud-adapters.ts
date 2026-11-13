// The two stores a phone cloud session stands on (US-25 AC11, US-09 AC4;
// ios/architecture.md D5): the user's Dropbox or Google Drive, through
// health-core's own REST adapters, and the phone's own record file as the
// device mirror. Both are built from the natives Swift supplies. Web twins:
// widget-src/src/storage/dropbox.ts and drive.ts (the cloud) and
// local-storage-adapter.ts (the mirror). Also: how a cloud failure is named for Swift.
import { ROADMAP_FILE_NAME, StorageError, ConflictError, UNREACHABLE_HINT, type ReadResult, type StorageAdapter, type WriteResult } from '../../packages/health-core/src/adapter';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { DriveAdapter } from '../../packages/health-core/src/drive-rest';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import { describeStorageFailure } from '../../packages/health-core/src/sync-manager';
import { mayHaveLanded } from '../../packages/health-core/src/write-refusal';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

export type Provider = 'dropbox' | 'google-drive';

export const LABELS: Record<Provider, string> = { dropbox: 'Dropbox', 'google-drive': 'Google Drive' };

/** What Swift gives the sync (CloudSync.swift, EngineNatives.swift). */
export interface CloudNatives {
  /** A current access token. `force` after the provider refused the last one.
   *  The token is the sentinel `native-token:<provider>`: Swift keeps the real one
   *  and swaps it in on an allowed call only (EngineHTTP.swift, US-25 AC18).
   *  On failure, `error` says why and `signIn` whether only signing in again
   *  fixes it (a refresh token the provider refused) or a retry may (no network). */
  accessToken(provider: Provider, force: boolean, done: (token: string | null, error: string | null, signIn: boolean) => void): void;
  /** The phone's record file: `{"text": "..."}`, `{"text": null}` when there is
   *  none, or `{"error": "..."}` when it cannot be read. */
  phoneRead(): string;
  /** Writes the phone's record file atomically; answers the error, or '' when it landed. */
  phoneWrite(text: string): string;
  phoneRemove(): void;
  /** The marker that says the phone holds changes the cloud lacks (US-09 AC4), as a
   *  generation: 0 when it is not set, and a higher number at every 'set'.
   *  'clear-if:<n>' clears it only while it is still at generation n, so a session
   *  never clears a marker set after it read the phone. Answers the generation after. */
  pending(op: 'get' | 'set' | `clear-if:${number}`): number;
  /** Tells Swift what happened in session `session`: 'saving', 'saved',
   *  'synced', 'failed' or 'changed'. Swift drops news from any session but the
   *  one it shows. Never a log: 'changed' carries the record, which Swift only shows. */
  notify(event: 'saving' | 'saved' | 'synced' | 'failed' | 'changed', payload: string, session: number): void;
}

declare const __native: CloudNatives;

/** The provider refused the token, or the user must sign in again. */
class SignInError extends StorageError {
  constructor(message: string) {
    super(message, undefined, undefined, 401);
    this.name = 'SignInError';
  }
}

function accessToken(provider: Provider, force: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    __native.accessToken(provider, force, (token, error, signIn) => {
      if (token) resolve(token);
      else if (signIn) reject(new SignInError(error ?? `${LABELS[provider]} needs you to sign in again.`));
      else {
        const failure = new StorageError(error ?? `${LABELS[provider]} did not answer`, UNREACHABLE_HINT);
        // Only Swift's words say the token endpoint never answered (OAuthClient.post's catch):
        // a Keychain that will not save, or another status, is no outage (S50b; lead H129).
        if (error !== null && / did not answer\./.test(error)) NO_ANSWER.add(failure);
        reject(failure);
      }
    });
  });
}

/** Token refreshes whose network call got no answer (`accessToken`): a known outage (S50b). */
const NO_ANSWER = new WeakSet<object>();

/** What EngineNatives.swift answers in place of a request it never sent: the allow-list's
 *  refusal and a missing token. The shim rejects both as a TypeError, as it does a real network
 *  failure, and only these words tell them apart (lead H129: give them their own error). */
const NATIVE_REFUSALS: readonly string[] = ['This app does not send that request.', 'Not signed in.'];

/** 401s refreshOn401 did not retry: no fresh token was tried, so the next call starts on one (S57b). */
const REFRESH_SKIPPED = new WeakSet<object>();

/** A call the provider refused with 401 runs once more on a forced token refresh. */
async function refreshOn401<T>(call: (force: boolean) => Promise<T>): Promise<T> {
  try {
    return await call(false);
  } catch (error) {
    if (!(error instanceof StorageError) || error.status !== 401 || error instanceof SignInError) throw error;
    // Not after an upload that may have landed (Drive's verify read): the retry's own answer
    // would replace that mark, and an erase could be put back over a cloud that holds it (S57).
    if (mayHaveLanded(error)) {
      REFRESH_SKIPPED.add(error);
      throw error;
    }
    return call(true);
  }
}

/** True when `error`, or an error it wraps (SyncManager rewraps), is a 401 refreshOn401 did not retry. */
function refreshSkipped(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) if (REFRESH_SKIPPED.has(e)) return true;
  return false;
}

/**
 * The user's cloud, through health-core's own REST adapter, with a fresh
 * access token for each call (the phone refreshes with PKCE, in Swift). A
 * call the provider refuses with 401 runs once more on a forced refresh.
 * The adapters are the phone's own, so they file documents
 * (`{ documents: 'write' }`, US-52 AC13d); the record calls are unchanged.
 * A document ref is a folder path ('Letters/2026-01-01 Clinic letter.pdf')
 * for both providers, as `saveDocuments` builds it.
 */
export class PhoneCloudAdapter implements StorageAdapter {
  readonly id: Provider;
  readonly label: string;
  private current: { token: string; adapter: StorageAdapter } | null = null;
  /** A 401 went unretried (refreshOn401): the next call asks for a fresh token first (S57b). */
  private refreshNext = false;
  /** Drive's record copies, kept across token refreshes (US-10 AC4a). */
  private readonly recordIds = new Set<string>();

  constructor(private readonly provider: Provider, private readonly session: number) {
    this.id = provider;
    this.label = LABELS[provider];
  }

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /** The record as the newest read found it, the session's open read included:
   *  what an open compares its moved record with (US-66 AC14). */
  lastRecord: unknown = null;

  async read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    const result = await this.run((cloud) => cloud.read(fileName, signal));
    if (fileName === ROADMAP_FILE_NAME) this.lastRecord = result.body;
    return result;
  }

  async write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    // Sync status is the record's: the chat file's writes say nothing (adversary R3).
    const record = fileName === ROADMAP_FILE_NAME;
    if (record) __native.notify('saving', '', this.session);
    const written = await this.run((cloud) => cloud.write(fileName, body, expectedVersion, signal));
    if (record) __native.notify('saved', '', this.session);
    return written;
  }

  readDocument(ref: string, signal?: AbortSignal): Promise<Blob> {
    return this.run((cloud) => cloud.readDocument(ref, signal));
  }

  writeDocument(ref: string, bytes: Blob): Promise<void> {
    return this.run((cloud) => cloud.writeDocument(ref, bytes));
  }

  private async run<T>(call: (cloud: StorageAdapter) => Promise<T>): Promise<T> {
    try {
      return await refreshOn401(async (force) => call(await this.adapter(force)));
    } catch (error) {
      // The failed write is not retried; the same error goes on, its mark intact.
      if (refreshSkipped(error)) this.refreshNext = true;
      throw error;
    }
  }

  /** One adapter per token, so Drive's file-id cache lives as long as the token. */
  private async adapter(force: boolean): Promise<StorageAdapter> {
    const token = await accessToken(this.provider, force || this.refreshNext);
    this.refreshNext = false;
    if (this.current?.token !== token) {
      const options = { documents: 'write' } as const;
      // No oldest-first chat lookup: EngineHTTP.swift allows no orderBy (US-10 AC4a).
      this.current = { token, adapter: this.provider === 'dropbox' ? new DropboxAdapter(token, options) : new DriveAdapter(token, options, false, this.recordIds) };
    }
    return this.current.adapter;
  }
}

/** A short, stable fingerprint of the file's text: the phone file's version. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}-${(hash >>> 0).toString(16)}`;
}

/**
 * The phone's own record file, as the device mirror: where a save the cloud
 * refused waits (US-09 AC4), and the copy the app opens with when the cloud
 * cannot be reached. Swift writes it atomically; JavaScriptCore runs on one
 * queue, so nothing writes it between a read here and the write after it.
 */
export class PhoneFileAdapter implements StorageAdapter {
  readonly id = 'file' as const;
  readonly label = 'This iPhone';

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /** The raw text, or null when there is no file. Throws when it cannot be read. */
  private text(): string | null {
    const answer = JSON.parse(__native.phoneRead()) as { text?: string | null; error?: string };
    if (answer.error !== undefined) throw new StorageError(answer.error);
    return answer.text ?? null;
  }

  /** The record as JSON, or null when there is none. `text`: the file as just read,
   *  so a caller that also needs the text crosses the bridge for it once. */
  body(text = this.text()): unknown {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new StorageError('The record on this iPhone is not valid JSON.', undefined, error);
    }
  }

  async read(fileName: string): Promise<ReadResult> {
    if (fileName !== ROADMAP_FILE_NAME) return { body: null, version: null };
    const text = this.text();
    return { body: this.body(text), version: text === null ? null : fingerprint(text) };
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    if (fileName !== ROADMAP_FILE_NAME) throw new StorageError(`This iPhone keeps only ${ROADMAP_FILE_NAME}.`);
    const now = this.text();
    if ((now === null ? null : fingerprint(now)) !== expectedVersion) throw new ConflictError();
    return { version: this.writeText(JSON.stringify(body)) };
  }

  /** Writes the file now; answers its version, throws when the phone refused. */
  private writeText(text: string): string {
    const error = __native.phoneWrite(text);
    if (error) throw new StorageError(error);
    return fingerprint(text);
  }

  /** Merge `file` into the phone's record now, before anything else runs: the
   *  same merge saveRecordInto makes, without its awaits. Throws when the
   *  phone's file cannot be read (it is never written over then) or written. */
  mergeNow(file: RoadmapFile, ctx: { deviceId: string; now: string }): void {
    const body = this.body();
    this.writeText(JSON.stringify(body === null ? file : ROADMAP_DOC.merge(file, ROADMAP_DOC.migrate(body, ctx), ctx)));
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The iPhone keeps no documents yet.');
  }
  async writeDocument(): Promise<void> {
    throw new StorageError('The iPhone keeps no documents yet.');
  }
}

/** What went wrong, as one word Swift turns into plain words (SyncProblem.swift). */
function failureKind(error: unknown): 'sign-in' | 'too-new' | 'storage-full' | 'unreachable' {
  if (error instanceof SignInError) return 'sign-in';
  // A 401 after an upload that may have landed was never retried on a fresh token, so signing
  // in again is not yet known to be needed: the next call refreshes first (S57b).
  if (error instanceof StorageError && error.status === 401) return refreshSkipped(error) ? 'unreachable' : 'sign-in';
  // A 403 is a refusal of access, except Drive's limits, read from the body's
  // reason: a rate or daily limit passes (retry later), a full Drive needs space.
  // Neither is fixed by signing in again.
  // The reason may sit on a cause: Drive wraps a PATCH's refusal ("record update failed.").
  if (error instanceof StorageError && error.status === 403) {
    const said = messages(error);
    // dailyLimitExceededUnreg is a call with no valid credentials, not a passing limit.
    if (/ratelimitexceeded|dailylimitexceeded(?!unreg)/i.test(said)) return 'unreachable';
    if (/storagequotaexceeded/i.test(said)) return 'storage-full';
    return 'sign-in';
  }
  if (dropboxFull(error)) return 'storage-full';
  if (error instanceof SchemaTooNewError) return 'too-new';
  return 'unreachable';
}

/**
 * How a failed save of an erase failed, for cloudEraseHeld (S50b, US-25 AC16i). 'transient' only
 * for a failure known to pass: a network call with no answer (fetch never answered, a timeout,
 * an abort), 408, 429, a 5xx, or Google's rate or daily limit. 'definite': the provider refused
 * (sign in, storage full, a newer schema, any other status). 'unknown': anything else, a 401 whose
 * refresh was skipped included (its write may have landed). Only 'transient' holds a Disconnect,
 * so a failure nobody recognised never traps the person. Not isDefiniteRefusal, which asks
 * whether a write certainly did not land (write-refusal.ts).
 */
export function eraseFailure(error: unknown): 'transient' | 'definite' | 'unknown' {
  if (failureKind(error) !== 'unreachable' || (error instanceof StorageError && error.reason === 'reconnect')) return 'definite';
  if (!(error instanceof StorageError)) return 'unknown';
  const status = error.status;
  if (status === undefined) return noAnswer(error) ? 'transient' : 'unknown';
  if (status === 401) return 'unknown'; // 'unreachable' only when its refresh was skipped (failureKind)
  // A 403 reads 'unreachable' only as Google's rate or daily limit (failureKind).
  return status === 408 || status === 429 || status >= 500 || status === 403 ? 'transient' : 'definite';
}

/** A network call that got no answer: fetchOrFail's or untilAborted's failure (a TypeError from
 *  the shim that is not one of Swift's own refusals, or an abort or timeout), or a token refresh
 *  Swift said got none (`NO_ANSWER`), found through any rewrap (SyncManager's). */
function noAnswer(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (NO_ANSWER.has(e)) return true;
    if (!(e instanceof StorageError) || e.status !== undefined) continue;
    const cause = e.cause;
    if (cause instanceof TypeError && !NATIVE_REFUSALS.includes(cause.message)) return true;
    if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) return true;
  }
  return false;
}

/** The messages of `error` and the errors it wraps, joined. */
function messages(error: unknown): string {
  const said: string[] = [];
  for (let e = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) said.push(e.message);
  return said.join('\n');
}

/** health-core's full Dropbox (dropbox-rest.ts, US-09 AC35/AC38), by its typed reason (#979). The save
 *  rewraps the error after an earlier write may have landed (sync-manager.ts), so its cause counts too. */
function dropboxFull(error: unknown): boolean {
  const full = (e: unknown) => e instanceof StorageError && e.reason === 'storage-full';
  return full(error) || (error instanceof StorageError && full(error.cause));
}

/** A cloud failure as the JSON Swift reads: its kind, and health-core's words for it. */
export function failed(provider: Provider, error: unknown): string {
  return JSON.stringify({ kind: failureKind(error), detail: describeStorageFailure(error, `The record in ${LABELS[provider]}`).message });
}
