import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { labImportRequestSchema, batchImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractOrClassify, createBatch, pollBatch } from '../lib/anthropic.server';
import { ALLOWED_ORIGINS, corsHeaders, getClientIp, parseSimpleRequestJson } from '../lib/local-first-route.server';

/**
 * Cross-origin lab extraction for the LOCAL-FIRST front door (Phase 4 "thin
 * server AI"). Same Claude pipeline as api.lab-import.ts, but no Shopify
 * session and no accounts — the §7 posture: extracted text/images transit,
 * results return, nothing is stored.
 *
 * Cost control (no identity to meter per-user):
 *  - per-IP daily file limit (anti-abuse, mirrors v1's per-customer limit)
 *  - a HARD per-machine daily file cap as the $-cap guardrail. In-memory, so
 *    the true global cap ≈ cap × machine count and resets on deploy — an
 *    accepted approximation until a shared counter is worth its DDL. Tune via
 *    AI_DAILY_FILE_CAP (default 500/day/machine ≈ low tens of $ worst case).
 *  - the CORS allow-list (never localhost) + Phase 5 plan: drstanfield.com
 *    only via the app-proxy HMAC (decision record §10 threat model).
 */

const PER_IP_DAILY_LIMIT = 60;
const MACHINE_DAILY_CAP = Number(process.env.AI_DAILY_FILE_CAP || 500);
const WINDOW_MS = 24 * 60 * 60_000;

const ipCounts = new Map<string, { count: number; resetAt: number }>();
let machineDay = '';
let machineCount = 0;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ipCounts) {
    if (now > entry.resetAt) ipCounts.delete(key);
  }
}, 30 * 60_000);

/** Consume `count` files against both limits; false = refuse. */
function consumeQuota(ip: string, count: number): { allowed: boolean; remaining: number } {
  const today = new Date().toISOString().slice(0, 10);
  if (machineDay !== today) {
    machineDay = today;
    machineCount = 0;
  }
  if (machineCount + count > MACHINE_DAILY_CAP) return { allowed: false, remaining: 0 };

  const now = Date.now();
  let entry = ipCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    ipCounts.set(ip, entry);
  }
  if (entry.count + count > PER_IP_DAILY_LIMIT) {
    return { allowed: false, remaining: Math.max(0, PER_IP_DAILY_LIMIT - entry.count) };
  }
  entry.count += count;
  machineCount += count;
  return { allowed: true, remaining: PER_IP_DAILY_LIMIT - entry.count };
}

function remainingFor(ip: string): number {
  const entry = ipCounts.get(ip);
  if (!entry || Date.now() > entry.resetAt) return PER_IP_DAILY_LIMIT;
  return Math.max(0, PER_IP_DAILY_LIMIT - entry.count);
}

// Batch poll state — per-machine, like v1 (a poll landing on the other Fly
// machine returns 404 and the client falls back; same accepted risk as v1).
const MAX_ACTIVE_BATCHES = 200;
const activeBatches = new Map<string, { ip: string; totalFiles: number; createdAt: number }>();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, b] of activeBatches) if (b.createdAt < cutoff) activeBatches.delete(id);
}, 10 * 60_000);

/** GET: quota preflight (?quota) or batch poll (?batchId=...). */
export async function loader({ request }: LoaderFunctionArgs) {
  const headers = corsHeaders(request);
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: 'Origin not allowed' }, { status: 403, headers });
  }
  const ip = getClientIp(request);
  const url = new URL(request.url);
  const batchId = url.searchParams.get('batchId');

  if (batchId) {
    const batch = activeBatches.get(batchId);
    if (!batch) return json({ error: 'Batch not found' }, { status: 404, headers });
    try {
      const result = await pollBatch(batchId);
      return json(
        { status: result.status, results: result.results, completed: result.completed, total: result.total },
        { headers },
      );
    } catch (error) {
      console.error('Batch poll error (v2):', error);
      return json({ status: 'processing', completed: 0, total: batch.totalFiles }, { headers });
    }
  }

  return json({ allowed: remainingFor(ip) > 0, remaining: remainingFor(ip) }, { headers });
}

/** POST: single-file extraction or batch creation (text/plain simple request). */
export async function action({ request }: ActionFunctionArgs) {
  const headers = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ success: false, error: 'POST only' }, { status: 405, headers });

  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json({ success: false, error: 'Origin not allowed' }, { status: 403, headers });
  }
  const ip = getClientIp(request);

  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 200 * 1024 * 1024) {
      return json({ success: false, error: 'Request too large' }, { status: 413, headers });
    }

    const body = await parseSimpleRequestJson(request);

    // --- Batch mode ---
    const batchValidation = batchImportRequestSchema.safeParse(body);
    if (batchValidation.success) {
      const { files } = batchValidation.data;
      const limit = consumeQuota(ip, files.length);
      if (!limit.allowed) {
        return json(
          { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
          { status: 429, headers },
        );
      }
      if (activeBatches.size >= MAX_ACTIVE_BATCHES) {
        return json({ success: false, error: 'Server busy. Please try again later.' }, { status: 429, headers });
      }
      const { batchId } = await createBatch(files);
      activeBatches.set(batchId, { ip, totalFiles: files.length, createdAt: Date.now() });
      return json({ success: true, batchId, totalFiles: files.length }, { headers });
    }

    // --- Single file mode ---
    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return json({ success: false, error: 'Invalid request' }, { status: 400, headers });
    }
    const limit = consumeQuota(ip, 1);
    if (!limit.allowed) {
      return json(
        { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
        { status: 429, headers },
      );
    }

    const { pages } = validation.data;
    try {
      const result = await extractOrClassify(pages);
      return json({ success: true, data: result, remaining: limit.remaining }, { headers });
    } catch (error) {
      console.error('Lab import error (v2):', error);
      Sentry.captureException(error, {
        tags: { feature: 'lab_import_v2', errorName: (error as Error)?.name ?? 'unknown' },
        extra: { pageCount: pages.length, pageTypes: pages.map((p) => p.type) },
      });
      return json({ success: false, error: 'Failed to process request' }, { status: 500, headers });
    }
  } catch (error) {
    console.error('Lab import error (v2):', error);
    Sentry.captureException(error, { tags: { feature: 'lab_import_v2' } });
    return json({ success: false, error: 'Failed to process request' }, { status: 500, headers });
  }
}
