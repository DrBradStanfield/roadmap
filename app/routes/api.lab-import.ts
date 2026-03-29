import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getCustomerId, EXEMPT_CUSTOMERS } from '../lib/route-helpers.server';
import { labImportRequestSchema, batchImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractOrClassify, createBatch, pollBatch } from '../lib/anthropic.server';

// ---------------------------------------------------------------------------
// Rate limiter: 200 extraction requests per day per customer
// ---------------------------------------------------------------------------

const EXTRACT_LIMIT = 200;
const EXTRACT_WINDOW_MS = 24 * 60 * 60_000;
const extractLimitMap = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of extractLimitMap) {
    if (now > entry.resetAt) extractLimitMap.delete(key);
  }
}, 30 * 60_000);

function checkExtractLimit(customerId: string, consume: boolean, count = 1): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = extractLimitMap.get(customerId);
  if (!entry || now > entry.resetAt) {
    if (consume) {
      extractLimitMap.set(customerId, { count, resetAt: now + EXTRACT_WINDOW_MS });
      return { allowed: true, remaining: EXTRACT_LIMIT - count };
    }
    return { allowed: true, remaining: EXTRACT_LIMIT };
  }
  if (entry.count + count > EXTRACT_LIMIT) {
    return { allowed: false, remaining: Math.max(0, EXTRACT_LIMIT - entry.count) };
  }
  if (consume) entry.count += count;
  return { allowed: true, remaining: EXTRACT_LIMIT - entry.count };
}

// ---------------------------------------------------------------------------
// In-memory batch tracking (per-process, not distributed)
// ---------------------------------------------------------------------------

const MAX_ACTIVE_BATCHES = 1000;
const activeBatches = new Map<string, {
  customerId: string;
  fileNames: string[];
  totalFiles: number;
  createdAt: number;
}>();

// Clean up stale batches after 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, batch] of activeBatches) {
    if (batch.createdAt < cutoff) activeBatches.delete(id);
  }
}, 10 * 60_000);

// ---------------------------------------------------------------------------
// GET: Preflight quota check OR batch poll
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ allowed: false, remaining: 0, error: 'Not logged in' }, { status: 401 });
  }

  const url = new URL(request.url);
  const batchId = url.searchParams.get('batchId');

  // Batch poll
  if (batchId) {
    const batch = activeBatches.get(batchId);
    if (!batch || batch.customerId !== customerId) {
      return json({ error: 'Batch not found' }, { status: 404 });
    }

    try {
      const result = await pollBatch(batchId);

      if (result.status === 'ended' && result.results) {
        activeBatches.delete(batchId);
        return json({
          status: 'ended',
          completed: result.completed,
          total: result.total,
          results: result.results.map((r, i) => ({
            fileName: batch.fileNames[i] || `file-${i}`,
            ...r,
          })),
        });
      }

      return json({
        status: 'processing',
        completed: result.completed,
        total: result.total,
      });
    } catch (error) {
      console.error('Batch poll error:', error);
      return json({ status: 'processing', completed: 0, total: batch.totalFiles });
    }
  }

  // Preflight quota check
  if (EXEMPT_CUSTOMERS.has(customerId)) {
    return json({ allowed: true, remaining: EXTRACT_LIMIT });
  }

  const { allowed, remaining } = checkExtractLimit(customerId, false);
  return json({ allowed, remaining });
}

// ---------------------------------------------------------------------------
// POST: Single file extraction OR batch creation
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const isExempt = EXEMPT_CUSTOMERS.has(customerId);

  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 200 * 1024 * 1024) { // 200MB for batch (up to 200 files)
      return json({ success: false, error: 'Request too large' }, { status: 413 });
    }

    const body = await request.json();

    // --- Batch mode ---
    const batchValidation = batchImportRequestSchema.safeParse(body);
    if (batchValidation.success) {
      const { files } = batchValidation.data;

      // Rate limit: consume one per file
      if (!isExempt) {
        const limit = checkExtractLimit(customerId, true, files.length);
        if (!limit.allowed) {
          return json(
            { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
            { status: 429 },
          );
        }
      }

      if (activeBatches.size >= MAX_ACTIVE_BATCHES) {
        return json({ success: false, error: 'Server busy. Please try again later.' }, { status: 429 });
      }

      const { batchId } = await createBatch(files);

      activeBatches.set(batchId, {
        customerId,
        fileNames: files.map(f => f.fileName),
        totalFiles: files.length,
        createdAt: Date.now(),
      });

      return json({
        success: true,
        batchId,
        totalFiles: files.length,
      });
    }

    // --- Single file mode (legacy fallback) ---
    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return json(
        { success: false, error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }

    let remaining = EXTRACT_LIMIT;
    if (!isExempt) {
      const limit = checkExtractLimit(customerId, true);
      if (!limit.allowed) {
        return json(
          { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
          { status: 429 },
        );
      }
      remaining = limit.remaining;
    }

    const { pages } = validation.data;
    const result = await extractOrClassify(pages);

    return json({ success: true, data: result, remaining });
  } catch (error) {
    console.error('Lab import error:', error);
    Sentry.captureException(error, { tags: { feature: 'lab_import' } });
    return json({ success: false, error: 'Failed to process request' }, { status: 500 });
  }
}
