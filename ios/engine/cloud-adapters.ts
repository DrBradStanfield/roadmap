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

export function accessToken(provider: Provider, force: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    __native.accessToken(provider, force, (token, error, signIn) => {
      if (token) resolve(token);
      else if (signIn) reject(new SignInError(error ?? `${LABELS[provider]} needs you to sign in again.`));
      else reject(new StorageError(error ?? `${LABELS[provider]} did not answer`, UNREACHABLE_HINT));
    });
  });
}

/** A call the provider refused with 401 runs once more on a forced token refresh. */
export async function refreshOn401<T>(call: (force: boolean) => Promise<T>): Promise<T> {
  try {
    return await call(false);
  } catch (error) {
    if (!(error instanceof StorageError) || error.status !== 401 || error instanceof SignInError) throw error;
    return call(true);
  }
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

  read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    return this.run((cloud) => cloud.read(fileName, signal));
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

  private run<T>(call: (cloud: StorageAdapter) => Promise<T>): Promise<T> {
    return refreshOn401(async (force) => call(await this.adapter(force)));
  }

  /** One adapter per token, so Drive's file-id cache lives as long as the token. */
  private async adapter(force: boolean): Promise<StorageAdapter> {
    const token = await accessToken(this.provider, force);
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

/** What went wrong, as one word Swift turns into plain words (SyncStatus.swift). */
function failureKind(error: unknown): 'sign-in' | 'too-new' | 'storage-full' | 'unreachable' {
  if (error instanceof SignInError) return 'sign-in';
  if (error instanceof StorageError && error.status === 401) return 'sign-in';
  // A 403 is a refusal of access, except Drive's limits, read from the body's
  // reason: a rate or daily limit passes (retry later), a full Drive needs space.
  // Neither is fixed by signing in again.
  if (error instanceof StorageError && error.status === 403) {
    if (/ratelimitexceeded|dailylimitexceeded/i.test(error.message)) return 'unreachable';
    if (/storagequotaexceeded/i.test(error.message)) return 'storage-full';
    return 'sign-in';
  }
  if (error instanceof SchemaTooNewError) return 'too-new';
  return 'unreachable';
}

/** A cloud failure as the JSON Swift reads: its kind, and health-core's words for it. */
export function failed(provider: Provider, error: unknown): string {
  return JSON.stringify({ kind: failureKind(error), detail: describeStorageFailure(error, `The record in ${LABELS[provider]}`).message });
}
