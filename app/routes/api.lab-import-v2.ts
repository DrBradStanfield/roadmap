import crypto from 'node:crypto';
import { sameBytes } from '../lib/crypto-compare.server';
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { labImportRequestSchema, batchImportRequestSchema } from '../../packages/health-core/src/validation';
import { createBatch, pollBatch, BatchRefusedError, reportExtractionStop } from '../lib/anthropic.server';
import { extractOneFile, withDaysItReads, withRefusalsItReads } from '../lib/lab-extract-one.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { createQuotaCounter, DAY_MS, machineFiles } from '../lib/rate-limiter';
import { BODY_TOO_LARGE, getClientIp, parseSimpleRequestJson, verifyAppProxySignature } from '../lib/local-first-route.server';
import { SMALL_BODY_CAP } from '../lib/capped-body.server';
import { activeBatches, armSweep, batchFor, creatingBatches, fileSetKey, MAX_ACTIVE_BATCHES, MAX_POLL_TOKENS, type BatchPollResult } from '../lib/lab-batches.server';
import { safeErrorFields } from '../lib/safe-error-fields.server';

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
 *    via AI_DAILY_FILE_CAP (default 2000/day/machine, raised from 500 on 2026-10-21: 4x the old worst-case cost).
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

// A 429's `code` tells the browser the daily limit from a busy server (US-12 AC9).
const dailyLimit = () => Response.json(
  { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' },
  { status: 429 },
);
const serverBusy = () => Response.json({ success: false, error: 'Server busy. Please try again later.', code: 'busy' }, { status: 429 });

const daySpent = (ip: string) => ipQuota.remaining(ip) === 0 || machineFiles.remaining('machine') === 0;
/**
 * US-12 AC17b: with no file left today for this IP or the machine, only a poll
 * can succeed, so no more than a poll's body is read, and a larger one gets the
 * daily-limit answer.
 */
function bodyLimit(ip: string): { cap: number; tooLarge: () => Response } {
  if (daySpent(ip)) return { cap: SMALL_BODY_CAP, tooLarge: dailyLimit };
  return { cap: 200 * 1024 * 1024, tooLarge: () => Response.json({ success: false, error: 'Request too large' }, { status: 413 }) };
}

/** Hand back files charged for a batch Anthropic certainly did not create. */
function refundQuota(ip: string, count: number): void {
  ipQuota.refund(ip, count);
  machineFiles.refund('machine', count);
}

/** The token the uploader gets back and every poll must present. */
function newPollToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Constant-length compare; a missing or differently sized token is simply wrong. */
function matchesPollToken(expected: string, supplied: string | null): boolean {
  if (!supplied) return false;
  return sameBytes(Buffer.from(expected), Buffer.from(supplied));
}

/** Hand a re-send of a live batch its own poll token, up to the cap (US-12 AC25). */
function joinBatch(batchId: string): Response {
  const batch = activeBatches.get(batchId);
  if (!batch || batch.servedAt || batch.pollTokens.length >= MAX_POLL_TOKENS) return serverBusy();
  const pollToken = newPollToken();
  batch.pollTokens.push(pollToken);
  return Response.json({ success: true, batchId, pollToken, totalFiles: batch.totalFiles });
}

/** How long a processing count is reused before the next provider read. */
const PROCESSING_POLL_MS = 2000;

/**
 * Answer one batch poll. Lives on the POST side, not the GET side, because
 * `@react-router/serve` logs every request URL (morgan "tiny") to stdout and
 * so to Fly's logs — a poll token in the query string is a logged capability
 * to read someone's extracted lab text. A request body is never logged.
 * Shopify signs the query on any method, so the proxy HMAC is unaffected.
 */
async function answerPoll(batchId: string, pollToken: string | null): Promise<Response> {
  const batch = activeBatches.get(batchId);
  if (!batch || !batch.pollTokens.some(token => matchesPollToken(token, pollToken))) {
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
    // A failed read can change: answer `error` with the last count served, and the
    // client polls on to its deadline (US-12 AC24). The next poll reads the provider again.
    console.error('Batch poll error (v2):', safeErrorFields(error));
    return Response.json({ status: 'error', completed: batch.pollResult?.completed ?? 0, total: batch.pollResult?.total ?? batch.totalFiles });
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
  const limit = bodyLimit(ip);

  try {
    const body = await parseSimpleRequestJson(request, limit.cap);
    if (body === BODY_TOO_LARGE) return limit.tooLarge();

    // --- Batch poll --- (costs no quota; it reads a batch already paid for)
    const poll = body as { batchId?: unknown; pollToken?: unknown } | null;
    if (typeof poll?.batchId === 'string') {
      return answerPoll(poll.batchId, typeof poll.pollToken === 'string' ? poll.pollToken : null);
    }

    // --- Batch mode ---
    const batchValidation = batchImportRequestSchema.safeParse(body);
    if (batchValidation.success) {
      const { files, ownDates, undatedPrev, refusedRows } = batchValidation.data;
      // US-12 AC25: the same files again join their live batch with a new token, uncharged.
      // Matched and reserved before any await, so a twin POST never makes a second batch.
      // A spent day joins nothing: the re-pick gets the daily limit, as a new batch would.
      if (daySpent(ip)) return dailyLimit();
      const fileSet = fileSetKey(ip, { ownDates, undatedPrev, refusedRows }, files);
      const joining = batchFor(fileSet);
      if (joining !== undefined) return joinBatch(await joining);
      // Busy is checked first, so a refused batch is never charged.
      if (activeBatches.size >= MAX_ACTIVE_BATCHES) return serverBusy();
      if (!consumeQuota(ip, files.length)) return dailyLimit();
      const pollToken = newPollToken();
      // A timeout or network failure may still have made the batch: it stays charged.
      const creating = createBatch(files).then(({ batchId }) => {
        activeBatches.set(batchId, { totalFiles: files.length, createdAt: Date.now(), pollTokens: [pollToken], days: { ownDates, undatedPrev }, refusedRows, fileSet });
        armSweep();
        return batchId;
      }, (err: unknown) => {
        if (err instanceof BatchRefusedError) refundQuota(ip, files.length);
        throw err;
      }).finally(() => creatingBatches.delete(fileSet));
      creatingBatches.set(fileSet, creating);
      return Response.json({ success: true, batchId: await creating, pollToken, totalFiles: files.length });
    }

    // --- Single file mode ---
    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });
    }
    if (!consumeQuota(ip, 1)) return dailyLimit();

    return extractOneFile(validation.data, () => ({ remaining: ipQuota.remaining(ip) }));
  } catch (error) {
    console.error('Lab import error (v2):', safeErrorFields(error));
    Sentry.captureException(error, { tags: { feature: 'lab_import_v2' } });
    return Response.json({ success: false, error: 'Failed to process request' }, { status: 500 });
  }
}
