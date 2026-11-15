/**
 * One upload, on the web and the iPhone, as one named state changed only through a pure
 * `transition(state, event)` (the mode rule, .claude/skills/untangle; the chat-turn.ts pattern).
 * Design: docs/drafts/upload-shared-engine.md §1 and §3 (US-12 AC26, AC28). Effects are data the
 * platform runs, then answers with an event carrying the effect's `run`; an answer for any other
 * run changes nothing. Bytes and pages never enter the state: the platform holds them by file id.
 * No clock: events carry `now`. Run numbers are minted here, from the last one.
 */
import type { UnifiedExtractionResult } from './lab-extraction';
import { fileVerdict, UPLOAD_LIMITS, zipMemberVerdict, type UploadPlatform } from './upload-rules';

/** What the record already holds for a file. upload-known.ts answers it by hash (`knownAs`, design
 *  PR 4) or, after a read, by name for an older hashless row (`legacyMatch`); this is the part read here. */
export interface Known { as: 'document' | 'labReport' | 'legacy'; archiveOnly: boolean }

/** timeout: the device ran out of time turning it into pages; worth a retry, unlike unreadable. */
export type FailReason = 'unreadable' | 'timeout' | 'busy' | 'dailyLimit' | 'declined' | 'network' | 'server' | 'refused';

/** A document's corrections before Save (design Q3 (a)). */
export interface DocumentFix { title?: string; kind?: string; date?: string | null }
/** What the person chose for one read file: value ticks by ref (absent: the default), a test day, document fixes. */
export interface FileChoices { ticks: Record<string, boolean>; testDay: string | null; document: DocumentFix }
export type ChoiceChange = { tick: string; on: boolean } | { testDay: string | null } | { document: DocumentFix };

export type FileStatus =
  | { s: 'waiting' }                                       // listed; being hashed
  | { s: 'hashed' }                                        // hashed and new: waiting for a convert slot
  | { s: 'known'; as: Known['as']; archiveOnly: boolean }  // never converted or sent
  | { s: 'refused'; verdict: 'tooLarge' | 'unsupported' }
  | { s: 'converting' }                                    // the platform turns bytes into pages
  | { s: 'ready'; attempt: number }                        // pages held, waiting for a send slot
  | { s: 'sending'; attempt: number }
  | { s: 'read'; extraction: UnifiedExtractionResult; choices: FileChoices }
  | { s: 'failed'; reason: FailReason; attempt: number } // attempt: sends tried (0: the convert failed)
  | { s: 'stopped' };                                      // Stop, Cancel or a failed pick reached it first
export type FileStage = FileStatus['s'];

/** `zip`: the ZIP's name for a member. `pages`: set once converted; the pages themselves stay with the platform. */
export interface UploadFile {
  id: string; name: string; zip?: string; bytes: number; hash: string | null;
  pages: { count: number; truncated: boolean } | null; status: FileStatus;
}
/** A picked ZIP the platform is still listing. */
export interface PendingZip { id: string; name: string }
export interface SaveOutcome { values: number; documents: number; archived: number }

/** `started`, `firstRead`: ISO times, for the first-read count (design §7, R9). */
interface Pick { platform: UploadPlatform; run: number; files: UploadFile[]; started: string; firstRead: string | null }
export type UploadState =
  | { phase: 'choosing'; platform: UploadPlatform; run: number }    // run: the last one, so the next is run + 1
  | (Pick & { phase: 'consent'; zips: PendingZip[] })               // phone only (AC13e): nothing runs yet
  | (Pick & { phase: 'open'; zips: PendingZip[] })                  // reading and review at once (R5)
  | (Pick & { phase: 'saving'; attempt: number })
  | (Pick & { phase: 'saveFailed'; attempt: number; message: string })
  | (Pick & { phase: 'done'; outcome: SaveOutcome })
  | { phase: 'failed'; platform: UploadPlatform; run: number; message: string }; // the pick as a whole (ZIP unreadable)
type Open = Extract<UploadState, { phase: 'open' }>;

/** One picked item; `kind` 'zip' is listed (members arrive in `listed`), never read itself. */
export interface PickedFile { id: string; name: string; bytes: number; kind: 'file' | 'zip' }
/** A ZIP member by its path inside the ZIP. */
export interface ZipMember { id: string; name: string; bytes: number }

