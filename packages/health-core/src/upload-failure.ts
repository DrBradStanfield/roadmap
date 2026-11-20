/**
 * What a failed lab read means, read once from the server's answer (US-12 AC9, US-15 AC34): one
 * reader for every client. It answers case for case as widget-src/src/lib/upload-api.ts `labImport`
 * does today, which adopts it in design PR 9; upload-flow.ts takes its code on `sendFailed`.
 */
import { EXTRACTION_STOP_CODES } from './models';
import * as z from './zod';

/** The web's UploadErrorCode names, so the web adopts them unchanged. The key codes come only from the
 *  Pages build's own Anthropic key (widget-src byok-upload.ts); a server answer is never one of them. */
const WEB_FAILURES = ['rate_limit', 'busy', 'server_error', 'network', ...EXTRACTION_STOP_CODES, 'key_refused', 'no_credit', 'key_rate_limit'] as const;
/** What the web's reader answers: never one of the iPhone's codes below. */
export type WebUploadFailure = (typeof WEB_FAILURES)[number];
export const UPLOAD_FAILURES = [...WEB_FAILURES,
  // The iPhone's alone: the app gate's final refusal and a body too large (appGateFailure), and the
  // phone's own App Attest: a device that cannot prove the app, or one whose proof failed.
  'app_refused', 'too_large', 'cannot_attest', 'attest_failed'] as const;
export type UploadFailure = (typeof UPLOAD_FAILURES)[number];
/** A web code, as the web's pipeline hands it on: the iPhone's codes never come from a web answer. */
export const isUploadFailure = (code: string | undefined): code is WebUploadFailure => (WEB_FAILURES as readonly string[]).includes(code ?? '');

const tooManyAnswer = z.object({ code: z.enum(['daily_limit', 'busy']) });
const stopAnswer = z.object({ errorCode: z.enum(EXTRACTION_STOP_CODES) });

/**
 * `status`: the HTTP status, or null when no answer came (a thrown fetch). `body`: the parsed JSON
 * body; null when the answer was not JSON; undefined when it said JSON but would not parse (which
 * JSON.parse never returns). Only for an answer that is not a read: a 200 here is one that said
 * `success: false` or carried no data.
 * - 429: busy only when its code says so; a missing or unknown code, or no readable body, is the
 *   daily limit, as an older server meant.
 * - 422: Claude declined (`refused`) or stopped short (`too_long`); any other code is a server error.
 * - A 422 or a 200 whose JSON would not parse: a network error, as upload-api.ts's catch makes it.
 * - Any other status: a server error (its body is never read).
 */
export function uploadFailure(status: number | null, body: unknown): WebUploadFailure {
  if (status === null) return 'network';
  if (status === 429) return tooManyAnswer.safeParse(body).data?.code === 'busy' ? 'busy' : 'rate_limit';
  if ((status === 422 || (status >= 200 && status < 300)) && body === undefined) return 'network';
  if (status === 422) return stopAnswer.safeParse(body).data?.errorCode ?? 'server_error';
  return 'server_error';
}

/**
 * `uploadFailure` for an answer as a device saw it, unparsed: `text` the body (null when none came),
 * `contentType` its header. Read as the web's reader reads it (widget-src server-api.ts
 * `parseJsonResponse`): a body its header does not call JSON is null; JSON that will not parse, undefined.
 */
export function uploadFailureOfText(status: number | null, text: string | null, contentType: string | null): WebUploadFailure {
  let body: unknown = null;
  if (text !== null && (contentType ?? '').includes('application/json')) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  return uploadFailure(status, body);
}

/**
 * What a failed send said beyond its code, for its line (US-52 AC7e): the app gate's own `error`
 * words, as today's iPhone shows them; or the phone's App Attest step and code that failed.
 */
export type FailDetail = { message: string } | { stage: string; code: string };
/** The gate's words are shown as text, never read: trimmed, at most this long. */
export const GATE_WORDS_MAX = 200;

/**
 * The app gate's refusal before a stream, as the iPhone saw it (app-gate.server.ts, lab-read): read
 * as `uploadFailureOfText` reads it, except that a 401 (final: the app already retried the one it
 * mends) is `app_refused`, a 413 `too_large`, and any other 4xx but 422 and 429 `app_refused` too,
 * none of which Try again mends, as today's iPhone never offers it under 500. A refusal from 400 up,
 * but a 422, carries the gate's own `error` words, as today's iPhone shows them.
 */
export function appGateFailure(status: number | null, text: string | null, contentType: string | null): { failure: UploadFailure; detail?: FailDetail } {
  const gate = status !== null && status >= 400 && status < 500 && ![413, 422, 429].includes(status);
  const failure = gate ? 'app_refused' : status === 413 ? 'too_large' : uploadFailureOfText(status, text, contentType);
  const message = status !== null && status >= 400 && status !== 422 ? gateWords(text, contentType) : null;
  return message ? { failure, detail: { message } } : { failure };
}

function gateWords(text: string | null, contentType: string | null): string | null {
  if (text === null || !(contentType ?? '').includes('application/json')) return null;
  try {
    const error: unknown = (JSON.parse(text) as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error.trim().slice(0, GATE_WORDS_MAX) || null : null;
  } catch {
    return null;
  }
}
