/**
 * One upload, on the web and the iPhone, as one named state changed only through a pure
 * `transition(state, event)` (the mode rule, .claude/skills/untangle; the chat-turn.ts pattern).
 * Design: docs/drafts/upload-shared-engine.md §1 and §3 (US-12 AC26, AC28). Effects are data the
 * platform runs, then answers with an event carrying the effect's `run`; an answer for any other
 * run changes nothing. Bytes and pages never enter the state: the platform holds them by file id.
 * No clock: events carry `now`. Run numbers are minted here, from the last one. Files keep the
 * order they were picked in, a ZIP's members at the ZIP's place (US-12 AC23).
 */
import type { UnifiedExtractionResult } from './lab-extraction';
import type { FailDetail, UploadFailure } from './upload-failure';
import { choose, NO_CHOICES, type ChoiceChange, type FileChoices } from './upload-choices';
import type { Known } from './upload-known';
import type { ReviewedValue } from './upload-review';
import { fileVerdict, requestFlags, UPLOAD_LIMITS, zipMemberVerdict, type RequestFlags, type UploadPlatform } from './upload-rules';

/** unreadable: no pages came out of it. bytesUnreadable: the device could not read its bytes to hash them.
 *  zipUnreadable: a ZIP that would not open; zipEmpty: one with no file we can read inside (both named
 *  themselves, US-12 AC9). timeout: the device ran out of time turning it into pages. The rest are the server's answer,
 *  or, on the Pages build, the answer to the person's own Anthropic key: keyRefused, noCredit, keyRateLimit (that
 *  key's per-minute limit, which never stops the run) and noKey (no key at all, a whole run's refusal). The phone
 *  never produces the key reasons. */
export type FailReason = 'unreadable' | 'bytesUnreadable' | 'zipUnreadable' | 'zipEmpty' | 'timeout' | 'busy' | 'dailyLimit' | 'declined' | 'tooLong' | 'server' | 'network'
  | 'keyRefused' | 'noCredit' | 'keyRateLimit' | 'noKey'
  // The iPhone's alone (US-52 AC7e): the app gate refused for good (appRefused) or the body was too large;
  // the phone cannot prove the app at all (cannotAttest), or its proof failed this time (attestFailed).
  | 'appRefused' | 'tooLarge' | 'cannotAttest' | 'attestFailed';

/** Which failures Try again can mend: a busy or unreachable server, a convert that ran out of time, a key's minute limit. */
export const RETRYABLE: Record<FailReason, boolean> = {
  unreadable: false, bytesUnreadable: true, zipUnreadable: false, zipEmpty: false, timeout: true, busy: true, dailyLimit: false, declined: false, tooLong: false, server: true, network: true,
  keyRefused: false, noCredit: false, keyRateLimit: true, noKey: false,
  appRefused: false, tooLarge: false, cannotAttest: false, attestFailed: true,
};
/** The server's failure (upload-failure.ts) as a file's reason. */
const SEND_FAILURE: Record<UploadFailure, FailReason> = {
  rate_limit: 'dailyLimit', busy: 'busy', server_error: 'server', network: 'network', refused: 'declined', too_long: 'tooLong',
  key_refused: 'keyRefused', no_credit: 'noCredit', key_rate_limit: 'keyRateLimit',
  app_refused: 'appRefused', too_large: 'tooLarge', cannot_attest: 'cannotAttest', attest_failed: 'attestFailed',
};
/** A whole run refused before any send: the daily limit, no key (Pages), or the reader could not start. */
export type RunRefusal = Extract<FailReason, 'dailyLimit' | 'noKey' | 'server'>;

