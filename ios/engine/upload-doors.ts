// The shared upload's doors for the iPhone app (design PR 12, US-52 AC8c): health-core's upload
// engine (upload-flow, upload-known, upload-review, upload-view, upload-plan, upload-usage,
// upload-answer) as JSON in and out, so Swift holds the state as opaque text and computes no
// rule. Every input is checked once, where it enters, by health-core's strict schemas
// (upload-schema.ts), and the PARSED value is what runs. A malformed input answers a refusal,
// never a throw. Nothing is logged: the state holds file names, hashes and read values.
import { initialUpload, transition, uploadFileName, type UploadEvent, type UploadState } from '../../packages/health-core/src/upload-flow';
import { ATTEST_PART, maybeText, NETWORK_FAILURE, PHONE_CHANGE, platform, UPLOAD_EVENTS, UPLOAD_STATE } from '../../packages/health-core/src/upload-schema';
import { knownAs, knownIndex, readIsLegacy, type KnownIndex } from '../../packages/health-core/src/upload-known';
import { appGateFailure, boundedWords, type FailDetail, type UploadFailure } from '../../packages/health-core/src/upload-failure';
import { PHONE_FAIL_TEXT } from '../../packages/health-core/src/upload-text';
import { labStreamAnswer } from '../../packages/health-core/src/upload-answer';
import { choosesReplace, dropLostReplaces, uploadReview, type UploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadUsageCounts } from '../../packages/health-core/src/upload-usage';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import * as z from '../../packages/health-core/src/zod';
import { readRecord, Refusal, TOO_NEW_RECORD } from './my-data';

/** Why a door would not answer, each with its words; the words never carry what it was given. */
export const REFUSAL_WORDS = {
  'invalid-platform': 'The upload was started for an unknown device.',
  'invalid-state': 'The upload could not be read.',
  'invalid-event': 'The upload step could not be read.',
  'invalid-record': 'Your record could not be read.',
  'record-too-new': TOO_NEW_RECORD,
  'engine-error': 'The upload could not go on.',
} as const;
export type UploadRefusalReason = keyof typeof REFUSAL_WORDS;
export const UPLOAD_REFUSAL_REASONS = Object.keys(REFUSAL_WORDS) as UploadRefusalReason[];
export type UploadRefusal = { ok: false; reason: UploadRefusalReason; message: string };
export class Refused extends Error {
  constructor(readonly reason: UploadRefusalReason) { super(reason); }
}

// --- The wire -------------------------------------------------------------------------------

/**
 * A send with no lab-read answer, as the phone saw it (US-52 AC7e): the phone could not prove the
 * app, its App Attest registration was refused (`refused`, with the status and the words today's
 * iPhone shows), an answer it could not read, or how the request failed on the way (its kind).
 */
const LOCAL = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cannotAttest') }),
  z.strictObject({ kind: z.literal('attestFailed'), stage: ATTEST_PART, code: ATTEST_PART }),
  // The words are cut by the engine (boundedWords), never a reason to refuse the event.
  z.strictObject({ kind: z.literal('refused'), status: z.number().int().min(100).max(599), message: z.string() }),
  z.strictObject({ kind: z.literal('badAnswer') }),
  z.strictObject({ kind: NETWORK_FAILURE }),
]);

/**
 * The phone's own outcome as the failure: a refused registration under 500 (a 429 included: the
 * registration's limit, not the upload's day) is app_refused, which Try again never mends, so taps
 * cannot spend registrations; from 500 the server's failure, which it mends; each with its words.
 */
function localFailure(local: z.infer<typeof LOCAL>): { failure: UploadFailure; detail?: FailDetail } {
  switch (local.kind) {
    case 'cannotAttest': return { failure: 'cannot_attest' };
    case 'attestFailed': return { failure: 'attest_failed', detail: { stage: local.stage, code: local.code } };
    case 'badAnswer': return { failure: 'app_refused', detail: { message: PHONE_FAIL_TEXT.badAnswer } };
    case 'refused': {
      const message = boundedWords(local.message);
      const failure = local.status < 500 ? 'app_refused' : 'server_error';
      return message ? { failure, detail: { message } } : { failure };
    }
    default: return { failure: 'network', detail: { network: local.kind } };
  }
}
const E = UPLOAD_EVENTS;
/**
 * The events Swift sends (entry.ts uploadStepJson lists them): health-core's, less what only the
 * engine knows, plus `streamEnded`, the streaming lab route's end. Strict, as health-core's are: a
 * key the event does not name is refused, so `known`, `legacy` or `failure` from the app never runs.
 */
