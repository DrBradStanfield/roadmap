import crypto from 'node:crypto';
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { labImportRequestSchema, batchImportRequestSchema } from '../../packages/health-core/src/validation';
import { UNDATED_PREVIOUS } from '../../packages/health-core/src/lab-extraction';
import { extractOrClassify, createBatch, pollBatch, deleteBatch, BatchRefusedError, ExtractionStopError, reportExtractionStop } from '../lib/anthropic.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { createQuotaCounter, DAY_MS, machineFiles } from '../lib/rate-limiter';
import { getClientIp, parseSimpleRequestJson, verifyAppProxySignature } from '../lib/local-first-route.server';

/**
 * Lab extraction for the LOCAL-FIRST storefront page (Phase 4 "thin server
 * AI"). Same Claude pipeline as api.lab-import.ts, but no Shopify session
 * and no accounts — the §7 posture: extracted text/images transit, results
 * return, nothing is stored.
 *
 * Access (Phase-5 hardening, 2026-06-11): requests come ONLY through the
 * Shopify app proxy (/apps/health-tool-1/api/lab-import-v2) and must carry a
 * valid proxy signature — supersedes the old cross-origin AI_ALLOWED_ORIGINS
 * check (an Origin header is forgeable; Shopify's HMAC is not). Same-origin
 * via the proxy, so no CORS machinery at all. The Pages/self-host build
 * extracts with the user's own key (byok-upload.ts) and never calls this
 * route. (Decision record §10 threat model.)
 *
 * Cost control (no identity to meter per-user):
 *  - per-IP daily file limit (anti-abuse): the upload window's own file cap,
 *    so any batch it takes fits a fresh day (US-12 AC17)
 *  - a HARD per-machine daily file cap as the $-cap guardrail, shared with the
 *    connector's import (`machineFiles` in rate-limiter.ts, US-35 AC10). Tune
 *    via AI_DAILY_FILE_CAP (default 500/day/machine ≈ low tens of $ worst case).
 */

const PER_IP_DAILY_LIMIT = IMPORT_LIMITS.websiteFiles;

// Per-IP daily file quota — same shared counter machinery the sibling
// local-first routes use (rate-limiter.ts), weighted by file count.
const ipQuota = createQuotaCounter(PER_IP_DAILY_LIMIT, DAY_MS, 30 * 60_000);

/** Consume `count` files against the per-IP quota AND the machine $-cap; all or nothing. */
function consumeQuota(ip: string, count: number): boolean {
  if (!ipQuota.take(ip, count)) return false;
  if (machineFiles.take('machine', count)) return true;
  ipQuota.refund(ip, count);
  return false;
}

/** Hand back files charged for a batch Anthropic certainly did not create. */
function refundQuota(ip: string, count: number): void {
  ipQuota.refund(ip, count);
  machineFiles.refund('machine', count);
}

