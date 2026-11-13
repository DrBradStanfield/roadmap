// Cloud sync for the iPhone app (US-25 AC11; ios/architecture.md D2, D4, D5).
// The record lives in the user's Dropbox or Google Drive, the same
// health-roadmap.json the website uses. Everything that decides what is
// written is health-core's: RecordSession (save loop, re-read, merge on
// conflict, erase guard), SyncManager, the REST adapters, the lift on first
// connect and the copy-down on leaving. This file builds the RecordHost the
// phone stands behind (its stores: cloud-adapters.ts) and the session doors
// Swift calls. Web twin: widget-src/src/storage/roadmap-store.ts, the web's
// RecordSession owner.
import { StorageError } from '../../packages/health-core/src/adapter';
import { ChatSession } from '../../packages/health-core/src/chat-session';
import { LiveRefresh } from '../../packages/health-core/src/live-refresh';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import type { RecordHost } from '../../packages/health-core/src/record-host';
import { ERASE_UNREACHABLE, RecordSession, saveRecordInto } from '../../packages/health-core/src/record-session';
import { copyCloudDown, liftDeviceCopy } from '../../packages/health-core/src/record-transfer';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { failed, PhoneCloudAdapter, PhoneFileAdapter, type CloudNatives, type Provider } from './cloud-adapters';
import { eraseChatText } from './app-doors';
import { labRows, labSaveSummary, type Extraction } from './lab-review';
import { movedBloodTests, parseEdit, type Edit } from './my-data';
import { guardedEdit, refuse, type EditTarget, type Refusal } from './guarded-edit';
import { checkArgs } from './contract';

declare const __native: CloudNatives;

type CloudHost = Extract<RecordHost, { tier: 'cloud' }> & { store: PhoneCloudAdapter };