export type FileStatus =
  | { s: 'unlisted' }                                      // a picked ZIP waiting for a list slot
  | { s: 'listing' }                                       // a picked ZIP being listed: its members replace it, in its place
  | { s: 'waiting' }                                       // listed; waiting for a hash slot
  | { s: 'hashing' }                                       // the platform hashes its bytes
  | { s: 'hashed' }                                        // hashed and new: waiting for a convert slot
  | { s: 'known'; as: Known['as'] | 'legacy'; archiveOnly: boolean } // never converted or sent; legacy: `legacyMatch` after the read
  | { s: 'refused'; verdict: 'tooLarge' | 'unsupported' | 'tooMany' } // tooMany: past the pick's file cap once its ZIPs open
  | { s: 'converting' }                                    // the platform turns bytes into pages
  | { s: 'ready'; attempt: number }                        // pages held, waiting for a send slot
  | { s: 'sending'; attempt: number }
  | { s: 'read'; extraction: UnifiedExtractionResult; choices: FileChoices }
  | { s: 'failed'; reason: FailReason; attempt: number; detail?: FailDetail } // attempt: sends tried; detail: the send's own words
  | { s: 'stopped' };                                      // Stop or Cancel reached it first
export type FileStage = FileStatus['s'];

/** `zip`: the ZIP's name for a member. `pages`: set once converted; the pages themselves stay with the platform. */
export interface UploadFile {
  id: string; name: string; zip?: string; bytes: number; hash: string | null;
  pages: { count: number; truncated: boolean } | null; status: FileStatus;
}
/** `unstored`: originals the save meant to keep in the cloud that did not land (upload-save.ts); absent is none.
 *  `skippedValues`, `skippedLabValues`: reviewed rows whose slot another writer took while the review was open
 *  (US-12 AC6a), a core value or another lab; absent is none. */
export interface SaveOutcome {
  values: number; documents: number; archived: number; unstored?: number; skippedValues?: number; skippedLabValues?: number;
}

/** `started`, `firstRead`: ISO times, for the first-read count (design §7, R9). */
interface Pick { platform: UploadPlatform; run: number; files: UploadFile[]; started: string; firstRead: string | null }
export type UploadState =
  | { phase: 'choosing'; platform: UploadPlatform; run: number }    // run: the last one, so the next is run + 1
  | (Pick & { phase: 'consent' })                                   // phone only (AC13e): nothing runs yet
  | (Pick & { phase: 'open' })                                      // reading and review at once (R5)
  | (Pick & { phase: 'saving'; attempt: number; reviewed?: ReviewedValue[] }) // reviewed: what the page would write when Save was pressed
  | (Pick & { phase: 'saveFailed'; attempt: number; message: string })
  | (Pick & { phase: 'done'; outcome: SaveOutcome })
  | (Pick & { phase: 'failed'; refused: RunRefusal | null });      // refused: the run as a whole (runRefused); null: only ZIPs that would not open
type Open = Extract<UploadState, { phase: 'open' }>;

/** One picked item; `kind` 'zip' is listed (members arrive in `listed`), never read itself. */
export interface PickedFile { id: string; name: string; bytes: number; kind: 'file' | 'zip' }
/** A ZIP member by its path inside the ZIP. */
export interface ZipMember { id: string; name: string; bytes: number }

export type UploadEvent =
  | { type: 'picked'; files: PickedFile[]; needsConsent: boolean; now: string }
  | { type: 'consented' }
  | { type: 'listed'; run: number; zip: string; members: ZipMember[] }
  | { type: 'zipFailed'; run: number; zip: string }
  | { type: 'hashed'; run: number; id: string; hash: string; known: Known | null } // known: upload-known.ts `knownAs`
  | { type: 'hashFailed'; run: number; id: string }
  | { type: 'converted'; run: number; id: string; pages: number; truncated: boolean }
  | { type: 'convertFailed'; run: number; id: string; reason: 'unreadable' | 'timeout' }
  | { type: 'answered'; run: number; id: string; extraction: UnifiedExtractionResult; legacy: boolean; now: string } // legacy: legacyMatch said known
  | { type: 'sendFailed'; run: number; id: string; failure: UploadFailure; detail?: FailDetail }
  | { type: 'runRefused'; run: number; reason: RunRefusal } // before any send: every file not yet read fails with the reason
  | { type: 'retry'; id: string | 'all' }
  | { type: 'stop' }
  | { type: 'chose'; id: string; change: ChoiceChange; now: string } // now: to refuse a document date in the future
  | { type: 'replacesLost'; lost: Array<{ id: string; ref: string }> } // upload-review `lostReplaces`: each dropped, its value unticked
  | { type: 'saveStarted'; reviewed?: ReviewedValue[] } // reviewed: upload-review `reviewedWrites`, so Save names what it did not write
  | { type: 'saved'; run: number; attempt: number; outcome: SaveOutcome }
  | { type: 'saveFailed'; run: number; attempt: number; message: string }
  | { type: 'close' }    // leaves only when nothing read would be lost
  | { type: 'discard' }; // leaves, dropping what was read

