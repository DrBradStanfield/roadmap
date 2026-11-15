// The shared upload's doors for the iPhone app (design PR 12, US-52 AC8c): health-core's upload
// engine (upload-flow, upload-known, upload-review, upload-view, upload-plan, upload-usage,
// upload-answer) as JSON in and out, so Swift holds the state as opaque text and computes no
// rule. Every input is checked once, where it enters, by health-core's strict schemas
// (upload-schema.ts), and the PARSED value is what runs. A malformed input answers a refusal,
// never a throw. Nothing is logged: the state holds file names, hashes and read values.
import { initialUpload, transition, type UploadEvent, type UploadState } from '../../packages/health-core/src/upload-flow';
import { UPLOAD_EVENTS, UPLOAD_STATE } from '../../packages/health-core/src/upload-schema';
import { knownAs, knownIndex, readIsLegacy, type KnownIndex } from '../../packages/health-core/src/upload-known';
import { uploadFailureOfText } from '../../packages/health-core/src/upload-failure';
import { labStreamAnswer } from '../../packages/health-core/src/upload-answer';
import { uploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadUsageCounts } from '../../packages/health-core/src/upload-usage';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import * as z from '../../packages/health-core/src/zod';
import { readRecord, Refusal, TOO_NEW_RECORD } from './my-data';

/** Why a door would not answer, each with its words; the words never carry what it was given. */
const REFUSAL_WORDS = {
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
class Refused extends Error {
  constructor(readonly reason: UploadRefusalReason) { super(reason); }
}

// --- The wire -------------------------------------------------------------------------------

const platform = z.enum(['web', 'phone']);
const maybeText = z.string().nullable();
const E = UPLOAD_EVENTS;
/**
 * The events Swift sends (entry.ts uploadStepJson lists them): health-core's, less what only the
 * engine knows, plus `streamEnded`, the streaming lab route's end. Strict, as health-core's are: a
 * key the event does not name is refused, so `known`, `legacy` or `failure` from the app never runs.
 */
const WIRE_EVENT = z.discriminatedUnion('type', [
  E.picked, E.consented, E.listed, E.zipFailed, E.hashed.omit({ known: true }), E.hashFailed, E.converted, E.convertFailed,
  E.answered.omit({ legacy: true }),
  E.sendFailed.omit({ failure: true }).extend({ status: z.number().int().nullable(), body: maybeText, contentType: maybeText }),
  z.strictObject({ type: z.literal('streamEnded'), run: z.number().int().nonnegative(), id: z.string(), line: maybeText, now: z.string() }),
  E.retry, E.stop, E.chose, E.saveStarted, E.saved, E.saveFailed, E.close, E.discard,
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
const readState = (json: string): UploadState => parsed(json, UPLOAD_STATE, 'invalid-state');

/** The record as the save writes it (read raw), through the app's own deviceId, so the screen doors'
 *  cached read is shared, not emptied; '' is a record with nothing in it yet. Read-only here. */
function readUploadRecord(json: string, now: string, deviceId: string): RoadmapFile {
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
    const name = 'files' in state ? state.files.find((f) => f.id === id)?.name : undefined;
    return name !== undefined && readIsLegacy(record(), name, extraction);
  };
  switch (wire.type) {
    case 'hashed': return { ...wire, known: knownAs(indexOf(record()), wire.hash) };
    case 'answered': return { ...wire, legacy: legacy(wire.id, wire.extraction) };
    case 'sendFailed': {
      const { status, body, contentType, ...rest } = wire;
      return { ...rest, failure: uploadFailureOfText(status, body, contentType) };
    }
    case 'streamEnded': {
      const { run, id, line, now } = wire;
      const answer = labStreamAnswer(line);
      return 'extraction' in answer
        ? { type: 'answered', run, id, extraction: answer.extraction, legacy: legacy(id, answer.extraction), now }
        : { type: 'sendFailed', run, id, failure: answer.failure };
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

/** The record is read only for an event that needs it (`hashed`, `answered`, `streamEnded`). */
export const uploadStep = (stateJson: string, eventJson: string, recordJson: string, deviceId: string) => answer(() => {
  const state = readState(stateJson);
  const wire = parsed(eventJson, WIRE_EVENT, 'invalid-event');
  // Known and legacy go by hash, name and date, never a time; the clock only stamps a record the
  // read migrates, which readRecord then keeps for the screen doors, so it is the real one.
  return transition(state, engineEvent(state, wire, () => readUploadRecord(recordJson, new Date().toISOString(), deviceId)));
});

/** One review per call, as health-core's callers take it: the view and its plan count the same rows. */
const reviewed = (make: typeof uploadView | typeof uploadSavePlan) => (stateJson: string, recordJson: string, nowIso: string, cloudConnected: boolean, deviceId: string) => answer(() => {
  const state = readState(stateJson);
  const record = readUploadRecord(recordJson, nowIso, deviceId);
  return make(state, record, nowIso, uploadReview(state, record, nowIso), cloudConnected);
});
export const uploadViewOf = reviewed(uploadView);
export const uploadPlanOf = reviewed(uploadSavePlan);

export const uploadUsage = (stateJson: string) => answer(() => uploadUsageCounts(readState(stateJson)));
