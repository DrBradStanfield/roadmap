/**
 * The shared upload's state, events and effects as Zod schemas, for a caller that holds the state
 * as text and must check it where it re-enters (the iPhone's engine doors, ios/engine/upload-doors.ts;
 * design PR 12, US-52 AC8c). Pinned both ways to upload-flow.ts's hand-written types at compile time
 * (`pin` below): a phase, status, event or effect added to one and not the other fails `tsc`.
 * upload-flow.property.test.ts round-trips every state, event and effect it generates through them.
 *
 * A read's extraction is the server's answer, kept as it came: checked for what the engine reads of
 * it, never stripped, and typed as the engine's own `UnifiedExtractionResult`.
 */
import * as z from './zod';
import type { UnifiedExtractionResult } from './lab-extraction';
import { EXTRACTION_STOP_CODES } from './models';
import type { ChoiceChange, FileChoices } from './upload-choices';
import type { UploadFailure } from './upload-failure';
import type { UploadEffect, UploadEvent, UploadState } from './upload-flow';

const text = z.string();
const maybeText = z.string().nullable();
const count = z.number().int().nonnegative();
const platform = z.enum(['web', 'phone']);

const day = { recordedAt: text.optional(), printedMonth: text.optional() };
const EXTRACTION_CHECK = z.looseObject({
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
/** The server's read: what the engine reads of it is checked; the rest passes as sent. */
export const UPLOAD_EXTRACTION = z.custom<UnifiedExtractionResult>((v) => EXTRACTION_CHECK.safeParse(v).success);

const documentFix = z.object({ title: text.optional(), kind: text.optional(), date: maybeText.optional() });
const choices = z.object({
  ticks: z.record(z.string(), z.boolean()), testDay: maybeText, previousDay: maybeText,
  replace: z.record(z.string(), z.string()), edits: z.record(z.string(), z.number()), document: documentFix,
});
const failReason = z.enum(['unreadable', 'bytesUnreadable', 'zipUnreadable', 'zipEmpty', 'timeout', 'busy', 'dailyLimit', 'declined', 'tooLong', 'server', 'network']);
const status = z.discriminatedUnion('s', [
  z.object({ s: z.literal('listing') }),
  z.object({ s: z.literal('waiting') }),
  z.object({ s: z.literal('hashing') }),
  z.object({ s: z.literal('hashed') }),
  z.object({ s: z.literal('known'), as: z.enum(['document', 'labReport', 'legacy']), archiveOnly: z.boolean() }),
  z.object({ s: z.literal('refused'), verdict: z.enum(['tooLarge', 'unsupported']) }),
  z.object({ s: z.literal('converting') }),
  z.object({ s: z.literal('ready'), attempt: count }),
  z.object({ s: z.literal('sending'), attempt: count }),
  z.object({ s: z.literal('read'), extraction: UPLOAD_EXTRACTION, choices }),
  z.object({ s: z.literal('failed'), reason: failReason, attempt: count }),
  z.object({ s: z.literal('stopped') }),
]);
const file = z.object({
  id: text, name: text, zip: text.optional(), bytes: z.number(), hash: maybeText,
  pages: z.object({ count, truncated: z.boolean() }).nullable(), status,
});
const pick = { platform, run: count, files: z.array(file), started: text, firstRead: maybeText };
const outcome = z.object({ values: count, documents: count, archived: count });

export const UPLOAD_STATE = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('choosing'), platform, run: count }),
  z.object({ phase: z.literal('consent'), ...pick }),
  z.object({ phase: z.literal('open'), ...pick }),
  z.object({ phase: z.literal('saving'), ...pick, attempt: count }),
  z.object({ phase: z.literal('saveFailed'), ...pick, attempt: count, message: text }),
  z.object({ phase: z.literal('done'), ...pick, outcome }),
  z.object({ phase: z.literal('failed'), ...pick }),
]);