export type UploadEvent =
  | { type: 'picked'; files: PickedFile[]; needsConsent: boolean; now: string }
  | { type: 'consented' }
  | { type: 'listed'; run: number; zip: string; members: ZipMember[] }
  | { type: 'pickFailed'; run: number; message: string }
  | { type: 'hashed'; run: number; id: string; hash: string; known: Known | null }
  | { type: 'converted'; run: number; id: string; pages: number; truncated: boolean }
  | { type: 'convertFailed'; run: number; id: string; reason: 'unreadable' | 'timeout' }
  | { type: 'answered'; run: number; id: string; extraction: UnifiedExtractionResult; legacy: boolean; now: string } // legacy: legacyMatch said known
  | { type: 'sendFailed'; run: number; id: string; status: number; code: string | null } // status 0: no answer
  | { type: 'retry'; id: string | 'all' }
  | { type: 'stop' }
  | { type: 'chose'; id: string; change: ChoiceChange }
  | { type: 'saveStarted' }
  | { type: 'saved'; run: number; attempt: number; outcome: SaveOutcome }
  | { type: 'saveFailed'; run: number; attempt: number; message: string }
  | { type: 'close' }    // leaves only when nothing read would be lost
  | { type: 'discard' }; // leaves, dropping what was read

/** The platform runs each, then answers with the matching event. `forget`: drop the held bytes and pages. */
export type UploadEffect =
  | { type: 'list'; run: number; id: string }
  | { type: 'hash'; run: number; id: string }
  | { type: 'convert'; run: number; id: string }
  | { type: 'send'; run: number; id: string; attempt: number }
  | { type: 'abort'; run: number; ids: string[] }
  | { type: 'forget'; run: number; ids: string[] }
  | { type: 'save'; run: number; attempt: number };

export interface UploadStep { state: UploadState; effects: UploadEffect[] }

export function initialUpload(platform: UploadPlatform): UploadState {
  return { phase: 'choosing', platform, run: 0 };
}

// --- derived ----------------------------------------------------------------

const IN_FLIGHT: readonly FileStage[] = ['waiting', 'hashed', 'converting', 'ready', 'sending'];

/** Files and ZIPs still being read: Save waits for these, and only these (a failed file never blocks it). */
export function inFlight(s: UploadState): number {
  if (s.phase !== 'open') return 0;
  return idsIn(s.files, IN_FLIGHT).length + s.zips.length;
}
/** Nothing is still being read. The view also asks the save plan that something would be written (design §1). */
export function saveEnabled(s: UploadState): boolean {
  return s.phase === 'open' && inFlight(s) === 0;
}

// --- transition -------------------------------------------------------------

const same = (state: UploadState): UploadStep => ({ state, effects: [] });
const NO_CHOICES: FileChoices = { ticks: {}, testDay: null, document: {} };
const idsIn = (files: UploadFile[], stages: readonly FileStage[]) => files.filter((f) => stages.includes(f.status.s)).map((f) => f.id);
const forget = (run: number, ids: string[]): UploadEffect[] => (ids.length ? [{ type: 'forget', run, ids }] : []);
const abort = (run: number, ids: string[]): UploadEffect[] => (ids.length ? [{ type: 'abort', run, ids }] : []);
const pickOf = ({ platform, run, files, started, firstRead }: Pick): Pick => ({ platform, run, files, started, firstRead });

/** Which failures Try again can mend: a busy or unreachable server, a convert that ran out of time. */
export const RETRYABLE: Record<FailReason, boolean> = {
  unreadable: false, timeout: true, busy: true, dailyLimit: false, declined: false, network: true, server: true, refused: false,
};

/** A 429 is busy only when its code says so; with no code it is the daily limit (upload-api.ts tooMany, US-12 AC9). */
export function failReason(status: number, code: string | null): FailReason {
  if (status === 429) return code === 'busy' ? 'busy' : 'dailyLimit';
  if (status === 0) return 'network';
  if (status === 422) return 'declined';
  return status >= 500 ? 'server' : 'refused';
}

/** Files entering a run, by upload-rules' verdicts: a kept ZIP waits to be listed; a hidden member is dropped. */
function admit(platform: UploadPlatform, picked: PickedFile[], zip?: string) {
  const files: UploadFile[] = [];
  const zips: PendingZip[] = [];
  const hidden: string[] = [];
  for (const p of picked) {
    const member = zip !== undefined ? zipMemberVerdict(p.name, platform) : 'keep';
    if (member === 'hidden') { hidden.push(p.id); continue; }
    const verdict = member === 'keep' ? fileVerdict({ name: p.name, bytes: p.bytes, kind: p.kind, platform }) : member;
    const base = { id: p.id, name: p.name, bytes: p.bytes, hash: null, pages: null, ...(zip !== undefined ? { zip } : {}) };
    if (verdict === 'keep' && p.kind === 'zip') zips.push({ id: p.id, name: p.name });
    else if (verdict === 'keep') files.push({ ...base, status: { s: 'waiting' } });
    else files.push({ ...base, status: { s: 'refused', verdict: verdict === 'tooLarge' ? 'tooLarge' : 'unsupported' } });
  }
  return { files, zips, hidden };
}

