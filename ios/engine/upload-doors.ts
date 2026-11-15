// The shared upload's doors for the iPhone app (design PR 12, US-52 AC8c): health-core's upload
// engine (upload-flow, upload-known, upload-review, upload-view, upload-plan, upload-usage,
// upload-failure) as JSON in and out, so Swift holds the state as opaque text and computes no
// rule. Every input is checked here once, where it enters; a malformed one answers a refusal,
// never a throw. Nothing is logged: the state holds file names, hashes and read values.
import { initialUpload, transition, type UploadEvent, type UploadState } from '../../packages/health-core/src/upload-flow';
import { knownAs, knownIndex, readIsLegacy, type KnownIndex } from '../../packages/health-core/src/upload-known';
import { uploadFailureOfText } from '../../packages/health-core/src/upload-failure';
import { uploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadUsageCounts } from '../../packages/health-core/src/upload-usage';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import * as z from '../../packages/health-core/src/zod';
import { readRecord } from './my-data';

/** Why a door would not answer. Its words never carry what it was given. */
export type UploadRefusal = { ok: false; reason: 'invalid-platform' | 'invalid-state' | 'invalid-event' | 'invalid-record' | 'engine-error'; message: string };
const REFUSAL_WORDS: Record<UploadRefusal['reason'], string> = {
  'invalid-platform': 'The upload was started for an unknown device.',
  'invalid-state': 'The upload could not be read.',
  'invalid-event': 'The upload step could not be read.',
  'invalid-record': 'Your record could not be read.',
  'engine-error': 'The upload could not go on.',
};
class Refused extends Error {
  constructor(readonly reason: UploadRefusal['reason']) { super(reason); }
}

// --- Wire shapes. Checked, then the parsed JSON itself goes on, so nothing is stripped and the
// door answers exactly as health-core does for the same value. --------------------------------

const text = z.string();
const maybeText = z.string().nullable();
const count = z.number().int().nonnegative();
const platform = z.enum(['web', 'phone']);

// The read, as the server answered it: what the engine reads of it, typed; the rest kept as sent.
const day = { recordedAt: text.optional(), printedMonth: text.optional() };
const extraction = z.looseObject({
  classification: text,
  reportDate: maybeText.optional(),
  values: z.array(z.looseObject({ metric: text, valueSI: z.number(), displayValue: z.number(), displayUnit: text, displaySystem: text, confidence: text, question: text.optional(), ...day })).optional(),
  additionalValues: z.array(z.looseObject({ name: text, value: z.number(), unit: text, question: text.optional(), ...day })).optional(),
  unrecognized: z.array(text).optional(),
  document: z.looseObject({ classification: text, title: text, documentDate: maybeText.optional(), contentMarkdown: text.optional(), metadata: z.record(z.string(), z.unknown()).optional() }).nullable().optional(),
  droppedValueCount: z.number().optional(),
  unreadValues: z.array(z.looseObject({ name: text, reason: text, recordedAt: text.optional() })).optional(),
  refusedValues: z.array(z.looseObject({ metric: text, value: z.number(), unit: text, reason: text, ...day })).optional(),
});
const documentFix = z.object({ title: text.optional(), kind: text.optional(), date: maybeText.optional() });
const choices = z.object({
  ticks: z.record(z.string(), z.boolean()), testDay: maybeText, previousDay: maybeText,
  replace: z.record(z.string(), z.string()), edits: z.record(z.string(), z.number()), document: documentFix,
});
const failReason = z.enum(['unreadable', 'bytesUnreadable', 'zipUnreadable', 'zipEmpty', 'timeout', 'busy', 'dailyLimit', 'declined', 'tooLong', 'server', 'network']);
const status = z.discriminatedUnion('s', [
  z.object({ s: z.enum(['listing', 'waiting', 'hashing', 'hashed', 'converting', 'stopped']) }),
  z.object({ s: z.literal('known'), as: z.enum(['document', 'labReport', 'legacy']), archiveOnly: z.boolean() }),
  z.object({ s: z.literal('refused'), verdict: z.enum(['tooLarge', 'unsupported']) }),
  z.object({ s: z.enum(['ready', 'sending']), attempt: count }),
  z.object({ s: z.literal('read'), extraction, choices }),
  z.object({ s: z.literal('failed'), reason: failReason, attempt: count }),
]);
const file = z.object({
  id: text, name: text, zip: text.optional(), bytes: z.number(), hash: maybeText,
  pages: z.object({ count, truncated: z.boolean() }).nullable(), status,
});
const pick = { platform, run: count, files: z.array(file), started: text, firstRead: maybeText };
const outcome = z.object({ values: count, documents: count, archived: count });
const STATE = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('choosing'), platform, run: count }),
  z.object({ phase: z.enum(['consent', 'open', 'failed']), ...pick }),
  z.object({ phase: z.literal('saving'), ...pick, attempt: count }),
  z.object({ phase: z.literal('saveFailed'), ...pick, attempt: count, message: text }),
  z.object({ phase: z.literal('done'), ...pick, outcome }),
]);