const WIRE_EVENT = z.discriminatedUnion('type', [
  E.picked, E.consented, E.listed, E.zipFailed, E.hashed.omit({ known: true }), E.hashFailed, E.converted, E.convertFailed,
  E.answered.omit({ legacy: true }),
  E.sendFailed.omit({ failure: true, detail: true }).extend({ status: z.number().int().nullable(), body: maybeText, contentType: maybeText, local: LOCAL.optional() }),
  z.strictObject({ type: z.literal('streamEnded'), run: z.number().int().nonnegative(), id: z.string(), line: maybeText, now: z.string() }),
  // Only the changes the iPhone's page makes: the web's column day is refused here (US-13 AC24).
  E.retry, E.stop, E.chose.extend({ change: PHONE_CHANGE }), E.saveStarted, E.saved, E.saveFailed, E.close, E.discard,
]);
type Wire = z.infer<typeof WIRE_EVENT>;

// --- Reading ----------------------------------------------------------------------------------

/** The input as its schema parsed it: what runs is what was checked. */
function parsed<S extends z.ZodType>(json: string, schema: S, reason: UploadRefusalReason): z.infer<S> {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Refused(reason); }
  const read = schema.safeParse(raw);
  if (!read.success) throw new Refused(reason);
  return read.data;
}
/** No state at the phone's doors holds the web's column day (US-13 AC24), a row's held text (AC12) or an edit's typed unit,
 *  whatever platform it claims: no step, view, plan or Save door runs one. */
const PHONE_STATE = UPLOAD_STATE.refine((s) => !('files' in s)
  || s.files.every((f) => f.status.s !== 'read' || (f.status.choices.columnDays === undefined && f.status.choices.typed === undefined && f.status.choices.editUnits === undefined)));
export const readState = (json: string): UploadState => parsed(json, PHONE_STATE, 'invalid-state');

/** The record as the save writes it (read raw), through the app's own deviceId, so the screen doors'
 *  cached read is shared, not emptied; '' is a record with nothing in it yet. Read-only here. */
export function readUploadRecord(json: string, now: string, deviceId: string): RoadmapFile {
  if (json === '') return createEmptyFile({ deviceId, now });
  try {
    return readRecord(json, now, deviceId);
  } catch (error) {
    throw new Refused(error instanceof Refusal && error.message === TOO_NEW_RECORD ? 'record-too-new' : 'invalid-record');
  }
}

/** One index per record read: `readRecord` hands back the same object for the same text. */
const indexes = new WeakMap<RoadmapFile, KnownIndex>();
function indexOf(record: RoadmapFile): KnownIndex {
  let index = indexes.get(record);
  if (!index) indexes.set(record, (index = knownIndex(record)));
  return index;
}

/** The wire event made whole with what only the engine knows (health-core's own rules). */
function engineEvent(state: UploadState, wire: Wire, record: () => RoadmapFile): UploadEvent {
  const legacy = (id: string, extraction: Extract<UploadEvent, { type: 'answered' }>['extraction']) => {
    const file = 'files' in state ? state.files.find((f) => f.id === id) : undefined;
    return file !== undefined && readIsLegacy(record(), uploadFileName(file), extraction);
  };
  switch (wire.type) {
    case 'hashed': return { ...wire, known: knownAs(indexOf(record()), wire.hash) };
    case 'answered': return { ...wire, legacy: legacy(wire.id, wire.extraction) };
    case 'sendFailed': {
      const { status, body, contentType, local, ...rest } = wire;
      // The phone's own outcome, when there is one, is the failure: status and body are not read.
      return { ...rest, ...(local ? localFailure(local) : appGateFailure(status, body, contentType)) };
    }
    case 'streamEnded': {
      const { run, id, line, now } = wire;
      const answer = labStreamAnswer(line);
      return 'extraction' in answer
        ? { type: 'answered', run, id, extraction: answer.extraction, legacy: legacy(id, answer.extraction), now }
        : { type: 'sendFailed', run, id, failure: answer.failure, ...(answer.detail ? { detail: answer.detail } : {}) };
    }
    default: return wire;
  }
}