/** The platform runs each, then answers with the matching event. `forget`: drop the held bytes and pages. */
export type UploadEffect =
  | { type: 'list'; run: number; id: string }
  | { type: 'hash'; run: number; id: string }
  | { type: 'convert'; run: number; id: string }
  | { type: 'send'; run: number; id: string; attempt: number; flags: RequestFlags }
  | { type: 'abort'; run: number; ids: string[] }
  | { type: 'forget'; run: number; ids: string[] }
  | { type: 'save'; run: number; attempt: number };

export interface UploadStep { state: UploadState; effects: UploadEffect[] }

export function initialUpload(platform: UploadPlatform): UploadState {
  return { phase: 'choosing', platform, run: 0 };
}

// --- derived ----------------------------------------------------------------

const IN_FLIGHT: readonly FileStage[] = ['unlisted', 'listing', 'waiting', 'hashing', 'hashed', 'converting', 'ready', 'sending'];
/** Not yet sent, so the daily limit fails them: everything in flight but a send. */
const UNSENT: readonly FileStage[] = ['unlisted', 'listing', 'waiting', 'hashing', 'hashed', 'converting', 'ready'];

/** Files and ZIPs still being read: Save waits for these, and only these (a failed file never blocks it). */
export function inFlight(s: UploadState): number {
  return s.phase === 'open' ? idsIn(s.files, IN_FLIGHT).length : 0;
}
/** Nothing is still being read. The view also asks the save plan that something would be written (design §1). */
export function saveEnabled(s: UploadState): boolean {
  return s.phase === 'open' && inFlight(s) === 0;
}

// --- transition -------------------------------------------------------------

const same = (state: UploadState): UploadStep => ({ state, effects: [] });
const idsIn = (files: UploadFile[], stages: readonly FileStage[]) => files.filter((f) => stages.includes(f.status.s)).map((f) => f.id);
const forget = (run: number, ids: string[]): UploadEffect[] => (ids.length ? [{ type: 'forget', run, ids }] : []);
const abort = (run: number, ids: string[]): UploadEffect[] => (ids.length ? [{ type: 'abort', run, ids }] : []);
const pickOf = ({ platform, run, files, started, firstRead }: Pick): Pick => ({ platform, run, files, started, firstRead });
const failed = (f: UploadFile, reason: FailReason, attempt = 0, detail?: FailDetail): UploadFile =>
  ({ ...f, status: { s: 'failed', reason, attempt, ...(detail ? { detail } : {}) } });
const dailyLimited = (f: UploadFile) => f.status.s === 'failed' && f.status.reason === 'dailyLimit';