function hostFor(provider: Provider, deviceId: string, phone: PhoneFileAdapter, id: number): CloudHost {
  // The marker generation this session's working copy holds: the one it saw as it
  // read the phone's file, or the one its own commit or failed save set. A marker
  // set after that (a phone edit while the open ran) is never cleared by it.
  let held = 0;
  return {
    tier: 'cloud',
    store: new PhoneCloudAdapter(provider, id),
    mirror: {
      adapter: phone,
      pending: {
        get: () => (held = __native.pending('get')) > 0,
        // Raised only from the generation it holds: a set it did not make (a phone
        // edit the session never read) stays unheld, so its marker outlives this session.
        set: () => {
          const before = __native.pending('get');
          const after = __native.pending('set');
          if (before === held || before === 0) held = after;
        },
        // The session clears the marker only when a save has landed and been
        // verified: the one moment the record is in sync (re-check R3), and only
        // the generation it holds.
        clear: () => {
          if (__native.pending(`clear-if:${held}`) === 0) __native.notify('synced', '', id);
        },
      },
      // The phone never logs off underneath an open session: Disconnect closes
      // the session first (cloudClose).
      writesStopped: () => false,
      wipe: async () => __native.phoneRemove(),
      opened: () => {},
    },
    // The app keeps no health data outside the record yet (Apple Health samples
    // and notifications join here, D5-D7), so it keeps no erase cleared for.
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
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

export interface Open {
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

export let open: Open | null = null; // read by entry.ts documentOriginal (US-73 AC12); written only here
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
 * `mergePhone`: the phone took edits while an earlier open ran; the session
 * merges the phone's file in whatever the marker says (Swift's reopen).
 * Rejects when the cloud cannot be read; the app then stays on the phone.
 */
export async function cloudOpen(provider: Provider, deviceId: string, firstConnect: boolean, mergePhone: boolean): Promise<string> {
  checkArgs('cloudOpen', arguments);
  // The number is taken before any await, so the order of the calls decides
  // which open wins, never the order their awaits finish in (re-check R2).
  const id = ++latest;
  const superseded = () => id !== latest;
  const previous = open;
  open = null;
  if (previous) await closeAt(previous, false);
  if (superseded()) throw new Error('superseded');
  const phone = new PhoneFileAdapter();
  const host = hostFor(provider, deviceId, phone, id);
  if (firstConnect) {
    try {
      await liftDeviceCopy(host);
    } catch {
      /* the pending marker is set; the session below merges the phone copy in */
    }
    if (superseded()) throw new Error('superseded');
  }
  if (mergePhone) host.mirror.pending.set();
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
  if (superseded()) {
    // A newer open or a close began while this one read: this one gives way.
    // Its save, if the open merged a pending phone copy, still settles.
    await session.flush().catch(() => {});
    throw new Error('superseded');
  }
  open = at;
  at.live.start();
  // US-66 AC14: the open moved blood tests into one table, against the bytes the
  // cloud holds: written once, as an edit is. A save the cloud refuses waits on
  // the phone, and the next open, reading the old bytes again, writes it again.
  if (movedBloodTests(host.store.lastRecord, session.file)) commit(at, session.file, session.eraseIdentity, new Date().toISOString());
  keepPhoneCopy(at);
  return view(at);
}

export const NOT_OPEN = 'The cloud record is not open.';
export const ERASED = 'Your record was erased on another device, so this was not saved.';

/** Take `next` as the session's working copy: on the phone first, marked for the
 *  cloud, then `RecordSession.edit` with the erase the screen showed. A phone that
 *  cannot keep it refuses it, and nothing changes (US-09 AC4). Answers the
 *  refusal, or null when it was taken. */
export function commit(at: Open, next: RoadmapFile, erase: string, nowIso: string): Refusal | null {
  at.host.mirror.pending.set();
  try {
    at.phone.mergeNow(next, { deviceId: at.host.deviceId(), now: nowIso });
  } catch (error) {
    return refuse('phone-write', `This iPhone could not save it, so nothing changed. ${(error as Error).message}`);
  }
  at.session.edit(() => next, erase);
  at.unflushed += 1;
  return null;
}

/**
 * One My data edit, through the session (D4): the engine's write rule on the
 * working copy, then `RecordSession.edit` with the erase the screen showed, so
 * it is saved by the save loop, merged on a conflict, and refused if an erase
 * from another device has arrived since. The phone's copy and its pending
 * marker are written first, so an edit that has not reached the cloud yet
 * survives the app being closed (US-09 AC4).
 */
export function cloudEdit(editJson: string, erase: string, shownUnits: string, nowIso: string, unitsJson?: string, shownLpaUnit?: string): string {
  checkArgs('cloudEdit', arguments);
  const read = parseEdit(editJson);
  return JSON.stringify(read.ok ? editSession(read.edit, erase, shownUnits, nowIso, unitsJson, shownLpaUnit) : read);
}

/** The open session as an edit's target (guarded-edit.ts), at the erase the screen showed. */
function cloudTarget(at: Open, erase: string, nowIso: string): EditTarget {
  return {
    get file() { return at.session.file; },
    stale: () => (at.session.refuses(erase) ? refuse('erased', `${ERASED} Close this and enter the value again.`) : null),
    commit: (next) => commit(at, next, erase, nowIso),
    answer: () => ({ record: JSON.stringify(at.session.file), erase: at.session.eraseIdentity }),
  };
}

/** cloudEdit's work, answering an object, so cloudLabImport adds its summary without a JSON round trip of the record. */
function editSession(edit: Edit, erase: string, shownUnits: string, nowIso: string, unitsJson?: string, shownLpaUnit?: string) {
  const at = open;
  if (!at) return refuse('not-open', NOT_OPEN);
  return guardedEdit(cloudTarget(at, erase, nowIso), edit, { units: shownUnits, lpaUnit: shownLpaUnit, choicesJson: unitsJson }, nowIso);
}

/**
 * A lab report's ticked values through the session (US-52 AC8), and what saving
 * them did, in one synchronous step: the summary is taken against the working copy
 * the import lands on, so a value another device brought in is never counted as
 * saved. Answers cloudEdit's outcome with `summary` when it was taken.
 */
export function cloudLabImport(extractionJson: string, refsJson: string, reportDay: string, erase: string, shownUnits: string, nowIso: string, unitsJson: string): string {
  checkArgs('cloudLabImport', arguments);
  const at = open;
  if (!at) return JSON.stringify(refuse('not-open', NOT_OPEN));
  const refs = JSON.parse(refsJson) as string[];
  const rows = labRows(JSON.parse(extractionJson) as Extraction, refs, reportDay, nowIso);
  if (!rows.ok) return JSON.stringify(rows);
  const summary = labSaveSummary(at.session.file, rows.rows, nowIso);
  const outcome = editSession({ kind: 'labImport', extractionJson, refs, reportDay }, erase, shownUnits, nowIso, unitsJson);
  return JSON.stringify(outcome.ok ? { ...outcome, summary } : outcome);
}

/**
 * "Delete all my data" with a cloud open (US-25 AC16, US-11): health-core's
 * RecordSession.deleteAllData, the web's order and guard. The cloud record is
 * read first; one that cannot be read refuses, and nothing changes anywhere,
 * the chat history included. Then the chat tombstones, in that step so they
 * land before the record goes up (Codex R3): the chat-history.json the website
 * saved in the cloud (`cloudChatErased`), then the phone's own file, written by
 * Swift's `keepChat` (`chatErased`; it answers '' or why not). Then the erased record, by a
 * higher eraseEpoch: the file stays in the cloud with the erase in it, so other
 * devices take it in (US-11 AC6). The app's reminders have no server to tear
 * down: they follow the epoch (ReminderScheduler).
 *
 * `erased`: the working copy is now the erased record, written or not. When
 * the write failed, the session mirrored it onto the phone, marked pending,
 * and the next flush or open sends it: the screen shows it, and the app says
 * the cloud still has to take it. When that mirror write failed too, the
 * session put its copy back: `erased` is false and nothing changed but the
 * chat step (lead S57). On success the session wiped the pre-erase
 * mirror; the erased record goes in its place, so an offline launch opens on it.
 */
export async function cloudErase(historyText: string | null, nowIso: string, keepChat?: (text: string) => string): Promise<string> {
  checkArgs('cloudErase', arguments);
  const at = open;
  if (!at) return JSON.stringify({ success: false, error: ERASE_UNREACHABLE, chatErased: false, cloudChatErased: false, cloudChatProblem: null, chatHistory: null, erased: false, view: null });
  const before = at.session.eraseIdentity;
  let chatHistory: string | null = null;
  let cloudChatErased = false;
  let cloudChatProblem: 'unreachable' | 'unreadable' | null = null;
  const result = await at.session.deleteAllData({
    chat: async () => ({
      eraseAll: async () => {
        // The cloud's chat-history.json, as the web erases it: through ChatSession
        // on the same host. Best effort and reported on its own: a file the app
        // cannot read (corrupt, or a newer website's schema) must never block the
        // phone's chat erase, on this try or a retry (adversary R1).
        try {
          await (await ChatSession.open(at.host)).eraseAll();
          cloudChatErased = true;
        } catch (error) {
          // Why, so the words fit (adversary M1): a file the app cannot read will
          // not mend on a retry; a provider that did not answer may.
          cloudChatProblem = unreadable(error) ? 'unreadable' : 'unreachable';
        }
        chatHistory = await eraseChatText(historyText, nowIso, at.host.deviceId());
        const refused = chatHistory === null ? '' : keepChat?.(chatHistory);
        if (refused) throw new Error(refused);
      },
    }),
  });
  const erased = at.session.eraseIdentity !== before;
  if (result.success) {
    await saveRecordInto(at.phone, at.session.file, { deviceId: at.host.deviceId(), now: nowIso }).catch(() => {});
    at.unflushed = 0;
  } else if (erased) {
    at.unflushed += 1; // the background flush retries it
  }
  return JSON.stringify({ ...result, cloudChatErased, cloudChatProblem, chatHistory, erased, view: erased ? JSON.parse(view(at)) : null });
}

/** A file read but not understood: not JSON, or a newer schema than this engine's. */
function unreadable(error: unknown): boolean {
  return error instanceof SchemaTooNewError || (error instanceof StorageError && error.cause instanceof SyntaxError);
}

/** The app came to the foreground: re-read (US-34), and retry a refused save. */
export function cloudVisible(): string {
  checkArgs('cloudVisible', arguments);
  if (!open) return '';
  open.visible = true;
  open.live.visible();
  open.session.flushSync();
  return '';
}

/** The app left the screen: stop re-reading until it comes back. */
export function cloudHidden(): string {
  checkArgs('cloudHidden', arguments);
  if (!open) return '';
  open.visible = false;
  open.live.hidden();
  return '';
}

/** Re-read now ("Sync now"): answers 'changed' or 'same'. A failure rejects
 *  with its kind, as an open does. */
export async function cloudRefresh(): Promise<string> {
  checkArgs('cloudRefresh', arguments);
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
  checkArgs('cloudFlush', arguments);
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
  checkArgs('cloudClose', arguments);
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
