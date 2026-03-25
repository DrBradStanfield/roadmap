import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getCustomerId } from '../lib/route-helpers.server';
import { labImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractLabResults } from '../lib/anthropic.server';

// ---------------------------------------------------------------------------
// Rate limiter: 200 extraction requests per day per customer
// ---------------------------------------------------------------------------

const EXTRACT_LIMIT = 200;
const EXTRACT_WINDOW_MS = 24 * 60 * 60_000;
const extractLimitMap = new Map<string, { count: number; resetAt: number }>();

// Exempt customer IDs bypass rate limiting (e.g. for testing).
// Set via env var as comma-separated Shopify customer IDs.
const EXEMPT_CUSTOMERS = new Set(
  (process.env.RATE_LIMIT_EXEMPT_CUSTOMERS || '').split(',').map(s => s.trim()).filter(Boolean),
);

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of extractLimitMap) {
    if (now > entry.resetAt) extractLimitMap.delete(key);
  }
}, 30 * 60_000);

/** Get current quota state, optionally consuming one request. */
function checkExtractLimit(customerId: string, consume: boolean): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = extractLimitMap.get(customerId);
  if (!entry || now > entry.resetAt) {
    if (consume) {
      extractLimitMap.set(customerId, { count: 1, resetAt: now + EXTRACT_WINDOW_MS });
      return { allowed: true, remaining: EXTRACT_LIMIT - 1 };
    }
    return { allowed: true, remaining: EXTRACT_LIMIT };
  }
  if (entry.count >= EXTRACT_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  if (consume) entry.count++;
  return { allowed: true, remaining: EXTRACT_LIMIT - entry.count };
}

// ---------------------------------------------------------------------------
// GET: Preflight quota check (no side effects)
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ allowed: false, remaining: 0, error: 'Not logged in' }, { status: 401 });
  }

  if (EXEMPT_CUSTOMERS.has(customerId)) {
    return json({ allowed: true, remaining: EXTRACT_LIMIT });
  }

  const { allowed, remaining } = checkExtractLimit(customerId, false);
  return json({ allowed, remaining });
}

// ---------------------------------------------------------------------------
// POST: Extract lab results
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

  try {
    // Check body size (10MB limit)
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 10 * 1024 * 1024) {
      return json({ success: false, error: 'File too large (10MB max)' }, { status: 413 });
    }

    const body = await request.json();
    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return json(
        { success: false, error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }

    const { pages } = validation.data;

    const result = await extractLabResults(pages);

    return json({
      success: true,
      data: result,
      remaining,
    });
  } catch (error) {
    console.error('Lab import error:', error);
    Sentry.captureException(error, { tags: { feature: 'lab_import' } });
    return json({ success: false, error: 'Failed to extract lab results' }, { status: 500 });
  }
}