/** Entries for a pick, or a ZIP's members, in order, by upload-rules' verdicts; a hidden member is dropped. */
function admit(platform: UploadPlatform, picked: PickedFile[], zip?: string) {
  const files: UploadFile[] = [];
  const hidden: string[] = [];
  for (const p of picked) {
    const member = zip !== undefined ? zipMemberVerdict(p.name, platform) : 'keep';
    if (member === 'hidden') { hidden.push(p.id); continue; }
    const verdict = member === 'keep' ? fileVerdict({ name: p.name, bytes: p.bytes, kind: p.kind, platform }) : member;
    const base = { id: p.id, name: p.name, bytes: p.bytes, hash: null, pages: null, ...(zip !== undefined ? { zip } : {}) };
    const status: FileStatus = verdict !== 'keep' ? { s: 'refused', verdict: verdict === 'tooLarge' ? 'tooLarge' : 'unsupported' }
      : p.kind === 'zip' ? { s: 'unlisted' } : { s: 'waiting' };
    files.push({ ...base, status });
  }
  return { files, hidden };
}

/** New entries start (`pump` lists ZIPs and hashes files); refused and hidden ones are dropped. */
function opening(run: number, files: UploadFile[], hidden: string[] = []): UploadEffect[] {
  return forget(run, [...idsIn(files, ['refused']), ...hidden]);
}

/**
 * Starts lists, hashes, converts and sends while fewer than the platform's counts are under way (design
 * §1). Listing reads a whole ZIP, so few run at once. Hashing reads a file's bytes as converting does,
 * so it shares the convert count. Between the two a file is `hashed` and uncounted: a platform must
 * not hold its bytes there (the web reads a ZIP member again to convert it). Every file is hashed before
 * it is converted (R3).
 */
function pump(s: Open, effects: UploadEffect[]): UploadStep {
  const limits = UPLOAD_LIMITS[s.platform];
  let listing = idsIn(s.files, ['listing']).length;
  let hashing = idsIn(s.files, ['hashing']).length; // a 20-file pick: rescans cost nothing
  let converting = idsIn(s.files, ['converting']).length;
  let sending = idsIn(s.files, ['sending']).length;
  const out = [...effects];
  const files = s.files.map((f): UploadFile => {
    if (f.status.s === 'unlisted' && listing < limits.listsInFlight) {
      listing++;
      out.push({ type: 'list', run: s.run, id: f.id });
      return { ...f, status: { s: 'listing' } };
    }
    if (f.status.s === 'waiting' && hashing < limits.convertsInFlight) {
      hashing++;
      out.push({ type: 'hash', run: s.run, id: f.id });
      return { ...f, status: { s: 'hashing' } };
    }
    if (f.status.s === 'hashed' && converting < limits.convertsInFlight) {
      converting++;
      out.push({ type: 'convert', run: s.run, id: f.id });
      return { ...f, status: { s: 'converting' } };
    }
    if (f.status.s === 'ready' && sending < limits.sendsInFlight) {
      sending++;
      out.push({ type: 'send', run: s.run, id: f.id, attempt: f.status.attempt, flags: requestFlags(s.platform) });
      return { ...f, status: { s: 'sending', attempt: f.status.attempt } };
    }
    return f;
  });
  return { state: { ...s, files }, effects: out };
}

/** A landing for one file: only in the open phase, while the file is at `from` (the run is checked first). */
function fileStep(s: UploadState, e: { id: string }, from: FileStage, update: (f: UploadFile, s: Open) => [UploadFile, UploadEffect[]]): UploadStep {
  if (s.phase !== 'open') return same(s);
  const file = s.files.find((f) => f.id === e.id);
  if (!file || file.status.s !== from) return same(s);
  const [next, effects] = update(file, s);
  return pump({ ...s, files: s.files.map((f) => (f.id === e.id ? next : f)) }, effects);
}

function answered(s: UploadState, e: Extract<UploadEvent, { type: 'answered' }>): UploadStep {
  const step = fileStep(s, e, 'sending', (f) => e.legacy
    ? [{ ...f, status: { s: 'known', as: 'legacy', archiveOnly: false } }, forget(e.run, [f.id])]
    : [{ ...f, status: { s: 'read', extraction: e.extraction, choices: NO_CHOICES } }, []]);
  const st = step.state;
  if (st === s || st.phase !== 'open' || st.firstRead !== null) return step;
  return { ...step, state: { ...st, firstRead: e.now } };
}