const change = z.union([
  z.object({ tick: text, on: z.boolean() }),
  z.object({ testDay: maybeText }),
  z.object({ previousDay: maybeText }),
  z.object({ replace: text, correctsId: maybeText }),
  z.object({ edit: text, value: z.number().nullable() }),
  z.object({ document: documentFix }),
]);
/**
 * The events Swift sends: health-core's, less what only the engine knows. `hashed` carries no
 * `known`, `answered` no `legacy`; `sendFailed` carries the server's answer as it came (`status`
 * null when none came; `body` its text, null when it had none; `contentType` its header) for
 * `uploadFailure` to read, never a failure code. Anything Swift adds in their place is overwritten.
 */
const EVENT = z.discriminatedUnion('type', [
  z.object({ type: z.literal('picked'), files: z.array(z.object({ id: text, name: text, bytes: z.number(), kind: z.enum(['file', 'zip']) })), needsConsent: z.boolean(), now: text }),
  z.object({ type: z.enum(['consented', 'stop', 'saveStarted', 'close', 'discard']) }),
  z.object({ type: z.literal('listed'), run: count, zip: text, members: z.array(z.object({ id: text, name: text, bytes: z.number() })) }),
  z.object({ type: z.literal('zipFailed'), run: count, zip: text }),
  z.object({ type: z.literal('hashed'), run: count, id: text, hash: text }),
  z.object({ type: z.literal('hashFailed'), run: count, id: text }),
  z.object({ type: z.literal('converted'), run: count, id: text, pages: count, truncated: z.boolean() }),
  z.object({ type: z.literal('convertFailed'), run: count, id: text, reason: z.enum(['unreadable', 'timeout']) }),
  z.object({ type: z.literal('answered'), run: count, id: text, extraction, now: text }),
  z.object({ type: z.literal('sendFailed'), run: count, id: text, status: z.number().int().nullable(), body: maybeText, contentType: maybeText }),
  z.object({ type: z.literal('retry'), id: text }),
  z.object({ type: z.literal('chose'), id: text, change, now: text }),
  z.object({ type: z.literal('saved'), run: count, attempt: count, outcome }),
  z.object({ type: z.literal('saveFailed'), run: count, attempt: count, message: text }),
]);

// --- Reading ----------------------------------------------------------------------------------

function parsed<T>(json: string, schema: z.ZodType, reason: UploadRefusal['reason']): T {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Refused(reason); }
  if (!schema.safeParse(raw).success) throw new Refused(reason);
  return raw as T;
}
const readState = (json: string) => parsed<UploadState>(json, STATE, 'invalid-state');

/** The record as the save writes it (read raw); '' is a record with nothing in it yet. Read-only here. */
function readUploadRecord(json: string, now: string): RoadmapFile {
  if (json === '') return createEmptyFile({ deviceId: 'upload', now });
  try { return readRecord(json, now, 'upload'); } catch { throw new Refused('invalid-record'); }
}

/** One index per record read: `readRecord` hands back the same object for the same text. */
const indexes = new WeakMap<RoadmapFile, KnownIndex>();
function indexOf(record: RoadmapFile): KnownIndex {
  let index = indexes.get(record);
  if (!index) indexes.set(record, (index = knownIndex(record)));
  return index;
}

/** The wire event made whole with what only the engine knows (health-core's own rules). */
function engineEvent(state: UploadState, wire: z.infer<typeof EVENT>, record: () => RoadmapFile): UploadEvent {
  switch (wire.type) {
    case 'hashed': return { ...wire, known: knownAs(indexOf(record()), wire.hash) };
    case 'answered': {
      const name = 'files' in state ? state.files.find((f) => f.id === wire.id)?.name : undefined;
      return { ...wire, legacy: name !== undefined && readIsLegacy(record(), name, wire.extraction as Parameters<typeof readIsLegacy>[2]) } as UploadEvent;
    }
    case 'sendFailed': {
      const { status, body, contentType, ...rest } = wire;
      return { ...rest, failure: uploadFailureOfText(status, body, contentType) };
    }
    default: return wire as UploadEvent;
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

/** The record is read only for an event that needs it (`hashed`, `answered`). */
export const uploadStep = (stateJson: string, eventJson: string, recordJson: string) => answer(() => {
  const state = readState(stateJson);
  const wire = parsed<z.infer<typeof EVENT>>(eventJson, EVENT, 'invalid-event');
  // No answer here reads a time from the record: known and legacy go by hash, name and date.
  return transition(state, engineEvent(state, wire, () => readUploadRecord(recordJson, new Date(0).toISOString())));
});

/** One review per call, as health-core's callers take it: the view and its plan count the same rows. */
const reviewed = (make: typeof uploadView | typeof uploadSavePlan) => (stateJson: string, recordJson: string, nowIso: string, cloudConnected: boolean) => answer(() => {
  const state = readState(stateJson);
  const record = readUploadRecord(recordJson, nowIso);
  return make(state, record, nowIso, uploadReview(state, record, nowIso), cloudConnected);
});
export const uploadViewOf = reviewed(uploadView);
export const uploadPlanOf = reviewed(uploadSavePlan);

export const uploadUsage = (stateJson: string) => answer(() => uploadUsageCounts(readState(stateJson)));
