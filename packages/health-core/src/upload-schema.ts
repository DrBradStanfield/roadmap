/**
 * The shared upload's state, events and effects as Zod schemas, for a caller that holds the state
 * as text and must check it where it re-enters (the iPhone's engine doors, ios/engine/upload-doors.ts;
 * design PR 12, US-52 AC8c). Pinned both ways to upload-flow.ts's hand-written types at compile time
 * (`pin` below): a phase, status, event or effect added to one and not the other fails `tsc`.
 * upload-flow.property.test.ts round-trips every state, event and effect it generates through them.
 *
 * Strict: an object with a key its schema does not name is refused, so a caller runs exactly the
 * branch the check chose (a choice that is both a tick and a day is no choice). Run the PARSED
 * value, never the input. The one exception is a read's extraction, the server's answer: every
 * field the review, the plan or the save reads is checked; a field no code reads is kept as sent.
 */
import * as z from './zod';
import { COMPARATORS } from './lab-limits';
import type { AdditionalLabValue, DocumentResult, ExtractedValue, RefusedLabValue, UnifiedExtractionResult } from './lab-extraction';
import { UNIT_SYSTEMS } from './units';
import type { ChoiceChange, FileChoices } from './upload-choices';
import { GATE_WORDS_MAX, NETWORK_FAILURES, UPLOAD_FAILURES, type UploadFailure } from './upload-failure';
import type { UploadEffect, UploadEvent, UploadState } from './upload-flow';

const text = z.string();
const maybeText = z.string().nullable();
const count = z.number().int().nonnegative();
const platform = z.enum(['web', 'phone']);
const comparator = z.enum(COMPARATORS).optional();
const day = { recordedAt: text.optional(), printedMonth: text.optional() };
const confidence = z.enum(['high', 'medium', 'low']);

// --- The server's read (lab-extraction.ts UnifiedExtractionResult, as forWidget answers it) ---------
// Each row's shape is pinned strict to its type, then read loose, so a field a newer server adds passes.
const VALUE = z.object({
  metric: text, valueSI: z.number(), displayValue: z.number(), displayUnit: text, displaySystem: z.enum(UNIT_SYSTEMS),
  confidence, question: text.optional(), printedName: text.optional(), ...day, unitGuessed: z.literal(true).optional(), comparator,
});
const ADDITIONAL = z.object({
  name: text, value: z.number(), unit: text, referenceLow: z.number().nullable().optional(), referenceHigh: z.number().nullable().optional(),
  printedName: text.optional(), ...day, comparator, confidence: confidence.optional(), question: text.optional(),
});
const REFUSED = z.object({ metric: text, value: z.number(), unit: text, reason: text, ...day });
const DOCUMENT = z.object({
  classification: text, title: text, documentDate: maybeText, contentMarkdown: text, summary: text.optional(), metadata: z.record(z.string(), z.unknown()),
});
const loose = <S extends z.ZodRawShape>(o: z.ZodObject<S>) => z.looseObject(o.shape);
/** The server's read, checked where it enters (an `answered` event, a stream's last line, a stored state). */
export const UPLOAD_EXTRACTION = z.looseObject({
  classification: text,
  reportDate: maybeText,
  values: z.array(loose(VALUE)),
  additionalValues: z.array(loose(ADDITIONAL)),
  // A read with nothing unrecognised may leave it out (lab-extraction.ts unifiedResultSchema).
  unrecognized: z.array(text).optional(),
  document: loose(DOCUMENT).nullable(),
  droppedValueCount: count.optional(),
  // `reason` stays text: an older server may send a word this build does not know (unreadLines).
  unreadValues: z.array(z.looseObject({ name: text, reason: text, recordedAt: text.optional() })).optional(),
  refusedValues: z.array(loose(REFUSED)).optional(),
}).transform((x) => x as unknown as UnifiedExtractionResult);

// --- The machine (upload-flow.ts) --------------------------------------------------------------
const strict = z.strictObject;
const documentFix = strict({ title: text.optional(), kind: text.optional(), date: maybeText.optional() });
const choices = strict({
  ticks: z.record(z.string(), z.boolean()), testDay: maybeText, previousDay: maybeText,
  replace: z.record(z.string(), z.string()), edits: z.record(z.string(), z.number()), document: documentFix,
});
const failReason = z.enum(['unreadable', 'bytesUnreadable', 'zipUnreadable', 'zipEmpty', 'timeout', 'busy', 'dailyLimit', 'declined', 'tooLong', 'server', 'network', 'keyRefused', 'noCredit', 'keyRateLimit', 'noKey', 'appRefused', 'tooLarge', 'cannotAttest', 'attestFailed']);
/** An App Attest step or code: a short word, nothing else from the error (US-52 AC7e). */
export const ATTEST_PART = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
/** upload-failure.ts FailDetail: the server's own words, as text; the App Attest step and code; or how the request failed. */
export const NETWORK_FAILURE = z.enum(NETWORK_FAILURES);
const failDetail = z.union([strict({ message: z.string().min(1).max(GATE_WORDS_MAX) }), strict({ stage: ATTEST_PART, code: ATTEST_PART }),
  strict({ network: NETWORK_FAILURE })]);