/**
 * A send failed. The daily limit ends the run's reading (US-12 AC9): sends in flight finish, and
 * every file not yet sent, or failed in a way a retry would send again, fails on the limit. A later
 * failure in such a run is the limit too, so nothing is ever sent again.
 */
function sendFailed(s: UploadState, e: Extract<UploadEvent, { type: 'sendFailed' }>): UploadStep {
  if (s.phase !== 'open') return same(s);
  const file = s.files.find((f) => f.id === e.id);
  if (!file || file.status.s !== 'sending') return same(s);
  const reason = SEND_FAILURE[e.failure];
  const limited = reason === 'dailyLimit' || s.files.some(dailyLimited);
  const own = limited && RETRYABLE[reason] ? 'dailyLimit' : reason;
  const files = s.files.map((f): UploadFile => {
    // The send's own words only for its own reason, never under the daily limit that replaced it.
    if (f.id === e.id) return failed(f, own, file.status.s === 'sending' ? file.status.attempt : 0, own === reason ? e.detail : undefined);
    if (!limited) return f;
    if (UNSENT.includes(f.status.s)) return failed(f, 'dailyLimit');
    return f.status.s === 'failed' && RETRYABLE[f.status.reason] ? failed(f, 'dailyLimit', f.status.attempt) : f;
  });
  const dropped = files.filter((f, i) => dailyLimited(f) && !dailyLimited(s.files[i])).map((f) => f.id);
  return pump({ ...s, files }, forget(s.run, dropped));
}

const badZip = (f: UploadFile) => f.status.s === 'failed' && (f.status.reason === 'zipUnreadable' || f.status.reason === 'zipEmpty');
/** A pick that held only ZIPs that would not open or held nothing we can read fails as a whole (US-12 AC9). */
function settled(step: UploadStep): UploadStep {
  const st = step.state;
  return st.phase === 'open' && st.files.every(badZip) ? { ...step, state: { ...pickOf(st), phase: 'failed', refused: null } } : step;
}

/** A ZIP that would not open is named as a failed entry in its place. */
function zipFailed(s: UploadState, e: Extract<UploadEvent, { type: 'zipFailed' }>): UploadStep {
  const step = fileStep(s, { id: e.zip }, 'listing', (f) => [failed(f, 'zipUnreadable'), forget(e.run, [f.id])]);
  return step.state === s ? step : settled(step);
}

/** A listed ZIP: its members take its place, in order. With nothing inside to read, it stays, named itself (US-12 AC9). */
function listed(s: UploadState, e: Extract<UploadEvent, { type: 'listed' }>): UploadStep {
  if (s.phase !== 'open') return same(s);
  const zip = s.files.find((f) => f.id === e.zip);
  if (zip?.status.s !== 'listing') return same(s);
  const added = admit(s.platform, e.members.map((m) => ({ ...m, kind: 'file' })), zip.name);
  if (added.files.every((f) => f.status.s === 'refused' && f.status.verdict === 'unsupported')) { // empty, hidden or unsupported only
    const empty = failed(zip, 'zipEmpty');
    const dropped = forget(e.run, [zip.id, ...e.members.map((m) => m.id)]);
    // Its list slot is free: the next ZIP opens (pump; zipFailed pumps through fileStep), then a pick of only such ZIPs fails as a whole.
    return settled(pump({ ...s, files: s.files.map((f) => (f === zip ? empty : f)) }, dropped));
  }
  // One pick reads at most filesPerPick files, its ZIPs' members included: the rest are refused, named (US-12 AC17).
  // A ZIP not yet listed counts as one until it is.
  let room = UPLOAD_LIMITS[s.platform].filesPerPick - s.files.filter((f) => f !== zip && f.status.s !== 'refused' && !badZip(f)).length;
  const members = added.files.map((f): UploadFile => (f.status.s === 'refused' ? f : room-- > 0 ? f : { ...f, status: { s: 'refused', verdict: 'tooMany' } }));
  // The ZIP's bytes stay: its members are read from them.
  return pump({ ...s, files: s.files.flatMap((f) => (f === zip ? members : [f])) }, opening(e.run, members, added.hidden));
}

