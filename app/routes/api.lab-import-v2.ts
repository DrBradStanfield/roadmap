import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { labImportRequestSchema, batchImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractOrClassify, createBatch, pollBatch } from '../lib/anthropic.server';
import { createQuotaCounter } from '../lib/rate-limiter';
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
 *  - per-IP daily file limit (anti-abuse, mirrors v1's per-customer limit)
 *  - a HARD per-machine daily file cap as the $-cap guardrail. In-memory, so
 *    the true global cap ≈ cap × machine count and resets on deploy — an
 *    accepted approximation until a shared counter is worth its DDL. Tune via
 *    AI_DAILY_FILE_CAP (default 500/day/machine ≈ low tens of $ worst case).
 */

const PER_IP_DAILY_LIMIT = 60;
const MACHINE_DAILY_CAP = Number(process.env.AI_DAILY_FILE_CAP || 500);
const DAY_MS = 24 * 60 * 60_000;

// Per-IP daily file quota — same shared counter machinery the sibling
// local-first routes use (rate-limiter.ts), weighted by file count.
const ipQuota = createQuotaCounter(PER_IP_DAILY_LIMIT, DAY_MS, 30 * 60_000);
let machineDay = '';
let machineCount = 0;

/** Consume `count` files against the per-IP quota AND the machine $-cap. */
function consumeQuota(ip: string, count: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (machineDay !== today) {
    machineDay = today;
    machineCount = 0;
  }
  if (machineCount + count > MACHINE_DAILY_CAP) return false;
  if (!ipQuota.take(ip, count)) return false;
  machineCount += count;
  return true;
}

// Batch poll state — per-machine, like v1 (a poll landing on the other Fly
// machine returns 404 and the client falls back; same accepted risk as v1).
const MAX_ACTIVE_BATCHES = 200;
const activeBatches = new Map<string, { totalFiles: number; createdAt: number }>();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, b] of activeBatches) if (b.createdAt < cutoff) activeBatches.delete(id);
}, 10 * 60_000);

/** GET: quota preflight (?quota) or batch poll (?batchId=...). */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!verifyAppProxySignature(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const ip = getClientIp(request, 'shopify');
  const url = new URL(request.url);
  const batchId = url.searchParams.get('batchId');

  if (batchId) {
    const batch = activeBatches.get(batchId);
    if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });
    try {
      const result = await pollBatch(batchId);
      return Response.json(
        { status: result.status, results: result.results, completed: result.completed, total: result.total },
      );
    } catch (error) {
      console.error('Batch poll error (v2):', error);
      return Response.json({ status: 'processing', completed: 0, total: batch.totalFiles });
    }
  }

  const remaining = ipQuota.remaining(ip);
  return Response.json({ allowed: remaining > 0, remaining });
}

/** POST: single-file extraction or batch creation. */
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

    // --- Batch mode ---
    const batchValidation = batchImportRequestSchema.safeParse(body);
    if (batchValidation.success) {
      const { files } = batchValidation.data;
      if (!consumeQuota(ip, files.length)) {
        return Response.json(
          { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
          { status: 429 },
        );
      }
      if (activeBatches.size >= MAX_ACTIVE_BATCHES) {
        return Response.json({ success: false, error: 'Server busy. Please try again later.' }, { status: 429 });
      }
      const { batchId } = await createBatch(files);
      activeBatches.set(batchId, { totalFiles: files.length, createdAt: Date.now() });
      return Response.json({ success: true, batchId, totalFiles: files.length });
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

    const { pages } = validation.data;
    try {
      const result = await extractOrClassify(pages);
      return Response.json({ success: true, data: result, remaining: ipQuota.remaining(ip) });
    } catch (error) {
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
