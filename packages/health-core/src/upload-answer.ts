/**
 * What one lab read's answer is, read once (US-52 AC7e, AC8c): a read to review, or the shared
 * failure code. The lab route answers `{success: true, data}` (lab-extract-one.server.ts); anything
 * else is `uploadFailure`'s to name. The app's streaming route ends with one NDJSON line,
 * `{status, body}`, carrying the status and body the plain route would answer (app-lab-read.server.ts).
 */
import type { UnifiedExtractionResult } from './lab-extraction';
import { uploadFailure, type UploadFailure } from './upload-failure';
import { UPLOAD_EXTRACTION } from './upload-schema';
import * as z from './zod';

export type LabAnswer = { extraction: UnifiedExtractionResult } | { failure: UploadFailure };

const read = z.object({ success: z.literal(true), data: z.unknown() });

/**
 * `status` and `body` as uploadFailure takes them. A 2xx whose `data` is not a read the engine can
 * check (UPLOAD_EXTRACTION) is the server's error, never a read: nothing malformed reaches a save.
 */
export function labAnswer(status: number | null, body: unknown): LabAnswer {
  const ok = status !== null && status >= 200 && status < 300 ? read.safeParse(body) : null;
  if (ok?.success) {
    const extraction = UPLOAD_EXTRACTION.safeParse(ok.data.data);
    return extraction.success ? { extraction: extraction.data } : { failure: 'server_error' };
  }
  return { failure: uploadFailure(status, body) };
}

const lastLine = z.object({ status: z.number().int(), body: z.unknown() });

/** The streaming route's last line as received, or null when the stream ended without one. No line, or
 *  one that is not `{status, body}`, is the connection's failure: network, which Try again mends. */
export function labStreamAnswer(line: string | null): LabAnswer {
  let raw: unknown;
  try { raw = line === null ? undefined : JSON.parse(line); } catch { raw = undefined; }
  const last = lastLine.safeParse(raw);
  return last.success ? labAnswer(last.data.status, last.data.body) : { failure: 'network' };
}
