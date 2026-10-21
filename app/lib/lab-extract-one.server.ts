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

/**
 * One file's extraction and its answer, shared with the iPhone app's route
 * (US-52 AC7). `extra` adds the caller's own fields to a success.
 */
export async function extractOneFile(data: LabImportRequest, extra: () => object = () => ({})): Promise<Response> {
  const { pages, ownDates, undatedPrev, refusedRows } = data;
  try {
    // One deadline for the file's calls: a malformed answer's re-send gets what
    // is left. A timed-out HTTP attempt is still retried once in a fresh window
    // (fetchAnthropicRaw), kept for capacity blips; ~46 s answers make it rare (US-15 AC34).
    const result = await extractOrClassify(pages, { timeoutMs: 60_000 });
    return Response.json({ success: true, data: withRefusalsItReads(withDaysItReads(result, { ownDates, undatedPrev }), refusedRows), ...extra() });
  } catch (error) {
    // Declined or cut off: its own answer, so the widget does not say "try
    // again" (US-15 AC34). The code and category only, never document text.
    if (error instanceof ExtractionStopError) {
      reportExtractionStop(error.code, error.refusalCategory, 'single');
      return Response.json({ success: false, error: 'Not read', errorCode: error.code }, { status: 422 });
    }
    console.error('Lab import error (v2):', error);
    Sentry.captureException(error, {
      tags: { feature: 'lab_import_v2', errorName: (error as Error)?.name ?? 'unknown' },
      extra: { pageCount: pages.length, pageTypes: pages.map((p) => p.type) },
    });
    return Response.json({ success: false, error: 'Failed to process request' }, { status: 500 });
  }
}

/**
 * A widget from before dated previous columns ignores `recordedAt` and would
 * file those values on the report date, so it never gets them (US-12 AC12).
 * Only the new widget sends `ownDates: true`. One from before undated previous
 * columns reads "undated" as a date, so it gets those only with
 * `undatedPrev: true` (AC14).
 */
export function withDaysItReads<T>(result: T, { ownDates, undatedPrev }: DayFlags): T {
  if (ownDates && undatedPrev) return result;
  const reads = (v: { recordedAt?: string }) => !v.recordedAt || (!!ownDates && v.recordedAt !== UNDATED_PREVIOUS);
  const r = result as { values?: Array<{ recordedAt?: string }>; additionalValues?: Array<{ recordedAt?: string }>; refusedValues?: Array<{ recordedAt?: string }> };
  return {
    ...result,
    ...(r.values && { values: r.values.filter(reads) }),
    ...(r.additionalValues && { additionalValues: r.additionalValues.filter(reads) }),
    ...(r.refusedValues && { refusedValues: r.refusedValues.filter(reads) }),
  };
}

/**
 * A widget from before refused rows never reads `refusedValues`, so it hears
 * them as values that could not be read. They are added to its
 * `droppedValueCount` here and only here: this widget sends `refusedRows: true`
 * and lists them once, under "Not saved" (US-12 AC15).
 */
export function withRefusalsItReads<T>(result: T, refusedRows?: true): T {
  const r = result as { droppedValueCount?: number; refusedValues?: unknown[] };
  if (refusedRows || !r.refusedValues?.length) return result;
  return { ...result, droppedValueCount: (r.droppedValueCount ?? 0) + r.refusedValues.length };
}