// Batch poll state — per-machine, like v1 (a poll landing on the other Fly
// machine returns 404 and the client falls back; same accepted risk as v1).
//
// A batch id is Anthropic's, not a secret, and the poll returns EXTRACTED LAB
// TEXT — so the id alone must not be enough to read someone else's results.
// Each batch carries a random `pollToken`, handed to the uploader once and
// required on every poll; without it, or with the wrong one, the batch does not
// exist (404, the same answer as an id nobody created).
const MAX_ACTIVE_BATCHES = 200;
const PROCESSING_POLL_MS = 2000;
type BatchPollResult = Awaited<ReturnType<typeof pollBatch>>;
const activeBatches = new Map<string, {
  totalFiles: number; createdAt: number; pollToken: string; days: DayFlags;
  refusedRows?: true; servedAt?: number;
  pollResult?: { status: 'processing'; completed: number; total: number };
  pollInFlight?: Promise<BatchPollResult>; pollAfter?: number;
}>();
// Batches Anthropic still holds for us, id → createdAt: each is deleted there
// once ended (US-12 AC18). The sweep takes a batch whose results were served
// at least 10 minutes ago, so a re-poll after a lost answer has that long, and
// one nobody polled to the end (the tab closed) after an hour. deleteBatch
// cancels a batch still running, so the next sweep can delete it. Every batch
// ends within 24 h, so after 25 the sweep stops trying. Per machine and in
// memory, like activeBatches: a restart forgets them, and Anthropic's 29 days apply.
const undeletedBatches = new Map<string, number>();
let sweeping = false;
let sweep: ReturnType<typeof setInterval> | undefined;
/** Arm once after a batch exists, only from the server action (US-12 AC18). */
function ensureBatchSweep(): void {
  if (sweep) return;
  sweep = setInterval(async () => {
    if (sweeping) return; // a slow sweep (up to 200 deletes) never overlaps the next
    sweeping = true;
    try {
      const now = Date.now();
      for (const [id, b] of activeBatches) {
        // A served batch keeps its 10 minutes, however old; an unserved one gets an hour.
        if (b.servedAt ? b.servedAt <= now - 10 * 60_000 : b.createdAt < now - 60 * 60_000) {
          activeBatches.delete(id);
          undeletedBatches.set(id, b.createdAt);
        }
      }
      for (const [id, createdAt] of undeletedBatches) {
        if (await deleteBatch(id) || createdAt < now - 25 * 60 * 60_000) undeletedBatches.delete(id);
      }
    } finally {
      sweeping = false;
    }
  }, 10 * 60_000);
  // Never hold the process open just to sweep, as rate-limiter.ts does.
  sweep.unref?.();
}

/** The flags a widget sends to say which own days it reads. */
type DayFlags = { ownDates?: true; undatedPrev?: true };

/**
 * A widget from before dated previous columns ignores `recordedAt` and would
 * file those values on the report date, so it never gets them (US-12 AC12).
 * Only the new widget sends `ownDates: true`. One from before undated previous
 * columns reads "undated" as a date, so it gets those only with
 * `undatedPrev: true` (AC14).
 */