/** New files start: ZIPs listed, the rest hashed before anything else (R3); refused and hidden ones dropped. */
function opening(run: number, files: UploadFile[], zips: PendingZip[], hidden: string[] = []): UploadEffect[] {
  return [
    ...zips.map((z): UploadEffect => ({ type: 'list', run, id: z.id })),
    ...idsIn(files, ['waiting']).map((id): UploadEffect => ({ type: 'hash', run, id })),
    ...forget(run, [...idsIn(files, ['refused']), ...hidden]),
  ];
}

/** Starts converts and sends while fewer than the platform's counts are under way (design §1). */
function pump(s: Open, effects: UploadEffect[]): UploadStep {
  const limits = UPLOAD_LIMITS[s.platform];
  let converting = idsIn(s.files, ['converting']).length; // a 20-file pick: rescans cost nothing
  let sending = idsIn(s.files, ['sending']).length;
  const out = [...effects];
  const files = s.files.map((f): UploadFile => {
    if (f.status.s === 'hashed' && converting < limits.convertsInFlight) {
      converting++;
      out.push({ type: 'convert', run: s.run, id: f.id });
      return { ...f, status: { s: 'converting' } };
    }
    if (f.status.s === 'ready' && sending < limits.sendsInFlight) {
      sending++;
      out.push({ type: 'send', run: s.run, id: f.id, attempt: f.status.attempt });
      return { ...f, status: { s: 'sending', attempt: f.status.attempt } };
    }
    return f;
  });
  return { state: { ...s, files }, effects: out };
}