const runRefusal = z.enum(['dailyLimit', 'noKey', 'server']);
const status = z.discriminatedUnion('s', [
  strict({ s: z.literal('unlisted') }),
  strict({ s: z.literal('listing') }),
  strict({ s: z.literal('waiting') }),
  strict({ s: z.literal('hashing') }),
  strict({ s: z.literal('hashed') }),
  strict({ s: z.literal('known'), as: z.enum(['document', 'labReport', 'legacy']), archiveOnly: z.boolean() }),
  strict({ s: z.literal('refused'), verdict: z.enum(['tooLarge', 'unsupported', 'tooMany']) }),
  strict({ s: z.literal('converting') }),
  strict({ s: z.literal('ready'), attempt: count }),
  strict({ s: z.literal('sending'), attempt: count }),
  strict({ s: z.literal('read'), extraction: UPLOAD_EXTRACTION, choices }),
  strict({ s: z.literal('failed'), reason: failReason, attempt: count, detail: failDetail.optional() }),
  strict({ s: z.literal('stopped') }),
]);
const file = strict({
  id: text, name: text, zip: text.optional(), bytes: z.number(), hash: maybeText, original: z.literal(false).optional(),
  pages: strict({ count, truncated: z.boolean() }).nullable(), status,
});
const pick = { platform, run: count, files: z.array(file), started: text, firstRead: maybeText };
const outcome = strict({ values: count, documents: count, archived: count, unstored: count.optional() });

export const UPLOAD_STATE = z.discriminatedUnion('phase', [
  strict({ phase: z.literal('choosing'), platform, run: count }),
  strict({ phase: z.literal('consent'), ...pick }),
  strict({ phase: z.literal('open'), ...pick }),
  strict({ phase: z.literal('saving'), ...pick, attempt: count }),
  strict({ phase: z.literal('saveFailed'), ...pick, attempt: count, message: text }),
  strict({ phase: z.literal('done'), ...pick, outcome }),
  strict({ phase: z.literal('failed'), ...pick, refused: runRefusal.nullable() }),
]);

/** Strict branches: a change naming two kinds (a tick and a day) matches none and is refused. */
const change = z.union([
  strict({ tick: text, on: z.boolean() }),
  strict({ testDay: maybeText }),
  strict({ previousDay: maybeText }),
  strict({ replace: text, correctsId: maybeText }),
  strict({ edit: text, value: z.number().nullable() }),
  strict({ document: documentFix }),
]);
const failure = z.enum(UPLOAD_FAILURES);

/** Each event by its type, for a caller that sends some of them in a shape of its own (the doors' wire). */
export const UPLOAD_EVENTS = {
  picked: strict({ type: z.literal('picked'), files: z.array(strict({ id: text, name: text, bytes: z.number(), kind: z.enum(['file', 'zip']), original: z.literal(false).optional() })), needsConsent: z.boolean(), now: text }),
  consented: strict({ type: z.literal('consented') }),
  listed: strict({ type: z.literal('listed'), run: count, zip: text, members: z.array(strict({ id: text, name: text, bytes: z.number() })) }),
  zipFailed: strict({ type: z.literal('zipFailed'), run: count, zip: text }),
  hashed: strict({ type: z.literal('hashed'), run: count, id: text, hash: text, known: strict({ as: z.enum(['document', 'labReport']), archiveOnly: z.boolean() }).nullable() }),
  hashFailed: strict({ type: z.literal('hashFailed'), run: count, id: text }),
  converted: strict({ type: z.literal('converted'), run: count, id: text, pages: count, truncated: z.boolean() }),
  convertFailed: strict({ type: z.literal('convertFailed'), run: count, id: text, reason: z.enum(['unreadable', 'timeout']) }),
  answered: strict({ type: z.literal('answered'), run: count, id: text, extraction: UPLOAD_EXTRACTION, legacy: z.boolean(), now: text }),
  sendFailed: strict({ type: z.literal('sendFailed'), run: count, id: text, failure, detail: failDetail.optional() }),
  runRefused: strict({ type: z.literal('runRefused'), run: count, reason: runRefusal }),
  retry: strict({ type: z.literal('retry'), id: text }),
  stop: strict({ type: z.literal('stop') }),
  chose: strict({ type: z.literal('chose'), id: text, change, now: text }),
  saveStarted: strict({ type: z.literal('saveStarted') }),
  saved: strict({ type: z.literal('saved'), run: count, attempt: count, outcome }),
  saveFailed: strict({ type: z.literal('saveFailed'), run: count, attempt: count, message: text }),
  close: strict({ type: z.literal('close') }),
  discard: strict({ type: z.literal('discard') }),
};
const E = UPLOAD_EVENTS;
export const UPLOAD_EVENT = z.discriminatedUnion('type', [
  E.picked, E.consented, E.listed, E.zipFailed, E.hashed, E.hashFailed, E.converted, E.convertFailed, E.answered,
  E.sendFailed, E.runRefused, E.retry, E.stop, E.chose, E.saveStarted, E.saved, E.saveFailed, E.close, E.discard,
]);

const ids = z.array(text);
export const UPLOAD_EFFECT = z.discriminatedUnion('type', [
  strict({ type: z.literal('list'), run: count, id: text }),
  strict({ type: z.literal('hash'), run: count, id: text }),
  strict({ type: z.literal('convert'), run: count, id: text }),
  strict({ type: z.literal('send'), run: count, id: text, attempt: count, flags: strict({ ownDates: z.boolean(), undatedPrev: z.boolean(), refusedRows: z.boolean() }) }),
  strict({ type: z.literal('abort'), run: count, ids }),
  strict({ type: z.literal('forget'), run: count, ids }),
  strict({ type: z.literal('save'), run: count, attempt: count }),
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
pin<Same<z.infer<typeof VALUE>, ExtractedValue>>();
pin<Same<z.infer<typeof ADDITIONAL>, AdditionalLabValue>>();
pin<Same<z.infer<typeof REFUSED>, RefusedLabValue>>();
pin<Same<z.infer<typeof DOCUMENT>, DocumentResult>>();