function withDaysItReads<T>(result: T, { ownDates, undatedPrev }: DayFlags): T {
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
function withRefusalsItReads<T>(result: T, refusedRows?: true): T {
  const r = result as { droppedValueCount?: number; refusedValues?: unknown[] };
  if (refusedRows || !r.refusedValues?.length) return result;
  return { ...result, droppedValueCount: (r.droppedValueCount ?? 0) + r.refusedValues.length };
}

/** The token the uploader gets back and every poll must present. */
function newPollToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Constant-length compare; a missing or differently sized token is simply wrong. */
function matchesPollToken(expected: string, supplied: string | null): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Answer one batch poll. Lives on the POST side, not the GET side, because
 * `@react-router/serve` logs every request URL (morgan "tiny") to stdout and
 * so to Fly's logs — a poll token in the query string is a logged capability
 * to read someone's extracted lab text. A request body is never logged.
 * Shopify signs the query on any method, so the proxy HMAC is unaffected.
 */
async function answerPoll(batchId: string, pollToken: string | null): Promise<Response> {
  const batch = activeBatches.get(batchId);
  if (!batch || !matchesPollToken(batch.pollToken, pollToken)) {
    return Response.json({ error: 'Batch not found' }, { status: 404 });
  }
  try {
    // Retain only value-free progress between polls. Terminal payloads serve
    // current waiters only; check the capability before sharing either state.
    const cached = batch.pollResult;
    const result: BatchPollResult = cached && Date.now() < (batch.pollAfter ?? 0)
      ? cached
      : await (batch.pollInFlight ??= pollBatch(batchId)
        .then(result => {
          batch.pollResult = result.status === 'processing'
            ? { status: 'processing', completed: result.completed, total: result.total }
            : undefined;
          batch.pollAfter = result.status === 'processing' ? Date.now() + PROCESSING_POLL_MS : undefined;
          return result;
        })
        .finally(() => { batch.pollInFlight = undefined; }));
    // Served: a sweep at least 10 minutes on deletes it at Anthropic (US-12 AC18). Each stopped
    // file is reported once, when the batch ends: it can be polled again (US-15 AC34).
    if (result.status === 'ended' && !batch.servedAt) {
      batch.servedAt = Date.now();
      for (const stop of result.stops ?? []) reportExtractionStop(stop.code, stop.refusalCategory, 'batch');
    }
    return Response.json(
      { status: result.status, results: result.results?.map(r => withRefusalsItReads(withDaysItReads(r, batch.days), batch.refusedRows)), completed: result.completed, total: result.total },
    );
  } catch (error) {
    console.error('Batch poll error (v2):', error);
    return Response.json({ status: 'processing', completed: 0, total: batch.totalFiles });
  }
}

/** GET: quota preflight only. */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!verifyAppProxySignature(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const remaining = ipQuota.remaining(getClientIp(request, 'shopify'));
  return Response.json({ allowed: remaining > 0, remaining });
}

/** POST: batch poll, single-file extraction, or batch creation. */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') return Response.json({ success: false, error: 'POST only' }, { status: 405 });
  if (!verifyAppProxySignature(request)) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }
  const ip = getClientIp(request, 'shopify');

  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 200 * 1024 * 1024) {
      return Response.json({ success: false, error: 'Request too large' }, { status: 413 });
    }

    const body = await parseSimpleRequestJson(request);

    // --- Batch poll --- (costs no quota; it reads a batch already paid for)
    const poll = body as { batchId?: unknown; pollToken?: unknown } | null;
    if (typeof poll?.batchId === 'string') {
      return answerPoll(poll.batchId, typeof poll.pollToken === 'string' ? poll.pollToken : null);
    }

    // --- Batch mode ---
    const batchValidation = batchImportRequestSchema.safeParse(body);
    if (batchValidation.success) {
      const { files, ownDates, undatedPrev, refusedRows } = batchValidation.data;
      // Busy is checked first, so a refused batch is never charged.
      if (activeBatches.size >= MAX_ACTIVE_BATCHES) {
        return Response.json({ success: false, error: 'Server busy. Please try again later.' }, { status: 429 });
      }
      if (!consumeQuota(ip, files.length)) {
        return Response.json(
          { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
          { status: 429 },
        );
      }
      // A timeout or network failure may still have made the batch: it stays charged.
      const { batchId } = await createBatch(files).catch((err: unknown) => {
        if (err instanceof BatchRefusedError) refundQuota(ip, files.length);
        throw err;
      });
      const pollToken = newPollToken();
      activeBatches.set(batchId, { totalFiles: files.length, createdAt: Date.now(), pollToken, days: { ownDates, undatedPrev }, refusedRows });
      ensureBatchSweep();
      return Response.json({ success: true, batchId, pollToken, totalFiles: files.length });
    }

    // --- Single file mode ---
    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });
    }
    if (!consumeQuota(ip, 1)) {
      return Response.json(
        { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
        { status: 429 },
      );
    }

    const { pages, ownDates, undatedPrev, refusedRows } = validation.data;
    try {
      // One deadline for the file's calls: a malformed answer's re-send gets what
      // is left. A timed-out HTTP attempt is still retried once in a fresh window
      // (fetchAnthropicRaw), kept for capacity blips; ~46 s answers make it rare (US-15 AC34).
      const result = await extractOrClassify(pages, { timeoutMs: 60_000 });
      return Response.json({ success: true, data: withRefusalsItReads(withDaysItReads(result, { ownDates, undatedPrev }), refusedRows), remaining: ipQuota.remaining(ip) });
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
  } catch (error) {
    console.error('Lab import error (v2):', error);
    Sentry.captureException(error, { tags: { feature: 'lab_import_v2' } });
    return Response.json({ success: false, error: 'Failed to process request' }, { status: 500 });
  }
}