/** A landing for one file: only in the open phase, for its run, while the file is at `from`. */
function fileStep(s: UploadState, e: { run: number; id: string }, from: FileStage, update: (f: UploadFile, s: Open) => [UploadFile, UploadEffect[]]): UploadStep {
  if (s.phase !== 'open' || e.run !== s.run) return same(s);
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

/** Stop or Cancel (AC28): every send in flight aborted, nothing more started, files already read kept. */
function stop(s: Open): UploadStep {
  const halted = idsIn(s.files, IN_FLIGHT);
  if (!halted.length && !s.zips.length) return same(s);
  const sending = idsIn(s.files, ['sending']);
  const files = s.files.map((f): UploadFile => (IN_FLIGHT.includes(f.status.s) ? { ...f, status: { s: 'stopped' } } : f));
  return { state: { ...s, files, zips: [] }, effects: [...abort(s.run, sending), ...forget(s.run, [...halted, ...s.zips.map((z) => z.id)])] };
}

/** Back to choosing: aborts what is sending and drops every held file. */
function leave(s: Exclude<UploadState, { phase: 'choosing' }>): UploadStep {
  const choosing: UploadState = { phase: 'choosing', platform: s.platform, run: s.run };
  if (s.phase === 'failed' || s.phase === 'done') return same(choosing); // both already dropped everything
  const sending = idsIn(s.files, ['sending']);
  const zips = 'zips' in s ? s.zips.map((z) => z.id) : [];
  return { state: choosing, effects: [...abort(s.run, sending), ...forget(s.run, [...s.files.map((f) => f.id), ...zips])] };
}

function save(s: Pick, attempt: number): UploadStep {
  return { state: { ...pickOf(s), phase: 'saving', attempt }, effects: [{ type: 'save', run: s.run, attempt }] };
}

function choose(c: FileChoices, change: ChoiceChange): FileChoices {
  if ('tick' in change) return { ...c, ticks: { ...c.ticks, [change.tick]: change.on } };
  if ('testDay' in change) return { ...c, testDay: change.testDay };
  return { ...c, document: { ...c.document, ...change.document } };
}

export function transition(s: UploadState, e: UploadEvent): UploadStep {
  if ('run' in e && e.run !== s.run) return same(s); // an answer for an older run (US-12 AC5)
  switch (e.type) {
    case 'picked': {
      if (s.phase !== 'choosing' || !e.files.length) return same(s);
      const run = s.run + 1;
      const { files, zips, hidden } = admit(s.platform, e.files);
      const pick = { platform: s.platform, run, files, zips, started: e.now, firstRead: null };
      // Consent first: nothing runs, not even a hash, until the person agrees (AC13e).
      if (e.needsConsent) return same({ ...pick, phase: 'consent' });
      return { state: { ...pick, phase: 'open' }, effects: opening(run, files, zips, hidden) };
    }
    case 'consented':
      return s.phase === 'consent' ? { state: { ...s, phase: 'open' }, effects: opening(s.run, s.files, s.zips) } : same(s);
    case 'listed': {
      if (s.phase !== 'open') return same(s);
      const zip = s.zips.find((z) => z.id === e.zip);
      if (!zip) return same(s);
      const added = admit(s.platform, e.members.map((m) => ({ ...m, kind: 'file' })), zip.name);
      return {
        state: { ...s, files: [...s.files, ...added.files], zips: s.zips.filter((z) => z !== zip) },
        effects: opening(s.run, added.files, [], added.hidden),
      };
    }
    case 'pickFailed':
      return s.phase === 'open' ? { ...leave(s), state: { phase: 'failed', platform: s.platform, run: s.run, message: e.message } } : same(s);
    case 'hashed':
      return fileStep(s, e, 'waiting', (f) => {
        if (!e.known) return [{ ...f, hash: e.hash, status: { s: 'hashed' } }, []];
        // An archive-only file keeps its bytes: Save files the original behind the held row (design §2 a').
        const known: UploadFile = { ...f, hash: e.hash, status: { s: 'known', ...e.known } };
        return [known, e.known.archiveOnly ? [] : forget(e.run, [f.id])];
      });
    case 'converted':
      return fileStep(s, e, 'converting', (f) => [{ ...f, pages: { count: e.pages, truncated: e.truncated }, status: { s: 'ready', attempt: 1 } }, []]);
    case 'convertFailed':
      return fileStep(s, e, 'converting', (f) => [{ ...f, status: { s: 'failed', reason: e.reason, attempt: 0 } }, []]);
    case 'answered': return answered(s, e);
    case 'sendFailed':
      return fileStep(s, e, 'sending', (f) => [{ ...f, status: { s: 'failed', reason: failReason(e.status, e.code), attempt: f.status.s === 'sending' ? f.status.attempt : 0 } }, []]);
    case 'retry': {
      if (s.phase !== 'open') return same(s);
      if (!s.files.some((f) => f.status.s === 'failed' && RETRYABLE[f.status.reason] && (e.id === 'all' || f.id === e.id))) return same(s);
      // Pages still held after a failed send go straight back to a slot; a failed convert starts from the hashed bytes.
      const files = s.files.map((f): UploadFile => (f.status.s !== 'failed' || !RETRYABLE[f.status.reason] || (e.id !== 'all' && f.id !== e.id) ? f
        : { ...f, status: f.pages === null ? { s: 'hashed' } : { s: 'ready', attempt: f.status.attempt + 1 } }));
      return pump({ ...s, files }, []);
    }
    case 'stop': return s.phase === 'open' ? stop(s) : same(s);
    case 'chose': {
      if (s.phase !== 'open' || !s.files.some((f) => f.id === e.id && f.status.s === 'read')) return same(s);
      const files = s.files.map((f): UploadFile => (f.id === e.id && f.status.s === 'read' ? { ...f, status: { ...f.status, choices: choose(f.status.choices, e.change) } } : f));
      return same({ ...s, files });
    }
    case 'saveStarted':
      if (s.phase === 'saveFailed') return save(s, s.attempt + 1);
      return s.phase === 'open' && saveEnabled(s) ? save(s, 1) : same(s);
    case 'saved': {
      if (s.phase !== 'saving' || s.attempt !== e.attempt) return same(s);
      return { state: { ...pickOf(s), phase: 'done', outcome: e.outcome }, effects: forget(s.run, s.files.map((f) => f.id)) };
    }
    case 'saveFailed':
      return s.phase === 'saving' && s.attempt === e.attempt ? same({ ...s, phase: 'saveFailed', message: e.message }) : same(s);
    case 'close': {
      if (s.phase === 'choosing' || s.phase === 'saving' || s.phase === 'saveFailed') return same(s);
      if (s.phase === 'open' && s.files.some((f) => f.status.s === 'read')) return same(s); // discard, or save, first
      return leave(s);
    }
    case 'discard': return s.phase === 'choosing' || s.phase === 'saving' ? same(s) : leave(s);
  }
}