/** Stop or Cancel (AC28): every send in flight aborted, nothing more started, files already read kept. */
function stop(s: Open): UploadStep {
  const halted = idsIn(s.files, IN_FLIGHT);
  if (!halted.length) return same(s);
  const files = s.files.map((f): UploadFile => (IN_FLIGHT.includes(f.status.s) ? { ...f, status: { s: 'stopped' } } : f));
  return { state: { ...s, files }, effects: [...abort(s.run, idsIn(s.files, ['sending'])), ...forget(s.run, halted)] };
}

/** The run refused before any send (US-12 AC10): every file not yet settled fails with the reason, and the pick fails as a whole. */
function runRefused(s: Open, reason: RunRefusal): UploadStep {
  const halted = idsIn(s.files, IN_FLIGHT);
  const files = s.files.map((f): UploadFile => (IN_FLIGHT.includes(f.status.s) ? failed(f, reason) : f));
  return { state: { ...pickOf({ ...s, files }), phase: 'failed', refused: reason }, effects: [...abort(s.run, idsIn(s.files, ['sending'])), ...forget(s.run, halted)] };
}

/** Back to choosing: aborts what is sending and drops every held file. */
function leave(s: Exclude<UploadState, { phase: 'choosing' }>): UploadStep {
  const choosing: UploadState = { phase: 'choosing', platform: s.platform, run: s.run };
  if (s.phase === 'failed' || s.phase === 'done') return same(choosing); // both already dropped everything
  return { state: choosing, effects: [...abort(s.run, idsIn(s.files, ['sending'])), ...forget(s.run, s.files.map((f) => f.id))] };
}

function save(s: Pick, attempt: number, reviewed: ReviewedValue[] | undefined): UploadStep {
  return { state: { ...pickOf(s), phase: 'saving', attempt, ...(reviewed ? { reviewed } : {}) }, effects: [{ type: 'save', run: s.run, attempt }] };
}

const retries = (f: UploadFile, id: string) => f.status.s === 'failed' && RETRYABLE[f.status.reason] && (id === 'all' || f.id === id);

