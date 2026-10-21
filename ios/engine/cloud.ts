// Cloud sync for the iPhone app (US-25 AC8; ios/architecture.md D2, D4, D5).
// The record lives in the user's Dropbox or Google Drive, the same
// health-roadmap.json the website uses. Everything that decides what is
// written is health-core's: RecordSession (save loop, re-read, merge on
// conflict, erase guard), SyncManager, the REST adapters, the lift on first
// connect and the copy-down on leaving. This file only builds the RecordHost
// the phone stands behind, out of the natives Swift supplies.
import { ROADMAP_FILE_NAME, StorageError, ConflictError, type ReadResult, type StorageAdapter, type WriteResult } from '../../packages/health-core/src/adapter';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { DriveAdapter } from '../../packages/health-core/src/drive-rest';
import { LiveRefresh } from '../../packages/health-core/src/live-refresh';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import type { RecordHost } from '../../packages/health-core/src/record-host';
import { RecordSession, saveRecordInto } from '../../packages/health-core/src/record-session';
import { copyCloudDown, liftDeviceCopy } from '../../packages/health-core/src/record-transfer';
import { describeStorageFailure } from '../../packages/health-core/src/sync-manager';
import { applyEdit, type Edit } from './my-data';

export type Provider = 'dropbox' | 'google-drive';

const LABELS: Record<Provider, string> = { dropbox: 'Dropbox', 'google-drive': 'Google Drive' };

/** What Swift gives the sync (CloudSync.swift, EngineNatives.swift). */
export interface CloudNatives {
  /** A current access token. `force` after the provider refused the last one.
   *  `error` set means the user must sign in again. */
  accessToken(provider: Provider, force: boolean, done: (token: string | null, error: string | null) => void): void;
  /** The phone's record file: `{"text": "..."}`, `{"text": null}` when there is
   *  none, or `{"error": "..."}` when it cannot be read. */
  phoneRead(): string;
  /** Writes the phone's record file atomically; answers an error or null. */
  phoneWrite(text: string): string | null;
  phoneRemove(): void;
  /** The marker that says the phone holds changes the cloud lacks (US-09 AC4). */
  pending(op: 'get' | 'set' | 'clear'): boolean;
  /** Tells Swift what happened: 'saving', 'saved', 'failed' or 'changed'. Never a
   *  log: the payload is the record for 'changed', which Swift only shows. */
  notify(event: 'saving' | 'saved' | 'failed' | 'changed', payload: string): void;
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
    __native.accessToken(provider, force, (token, error) => {
      if (token) resolve(token);
      else reject(new SignInError(error ?? `${LABELS[provider]} needs you to sign in again.`));
    });
  });
}

/**
 * The user's cloud, through health-core's own REST adapter, with a fresh
 * access token for each call (the phone refreshes with PKCE, in Swift). A
 * call the provider refuses with 401 runs once more on a forced refresh.
 * Documents are not synced by the app yet.
 */
class PhoneCloudAdapter implements StorageAdapter {
  readonly id: 'dropbox' | 'google-drive';
  readonly label: string;
  private current: { token: string; adapter: StorageAdapter } | null = null;

  constructor(private readonly provider: Provider) {
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
    __native.notify('saving', '');
    const written = await this.run((cloud) => cloud.write(fileName, body, expectedVersion, signal));
    __native.notify('saved', '');
    return written;
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The iPhone app does not sync documents yet.');
  }
  async writeDocument(): Promise<void> {
    throw new StorageError('The iPhone app does not sync documents yet.');
  }

  private async run<T>(call: (cloud: StorageAdapter) => Promise<T>): Promise<T> {
    try {
      return await call(await this.adapter(false));
    } catch (error) {
      if (!(error instanceof StorageError) || error.status !== 401 || error instanceof SignInError) throw error;
      return call(await this.adapter(true));
    }
  }

