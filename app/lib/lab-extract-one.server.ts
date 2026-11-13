/**
 * One lab file's extraction and its answer (US-12, US-15 AC34), shared by the
 * website's route (api.lab-import-v2.ts) and the iPhone app's (US-52 AC7).
 * Moved out of the route so a second route can call it: a route module's
 * extra exports would pull its server code into the client build.
 */
import * as Sentry from '@sentry/react-router';
import type { LabImportRequest } from '../../packages/health-core/src/validation';
import { UNDATED_PREVIOUS } from '../../packages/health-core/src/lab-extraction';
import { extractOrClassify, ExtractionStopError, reportExtractionStop } from './anthropic.server';
import type { DayFlags } from './lab-batches.server';
import { safeErrorFields } from './safe-error-fields.server';

/** The app route's timeout answer, which its slow-import report reads (US-52 AC7c, AC7d). */
export const TOO_SLOW = 'The server took too long to read this report. Please try again.';

/**
 * One file's extraction and its answer, shared with the iPhone app's route
 * (US-52 AC7). `extra` adds the caller's own fields to a success. The app
 * passes one 90 s budget with `oneDeadline`: the phone gives up after 120 s
 * idle, so its call never retries a timed-out attempt (US-52 AC7c).
 */
export async function extractOneFile(
  data: LabImportRequest, extra: () => object = () => ({}), opts: { timeoutMs?: number; oneDeadline?: true; onRetry?: () => void } = {},
): Promise<Response> {
  const { pages } = data;
  try {
    // One deadline for the file's calls: a malformed answer's re-send gets what
    // is left. A timed-out HTTP attempt is still retried once in a fresh window
    // (fetchAnthropicRaw), kept for capacity blips; ~46 s answers make it rare (US-15 AC34).
    // Not on the app's route (US-52 AC7c).
    const result = await extractOrClassify(pages, { timeoutMs: 60_000, ...opts });
    return Response.json({ success: true, data: forWidget(result, data),...extra() });
  } catch (error) {
    // Declined or cut off: its own answer, so the widget does not say "try
    // again" (US-15 AC34). The code and category only, never document text.
    if (error instanceof ExtractionStopError) {
      reportExtractionStop(error.code, error.refusalCategory, 'single');
      return Response.json({ success: false, error: 'Not read', errorCode: error.code }, { status: 422 });
    }
    reportLabImportError(error, { errorName: true });
    // The phone shows `error` verbatim, and offers Try again on a 5xx (US-52 AC7c).
    const tooSlow = opts.oneDeadline && (error as Error)?.name === 'TimeoutError';
    return Response.json({ success: false, error: tooSlow ? TOO_SLOW : 'Failed to process request' }, { status: 500 });
  }
}

/**
 * The one report of a failed lab import: the error's class and code, never its
 * message. The one-file extraction adds the error's name; no report carries a
 * page count or page types, which nothing read (US-52 AC7d).
 */
export function reportLabImportError(error: unknown, { errorName }: { errorName?: true } = {}): void {
  console.error('Lab import error (v2):', safeErrorFields(error));
  Sentry.captureException(error, errorName
    ? { tags: { feature: 'lab_import_v2', errorName: (error as Error)?.name ?? 'unknown' } }
    : { tags: { feature: 'lab_import_v2' } });
}

/**
 * One result as the widget or app that asked can read it, by the flags it
 * sent. A widget from before dated previous columns ignores `recordedAt` and
 * would file those values on the report date, so it never gets them (US-12
 * AC12). Only the new widget sends `ownDates: true`. One from before undated
 * previous columns reads "undated" as a date, so it gets those only with
 * `undatedPrev: true` (AC14). An unread row is named only from a column the
 * caller is offered, and one cut with its column leaves the count with it (AC19).
 * A widget from before refused rows never reads `refusedValues`, so it hears
 * the ones it is offered as values that could not be read: they are added to
 * its `droppedValueCount` here and only here. This widget sends
 * `refusedRows: true` and lists them once, under "Not saved" (AC15).
 */
export function forWidget<T>(result: T, { ownDates, undatedPrev, refusedRows }: DayFlags & { refusedRows?: true }): T {
  const reads = (v: { recordedAt?: string }) => !v.recordedAt || (!!ownDates && v.recordedAt !== UNDATED_PREVIOUS);
  const r = result as { values?: Array<{ recordedAt?: string }>; additionalValues?: Array<{ recordedAt?: string }>; refusedValues?: Array<{ recordedAt?: string }>; unreadValues?: Array<{ recordedAt?: string }>; droppedValueCount?: number };
  const unread = r.unreadValues?.filter(reads);
  const days = ownDates && undatedPrev ? r : {
    ...r,
    ...(r.values && { values: r.values.filter(reads) }),
    ...(r.additionalValues && { additionalValues: r.additionalValues.filter(reads) }),
    ...(r.refusedValues && { refusedValues: r.refusedValues.filter(reads) }),
    ...(unread && { unreadValues: unread, droppedValueCount: (r.droppedValueCount ?? 0) - (r.unreadValues!.length - unread.length) }),
  };
  if (refusedRows || !days.refusedValues?.length) return days as T;
  return { ...days, droppedValueCount: (days.droppedValueCount ?? 0) + days.refusedValues.length } as T;
}