export function transition(s: UploadState, e: UploadEvent): UploadStep {
  if ('run' in e && e.run !== s.run) return same(s); // an answer for another run (US-12 AC5)
  switch (e.type) {
    case 'picked': {
      if (s.phase !== 'choosing' || !e.files.length) return same(s);
      const run = s.run + 1;
      const { files, hidden } = admit(s.platform, e.files);
      const pick: Pick = { platform: s.platform, run, files, started: e.now, firstRead: null };
      // Consent first: nothing runs, not even a hash, until the person agrees (AC13e).
      if (e.needsConsent) return same({ ...pick, phase: 'consent' });
      return pump({ ...pick, phase: 'open' }, opening(run, files, hidden));
    }
    case 'consented':
      return s.phase === 'consent' ? pump({ ...s, phase: 'open' }, opening(s.run, s.files)) : same(s);
    case 'listed': return listed(s, e);
    case 'zipFailed': return zipFailed(s, e);
    case 'hashed':
      return fileStep(s, e, 'hashing', (f) => {
        if (!e.known) return [{ ...f, hash: e.hash, status: { s: 'hashed' } }, []];
        // An archive-only file keeps its bytes: Save files the original behind the held row (design §2 a').
        const known: UploadFile = { ...f, hash: e.hash, status: { s: 'known', ...e.known } };
        return [known, e.known.archiveOnly ? [] : forget(e.run, [f.id])];
      });
    case 'hashFailed':
      return fileStep(s, e, 'hashing', (f) => [failed(f, 'bytesUnreadable'), []]);
    case 'converted':
      return fileStep(s, e, 'converting', (f) => [{ ...f, pages: { count: e.pages, truncated: e.truncated }, status: { s: 'ready', attempt: 1 } }, []]);
    case 'convertFailed':
      return fileStep(s, e, 'converting', (f) => [failed(f, e.reason), []]);
    case 'answered': return answered(s, e);
    case 'sendFailed': return sendFailed(s, e);
    case 'runRefused': return s.phase === 'open' ? runRefused(s, e.reason) : same(s);
    case 'retry': {
      if (s.phase !== 'open' || !s.files.some((f) => retries(f, e.id))) return same(s);
      // Each goes back to where it failed: a failed hash is hashed again, a failed convert converted again
      // from the hashed bytes, and pages still held after a failed send go straight back to a send slot.
      const back = (f: UploadFile, attempt: number): FileStatus => (f.hash === null ? { s: 'waiting' } : f.pages === null ? { s: 'hashed' } : { s: 'ready', attempt: attempt + 1 });
      const files = s.files.map((f): UploadFile => (!retries(f, e.id) || f.status.s !== 'failed' ? f : { ...f, status: back(f, f.status.attempt) }));
      return pump({ ...s, files }, []);
    }
    case 'stop': return s.phase === 'open' ? stop(s) : same(s);
    case 'chose': {
      // A choice after a failed Save returns the upload to an ordinary review: the retry writes what it shows (US-12 AC6).
      const file = s.phase === 'open' || s.phase === 'saveFailed' ? s.files.find((f) => f.id === e.id) : undefined;
      if ((s.phase !== 'open' && s.phase !== 'saveFailed') || file?.status.s !== 'read') return same(s);
      const choices = choose(file.status.choices, e.change, e.now, file.status.extraction);
      if (!choices) return same(s); // refused: a document date that is no real past day
      return same({ ...pickOf(s), phase: 'open', files: s.files.map((f) => (f === file ? { ...file, status: { ...file.status, choices } } : f)) });
    }
    case 'replacesLost': {
      if (s.phase !== 'open' && s.phase !== 'saveFailed') return same(s);
      // Nothing is written without the person's say: the value goes back to an ordinary unticked one (owner ruling 2026-11-20).
      let changed = false;
      const files = s.files.map((f): UploadFile => {
        if (f.status.s !== 'read') return f;
        const refs = e.lost.filter((l) => l.id === f.id && f.status.s === 'read' && f.status.choices.replace[l.ref] !== undefined).map((l) => l.ref);
        if (!refs.length) return f;
        changed = true;
        const { choices } = f.status;
        const replace = Object.fromEntries(Object.entries(choices.replace).filter(([ref]) => !refs.includes(ref)));
        return { ...f, status: { ...f.status, choices: { ...choices, replace, ticks: { ...choices.ticks, ...Object.fromEntries(refs.map((ref) => [ref, false])) } } } };
      });
      return changed ? same({ ...pickOf(s), phase: 'open', files }) : same(s);
    }
    case 'saveStarted':
      if (s.phase === 'saveFailed') return save(s, s.attempt + 1, e.reviewed);
      return s.phase === 'open' && saveEnabled(s) ? save(s, 1, e.reviewed) : same(s);
    case 'saved':
      if (s.phase !== 'saving' || s.attempt !== e.attempt) return same(s);
      return { state: { ...pickOf(s), phase: 'done', outcome: e.outcome }, effects: forget(s.run, s.files.map((f) => f.id)) };
    case 'saveFailed':
      return s.phase === 'saving' && s.attempt === e.attempt ? same({ ...pickOf(s), phase: 'saveFailed', attempt: s.attempt, message: e.message }) : same(s);
    case 'close': {
      if (s.phase === 'choosing' || s.phase === 'saving' || s.phase === 'saveFailed') return same(s);
      if (s.phase === 'open' && s.files.some((f) => f.status.s === 'read')) return same(s); // discard, or save, first
      return leave(s);
    }
    case 'discard': return s.phase === 'choosing' || s.phase === 'saving' ? same(s) : leave(s);
  }
}