  /** One adapter per token, so Drive's file-id cache lives as long as the token. */
  private async adapter(force: boolean): Promise<StorageAdapter> {
    const token = await accessToken(this.provider, force);
    if (this.current?.token !== token) {
      this.current = { token, adapter: this.provider === 'dropbox' ? new DropboxAdapter(token) : new DriveAdapter(token) };
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
class PhoneFileAdapter implements StorageAdapter {
  readonly id = 'file' as const;
  readonly label = 'This iPhone';

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /** The raw text, or null when there is no file. Throws when it cannot be read. */
  text(): string | null {
    const answer = JSON.parse(__native.phoneRead()) as { text?: string | null; error?: string };
    if (answer.error !== undefined) throw new StorageError(answer.error);
    return answer.text ?? null;
  }

  body(): unknown {
    const text = this.text();
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new StorageError('The record on this iPhone is not valid JSON.', undefined, error);
    }
  }

  async read(fileName: string): Promise<ReadResult> {
    if (fileName !== ROADMAP_FILE_NAME) return { body: null, version: null };
    const body = this.body();
    return { body, version: body === null ? null : fingerprint(this.text()!) };
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    if (fileName !== ROADMAP_FILE_NAME) throw new StorageError(`This iPhone keeps only ${ROADMAP_FILE_NAME}.`);
    const now = this.text();
    if ((now === null ? null : fingerprint(now)) !== expectedVersion) throw new ConflictError();
    const text = JSON.stringify(body);
    const error = __native.phoneWrite(text);
    if (error !== null) throw new StorageError(error);
    return { version: fingerprint(text) };
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The iPhone keeps no documents yet.');
  }
  async writeDocument(): Promise<void> {
    throw new StorageError('The iPhone keeps no documents yet.');
  }
}

type CloudHost = Extract<RecordHost, { tier: 'cloud' }>;

/** What went wrong, as one word Swift turns into plain words (SyncStatus.swift). */
export function failureKind(error: unknown): 'sign-in' | 'too-new' | 'unreachable' {
  if (error instanceof SignInError) return 'sign-in';
  if (error instanceof StorageError && (error.status === 401 || error.status === 403)) return 'sign-in';
  if (error instanceof SchemaTooNewError) return 'too-new';
  return 'unreachable';
}

function failed(provider: Provider, error: unknown): string {
  return JSON.stringify({ kind: failureKind(error), detail: describeStorageFailure(error, `The record in ${LABELS[provider]}`).message });
}

function hostFor(provider: Provider, deviceId: string, phone: PhoneFileAdapter): CloudHost {
  return {
    tier: 'cloud',
    store: new PhoneCloudAdapter(provider),
    mirror: {
      adapter: phone,
      pending: {
        get: () => __native.pending('get'),
        set: () => void __native.pending('set'),
        clear: () => void __native.pending('clear'),
      },
      // The phone never logs off underneath an open session: Disconnect closes
      // the session first (cloudClose).
      writesStopped: () => false,
      wipe: async () => __native.phoneRemove(),
      opened: () => {},
    },
    // The app keeps no health data outside the record yet. Apple Health
    // samples and notifications join here when they land (D5, D6, D7).
    clearOffFileData: () => {},
    deviceRecord: () => phone.body(),
    deviceId: () => deviceId,
    clock: { now: () => Date.now() },
    timers: {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle as number),
    },
    remoteChanged: () => announce(),
    failureCause: () => 'other',
    report(error, at) {
      if (at.op === 'persist') __native.notify('failed', failed(provider, error));
    },
  };
}

interface Open {
  provider: Provider;
  host: CloudHost;
  phone: PhoneFileAdapter;
  session: RecordSession;
  live: LiveRefresh;
  visible: boolean;
  /** Edits not yet flushed. A flush with none skips the round trip: the
   *  session's own save runs on its debounce, and its pending marker keeps
   *  anything unsaved for the next session. */
  unflushed: number;
}

let open: Open | null = null;

/** The record and the erase it is at, as Swift keeps them. */
function view(session: RecordSession): string {
  return JSON.stringify({ record: JSON.stringify(session.file), erase: session.eraseIdentity });
}

/** A re-read or a save brought something in: Swift shows it, and the phone's
 *  copy takes it too, so the app opens with it when the cloud cannot be reached. */
function announce(): void {
  if (!open) return;
  __native.notify('changed', view(open.session));
  keepPhoneCopy(open);
}

/** Merge the working copy into the phone's file. Best effort: the phone's copy
 *  is a convenience while the cloud holds the record; an unreadable phone
 *  file is never written over (saveRecordInto reads first). */
function keepPhoneCopy(at: Open): void {
  void saveRecordInto(at.phone, at.session.file, { deviceId: at.host.deviceId(), now: new Date().toISOString() }).catch(() => {});
}

/**
 * Open the cloud record. `firstConnect`: merge the phone's record up first
 * (health-core's lift, US-09 AC3), so neither side's rows are lost. A lift the
 * cloud refused marks the phone copy pending, and the session merges it in.
 * Rejects when the cloud cannot be read; the app then stays on the phone.
 */
export async function cloudOpen(provider: Provider, deviceId: string, firstConnect: boolean): Promise<string> {
  await cloudClose(false);
  const phone = new PhoneFileAdapter();
  const host = hostFor(provider, deviceId, phone);
  if (firstConnect) {
    try {
      await liftDeviceCopy(host);
    } catch {
      /* the pending marker is set; the session below merges the phone copy in */
    }
  }
  const session = await RecordSession.open(host);
  const at: Open = { provider, host, phone, session, live: null!, visible: true, unflushed: 0 };
  at.live = new LiveRefresh(session, host, { reread: () => session.refreshFromRemote(), isVisible: () => at.visible });
  open = at;
  at.live.start();
  keepPhoneCopy(at);
  return view(session);
}

/**
 * One My data edit, through the session (D4): the engine's write rule on the
 * working copy, then `RecordSession.edit` with the erase the screen showed, so
 * it is saved by the save loop, merged on a conflict, and refused if an erase
 * from another device has arrived since. The phone's copy and its pending
 * marker are written first, so an edit that has not reached the cloud yet
 * survives the app being closed (US-09 AC4).
 */
export function cloudEdit(editJson: string, erase: string, nowIso: string): string {
  if (!open) return JSON.stringify({ ok: false, reason: 'not-open', message: 'The cloud record is not open.' });
  const { session } = open;
  const outcome = applyEdit(session.file, JSON.parse(editJson) as Edit, nowIso);
  if (!outcome.ok) return JSON.stringify(outcome);
  if (!session.edit(() => outcome.file, erase)) {
    return JSON.stringify({ ok: false, reason: 'erased', message: 'Your record was erased on another device, so this was not saved. Try again.' });
  }
  open.unflushed += 1;
  open.host.mirror.pending.set();
  keepPhoneCopy(open);
  return JSON.stringify({ ok: true, record: JSON.stringify(session.file), erase: session.eraseIdentity });
}

/** The app came to the foreground: re-read (US-34), and retry a refused save. */
export function cloudVisible(): void {
  if (!open) return;
  open.visible = true;
  open.live.visible();
  open.session.flushSync();
}

/** The app left the screen: stop re-reading until it comes back. */
export function cloudHidden(): void {
  if (!open) return;
  open.visible = false;
  open.live.hidden();
}

/** Re-read now ("Sync now"): answers 'changed' or 'same'. */
export async function cloudRefresh(): Promise<string> {
  if (!open) return 'same';
  return (await open.session.refreshFromRemote()) ? 'changed' : 'same';
}

/** Save what is waiting, now (the app is going to the background). */
export async function cloudFlush(): Promise<string> {
  return open ? flush(open) : 'saved';
}

async function flush(at: Open): Promise<'saved' | 'failed'> {
  if (at.unflushed === 0) return 'saved';
  const edits = at.unflushed;
  at.unflushed = 0;
  try {
    await at.session.flush();
    return 'saved';
  } catch {
    // Refused: the session has mirrored it onto the phone. Still unflushed.
    at.unflushed += edits;
    return 'failed';
  }
}

/**
 * Close the session. With `copyDown` (Disconnect), the cloud record is merged
 * down into the phone's file first (health-core's copyCloudDown, US-09 AC2),
 * so the phone goes back to a record that holds everything. A cloud that
 * cannot be read leaves the phone's own copy, which already holds every edit
 * made here: answers 'unreachable'. The cloud file is never written.
 */
export async function cloudClose(copyDown: boolean): Promise<string> {
  const at = open;
  if (!at) return 'none';
  open = null;
  at.live.stop();
  await flush(at);
  if (!copyDown) return 'closed';
  try {
    await copyCloudDown(at.host);
    return 'copied';
  } catch {
    return 'unreachable';
  }
}