const change = z.union([
  z.object({ tick: text, on: z.boolean() }),
  z.object({ testDay: maybeText }),
  z.object({ previousDay: maybeText }),
  z.object({ replace: text, correctsId: maybeText }),
  z.object({ edit: text, value: z.number().nullable() }),
  z.object({ document: documentFix }),
]);
const failure = z.enum(['rate_limit', 'busy', 'server_error', 'network', ...EXTRACTION_STOP_CODES]);

/** Each event by its type, for a caller that sends some of them in a shape of its own (the doors' wire). */
export const UPLOAD_EVENTS = {
  picked: z.object({ type: z.literal('picked'), files: z.array(z.object({ id: text, name: text, bytes: z.number(), kind: z.enum(['file', 'zip']) })), needsConsent: z.boolean(), now: text }),
  consented: z.object({ type: z.literal('consented') }),
  listed: z.object({ type: z.literal('listed'), run: count, zip: text, members: z.array(z.object({ id: text, name: text, bytes: z.number() })) }),
  zipFailed: z.object({ type: z.literal('zipFailed'), run: count, zip: text }),
  hashed: z.object({ type: z.literal('hashed'), run: count, id: text, hash: text, known: z.object({ as: z.enum(['document', 'labReport']), archiveOnly: z.boolean() }).nullable() }),
  hashFailed: z.object({ type: z.literal('hashFailed'), run: count, id: text }),
  converted: z.object({ type: z.literal('converted'), run: count, id: text, pages: count, truncated: z.boolean() }),
  convertFailed: z.object({ type: z.literal('convertFailed'), run: count, id: text, reason: z.enum(['unreadable', 'timeout']) }),
  answered: z.object({ type: z.literal('answered'), run: count, id: text, extraction: UPLOAD_EXTRACTION, legacy: z.boolean(), now: text }),
  sendFailed: z.object({ type: z.literal('sendFailed'), run: count, id: text, failure }),
  retry: z.object({ type: z.literal('retry'), id: text }),
  stop: z.object({ type: z.literal('stop') }),
  chose: z.object({ type: z.literal('chose'), id: text, change, now: text }),
  saveStarted: z.object({ type: z.literal('saveStarted') }),
  saved: z.object({ type: z.literal('saved'), run: count, attempt: count, outcome }),
  saveFailed: z.object({ type: z.literal('saveFailed'), run: count, attempt: count, message: text }),
  close: z.object({ type: z.literal('close') }),
  discard: z.object({ type: z.literal('discard') }),
};
const E = UPLOAD_EVENTS;
export const UPLOAD_EVENT = z.discriminatedUnion('type', [
  E.picked, E.consented, E.listed, E.zipFailed, E.hashed, E.hashFailed, E.converted, E.convertFailed, E.answered,
  E.sendFailed, E.retry, E.stop, E.chose, E.saveStarted, E.saved, E.saveFailed, E.close, E.discard,
]);

const ids = z.array(text);
export const UPLOAD_EFFECT = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list'), run: count, id: text }),
  z.object({ type: z.literal('hash'), run: count, id: text }),
  z.object({ type: z.literal('convert'), run: count, id: text }),
  z.object({ type: z.literal('send'), run: count, id: text, attempt: count, flags: z.object({ ownDates: z.boolean(), undatedPrev: z.boolean(), refusedRows: z.boolean() }) }),
  z.object({ type: z.literal('abort'), run: count, ids }),
  z.object({ type: z.literal('forget'), run: count, ids }),
  z.object({ type: z.literal('save'), run: count, attempt: count }),
]);

// The pin: each schema's type and the hand-written one are assignable both ways, or `tsc` fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pin = <T extends true>(): T => true as T;
pin<Same<z.infer<typeof UPLOAD_STATE>, UploadState>>();
pin<Same<z.infer<typeof UPLOAD_EVENT>, UploadEvent>>();
pin<Same<z.infer<typeof UPLOAD_EFFECT>, UploadEffect>>();
pin<Same<z.infer<typeof change>, ChoiceChange>>();
pin<Same<z.infer<typeof choices>, FileChoices>>();
pin<Same<z.infer<typeof failure>, UploadFailure>>();
