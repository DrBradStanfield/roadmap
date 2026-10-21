// Cloud sync for the iPhone app (US-25 AC11; ios/architecture.md D2, D4, D5).
// The record lives in the user's Dropbox or Google Drive, the same
// health-roadmap.json the website uses. Everything that decides what is
// written is health-core's: RecordSession (save loop, re-read, merge on
// conflict, erase guard), SyncManager, the REST adapters, the lift on first
// connect and the copy-down on leaving. This file only builds the RecordHost
// the phone stands behind, out of the natives Swift supplies.
import { ROADMAP_FILE_NAME, StorageError, ConflictError, UNREACHABLE_HINT, type ReadResult, type StorageAdapter, type WriteResult } from '../../packages/health-core/src/adapter';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { DriveAdapter } from '../../packages/health-core/src/drive-rest';
import { LiveRefresh } from '../../packages/health-core/src/live-refresh';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import type { RecordHost } from '../../packages/health-core/src/record-host';
import { ERASE_UNREACHABLE, RecordSession, saveRecordInto } from '../../packages/health-core/src/record-session';
import { copyCloudDown, liftDeviceCopy } from '../../packages/health-core/src/record-transfer';
import { describeStorageFailure } from '../../packages/health-core/src/sync-manager';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { eraseChatText } from './app-doors';
import { applyEdit, type Edit } from './my-data';

export type Provider = 'dropbox' | 'google-drive';

const LABELS: Record<Provider, string> = { dropbox: 'Dropbox', 'google-drive': 'Google Drive' };