/** Runs one door: its answer as JSON, or its refusal. Never throws, never logs. */
function answer(work: () => unknown): string {
  try {
    return JSON.stringify(work());
  } catch (error) {
    const reason = error instanceof Refused ? error.reason : 'engine-error';
    const refusal: UploadRefusal = { ok: false, reason, message: REFUSAL_WORDS[reason] };
    return JSON.stringify(refusal);
  }
}

// --- The doors (entry.ts exports them, with the contract's argument check) ---------------------

export const uploadStart = (platformName: string) => answer(() => {
  const read = platform.safeParse(platformName);
  if (!read.success) throw new Refused('invalid-platform');
  return initialUpload(read.data);
});

/** The record is read only for an event that needs it (`hashed`, `answered`, `streamEnded`), and while a Replace is chosen. */
export const uploadStep = (stateJson: string, eventJson: string, recordJson: string, deviceId: string) => answer(() => {
  const state = readState(stateJson);
  const wire = parsed(eventJson, WIRE_EVENT, 'invalid-event');
  // Known and legacy go by hash, name and date, never a time; the clock only stamps a record the
  // read migrates, which readRecord then keeps for the screen doors, so it is the real one.
  const now = new Date().toISOString();
  const record = () => readUploadRecord(recordJson, now, deviceId);
  const { state: current } = withoutLostReplaces(state, recordJson, record, now);
  return transition(current, engineEvent(current, wire, record));
});

/**
 * A chosen Replace whose target another writer moved, corrected or deleted on this record is dropped and its
 * value unticked (health-core `dropLostReplaces`, owner ruling 2026-11-20, US-13 AC21), before the next event and
 * in every view, so the page shows an ordinary value to tick again. The record is read only when a Replace is chosen.
 * `review`: the review it judged by, when nothing was dropped, so a view reviews that state once.
 */
function withoutLostReplaces(state: UploadState, recordJson: string, record: () => RoadmapFile, now: string): { state: UploadState; review?: UploadReview } {
  // No record to judge by ('' while the app has none it can read) or one that will not read drops nothing (adversary R1):
  // every Replace stands, and the next record that reads is judged.
  if (recordJson === '' || !choosesReplace(state)) return { state };
  let read: RoadmapFile;
  try { read = record(); } catch { return { state }; }
  return dropLostReplaces(state, read, now);
}

/** One review per call, as health-core's callers take it: the view and its plan count the same rows. */
const reviewed = <T,>(make: (state: UploadState, record: RoadmapFile, nowIso: string, review: UploadReview, cloudConnected: boolean) => T) =>
  (stateJson: string, recordJson: string, nowIso: string, cloudConnected: boolean, deviceId: string) => answer(() => {
    const record = readUploadRecord(recordJson, nowIso, deviceId);
    const { state, review } = withoutLostReplaces(readState(stateJson), recordJson, () => record, nowIso);
    return make(state, record, nowIso, review ?? uploadReview(state, record, nowIso), cloudConnected);
  });
/** The view, with the words the app shows when a later engine call gives no answer at all
 *  (`engineError`, the doors' own engine-error line): the page keeps them from its last view. */
export const uploadViewOf = reviewed((...args: Parameters<typeof uploadView>) => ({ ...uploadView(...args), engineError: REFUSAL_WORDS['engine-error'] }));
export const uploadPlanOf = reviewed(uploadSavePlan);

export const uploadUsage = (stateJson: string) => answer(() => uploadUsageCounts(readState(stateJson)));
