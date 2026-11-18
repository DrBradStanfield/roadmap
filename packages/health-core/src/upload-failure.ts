/**
 * What a failed lab read means, read once from the server's answer (US-12 AC9, US-15 AC34): one
 * reader for every client. It answers case for case as widget-src/src/lib/upload-api.ts `labImport`
 * does today, which adopts it in design PR 9; upload-flow.ts takes its code on `sendFailed`.
 */
import { EXTRACTION_STOP_CODES } from './models';
import * as z from './zod';

/** The web's UploadErrorCode names, so the web adopts them unchanged. The key codes come only from the
 *  Pages build's own Anthropic key (widget-src byok-upload.ts); a server answer is never one of them. */
export const UPLOAD_FAILURES = ['rate_limit', 'busy', 'server_error', 'network', ...EXTRACTION_STOP_CODES, 'key_refused', 'no_credit', 'key_rate_limit'] as const;
export type UploadFailure = (typeof UPLOAD_FAILURES)[number];
export const isUploadFailure = (code: string | undefined): code is UploadFailure => (UPLOAD_FAILURES as readonly string[]).includes(code ?? '');

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
export function uploadFailure(status: number | null, body: unknown): UploadFailure {
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
export function uploadFailureOfText(status: number | null, text: string | null, contentType: string | null): UploadFailure {
  let body: unknown = null;
  if (text !== null && (contentType ?? '').includes('application/json')) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  return uploadFailure(status, body);
}