/** What Swift gives the sync (CloudSync.swift, EngineNatives.swift). */
export interface CloudNatives {
  /** A current access token. `force` after the provider refused the last one.
   *  On failure, `error` says why and `signIn` whether only signing in again
   *  fixes it (a refresh token the provider refused) or a retry may (no network). */
  accessToken(provider: Provider, force: boolean, done: (token: string | null, error: string | null, signIn: boolean) => void): void;
  /** The phone's record file: `{"text": "..."}`, `{"text": null}` when there is
   *  none, or `{"error": "..."}` when it cannot be read. */
  phoneRead(): string;
  /** Writes the phone's record file atomically; answers the error, or '' when it landed. */
  phoneWrite(text: string): string;
  phoneRemove(): void;
  /** The marker that says the phone holds changes the cloud lacks (US-09 AC4). */
  pending(op: 'get' | 'set' | 'clear'): boolean;
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
      else reject(new StorageError(error ?? `${LABELS[provider]} did not answer`, UNREACHABLE_HINT));
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
    __native.notify('saving', '', this.session);
    const written = await this.run((cloud) => cloud.write(fileName, body, expectedVersion, signal));
    __native.notify('saved', '', this.session);
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
    return { version: this.writeText(JSON.stringify(body)) };
  }

  /** Writes the file now; answers its version, throws when the phone refused. */
  writeText(text: string): string {
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

type CloudHost = Extract<RecordHost, { tier: 'cloud' }>;

/** What went wrong, as one word Swift turns into plain words (SyncStatus.swift). */
export function failureKind(error: unknown): 'sign-in' | 'too-new' | 'storage-full' | 'unreachable' {
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

function failed(provider: Provider, error: unknown): string {
  return JSON.stringify({ kind: failureKind(error), detail: describeStorageFailure(error, `The record in ${LABELS[provider]}`).message });
}

function hostFor(provider: Provider, deviceId: string, phone: PhoneFileAdapter, id: number): CloudHost {
  return {
    tier: 'cloud',
    store: new PhoneCloudAdapter(provider, id),
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
    remoteChanged: () => {
      if (open?.id === id) announce(open);
    },
    failureCause: () => 'other',
    report(error, at) {
      if (at.op === 'persist') __native.notify('failed', failed(provider, error), id);
    },
  };
}

interface Open {
  /** This session's number: Swift acts only on news from the one it shows. */
  id: number;
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
/** The newest open or close asked for. An open that finishes after a newer
 *  open or a close began is out of date: it closes itself and rejects, so two
 *  opens racing never leave one session orphaned and the other shown. */
let latest = 0;

/** The record, the erase it is at and the session, as Swift keeps them. */
function view(at: { id: number; session: RecordSession }): string {
  return JSON.stringify({ record: JSON.stringify(at.session.file), erase: at.session.eraseIdentity, session: at.id });
}

/** A re-read or a save brought something in: Swift shows it, and the phone's
 *  copy takes it too, so the app opens with it when the cloud cannot be reached. */
function announce(at: Open): void {
  __native.notify('changed', view(at), at.id);
  keepPhoneCopy(at);
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
  const id = ++latest;
  const phone = new PhoneFileAdapter();
  const host = hostFor(provider, deviceId, phone, id);
  if (firstConnect) {
    try {
      await liftDeviceCopy(host);
    } catch {
      /* the pending marker is set; the session below merges the phone copy in */
    }
  }
  // A pending phone copy is merged in by the session's open and saved on its
  // debounce; counted here so a flush on going to the background sends it too.
  const waiting = host.mirror.pending.get();
  let session: RecordSession;
  try {
    session = await RecordSession.open(host);
  } catch (error) {
    // Swift reads the kind from the message (CloudSync.swift).
    throw new Error(failed(provider, error));
  }
  const at: Open = { id, provider, host, phone, session, live: null!, visible: true, unflushed: waiting ? 1 : 0 };
  at.live = new LiveRefresh(session, host, { reread: () => reread(at), isVisible: () => at.visible });
  if (id !== latest) {
    // A newer open or a close began while this one read: this one gives way.
    // Its save, if the open merged a pending phone copy, still settles.
    await session.flush().catch(() => {});
    throw new Error('superseded');
  }
  if (open) await closeAt(open, false); // an older open that finished first
  open = at;
  at.live.start();
  keepPhoneCopy(at);
  return view(at);
}

/** Only edits whose number is read in the user's units can be misread after a
 *  unit change: a value, a correction, a height. */
function dependsOnUnits(edit: Edit): boolean {
  return edit.kind === 'add' || edit.kind === 'correct' || (edit.kind === 'profile' && edit.height !== undefined);
}

/**
 * One My data edit, through the session (D4): the engine's write rule on the
 * working copy, then `RecordSession.edit` with the erase the screen showed, so
 * it is saved by the save loop, merged on a conflict, and refused if an erase
 * from another device has arrived since. The phone's copy and its pending
 * marker are written first, so an edit that has not reached the cloud yet
 * survives the app being closed (US-09 AC4).
 */
export function cloudEdit(editJson: string, erase: string, shownUnits: string, nowIso: string): string {
  const refuse = (reason: string, message: string) => JSON.stringify({ ok: false, reason, message });
  const at = open;
  if (!at) return refuse('not-open', 'The cloud record is not open.');
  const { session } = at;
  const edit = JSON.parse(editJson) as Edit;
  // A number is read in the units the screen showed. If another device has
  // changed the units since, the same number would be stored in the wrong ones.
  if (dependsOnUnits(edit) && shownUnits !== (session.file.profile.unitSystem ?? 'si')) {
    return refuse('units-changed', 'Your units were changed on another device, so this was not saved. Check the value and its unit, then save again.');
  }
  if (session.refuses(erase)) {
    return refuse('erased', 'Your record was erased on another device, so this was not saved. Try again.');
  }
  const outcome = applyEdit(session.file, edit, nowIso);
  if (!outcome.ok) return JSON.stringify(outcome);
  // On the phone first, marked for the cloud: only then is the edit taken. A
  // phone that cannot keep it refuses it, and nothing changes (US-09 AC4).
  at.host.mirror.pending.set();
  try {
    at.phone.mergeNow(outcome.file, { deviceId: at.host.deviceId(), now: nowIso });
  } catch (error) {
    return refuse('phone-write', `This iPhone could not save it, so nothing changed. ${(error as Error).message}`);
  }
  session.edit(() => outcome.file, erase);
  at.unflushed += 1;
  return JSON.stringify({ ok: true, record: JSON.stringify(session.file), erase: session.eraseIdentity });
}

/**
 * "Delete all my data" with a cloud open (US-25 AC13, US-11): health-core's
 * RecordSession.deleteAllData, the web's order and guard. The cloud record is
 * read first; one that cannot be read refuses, and nothing changes anywhere,
 * the chat history included. Then the chat tombstones (the phone's own file:
 * Swift writes `chatHistory` when `chatErased`), then the erased record, by a
 * higher eraseEpoch: the file stays in the cloud with the erase in it, so other
 * devices take it in (US-11 AC6). The app's reminders have no server to tear
 * down: they follow the epoch (ReminderScheduler).
 *
 * `erased`: the working copy is now the erased record, written or not. When
 * the write failed, the session mirrored it onto the phone, marked pending,
 * and the next flush or open sends it: the screen shows it, and the app says
 * the cloud still has to take it. On success the session wiped the pre-erase
 * mirror; the erased record goes in its place, so an offline launch opens on it.
 */
export async function cloudErase(historyText: string | null, nowIso: string): Promise<string> {
  const at = open;
  if (!at) return JSON.stringify({ success: false, error: ERASE_UNREACHABLE, chatErased: false, chatHistory: null, erased: false, view: null });
  const before = at.session.eraseIdentity;
  let chatHistory: string | null = null;
  const result = await at.session.deleteAllData({
    chat: async () => ({ eraseAll: async () => { chatHistory = await eraseChatText(historyText, nowIso, at.host.deviceId()); } }),
  });
  const erased = at.session.eraseIdentity !== before;
  if (result.success) {
    await saveRecordInto(at.phone, at.session.file, { deviceId: at.host.deviceId(), now: nowIso }).catch(() => {});
    at.unflushed = 0;
  } else if (erased) {
    at.unflushed += 1; // the background flush retries it
  }
  return JSON.stringify({ ...result, chatHistory, erased, view: erased ? JSON.parse(view(at)) : null });
}

/** The app came to the foreground: re-read (US-34), and retry a refused save. */
export function cloudVisible(): string {
  if (!open) return '';
  open.visible = true;
  open.live.visible();
  open.session.flushSync();
  return '';
}

/** The app left the screen: stop re-reading until it comes back. */
export function cloudHidden(): string {
  if (!open) return '';
  open.visible = false;
  open.live.hidden();
  return '';
}

/** Re-read now ("Sync now"): answers 'changed' or 'same'. A failure rejects
 *  with its kind, as an open does. */
export async function cloudRefresh(): Promise<string> {
  if (!open) return 'same';
  return (await reread(open)) ? 'changed' : 'same';
}

/** Every re-read, asked for or on the minute, tells Swift how it went: a
 *  revoked grant must show "Sign in again" even when no save is waiting, and a
 *  re-read that works clears a passing failure. */
async function reread(at: Open): Promise<boolean> {
  // A save that failed is retried first; while it waits the session does not
  // re-read (its working copy is ahead of the cloud).
  at.session.flushSync();
  try {
    const changed = await at.session.refreshFromRemote();
    // "Synced" only when nothing waits on the phone: the session clears the
    // pending marker when a save lands, and never before (review F1).
    if (!__native.pending('get')) __native.notify('synced', '', at.id);
    return changed;
  } catch (error) {
    const why = failed(at.provider, error);
    __native.notify('failed', why, at.id);
    throw new Error(why);
  }
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
  latest += 1; // an open still reading gives way (see `latest`)
  const at = open;
  if (!at) return 'none';
  open = null;
  return closeAt(at, copyDown);
}

async function closeAt(at: Open, copyDown: boolean): Promise<string> {
  if (open === at) open = null;
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
