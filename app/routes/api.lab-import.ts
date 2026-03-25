import { json, type ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getCustomerId } from '../lib/route-helpers.server';
import { labImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractLabResults } from '../lib/anthropic.server';

// ---------------------------------------------------------------------------
// Rate limiter: 20 extraction requests per day per customer
// ---------------------------------------------------------------------------

const EXTRACT_LIMIT = 20;
const EXTRACT_WINDOW_MS = 24 * 60 * 60_000;
const extractLimitMap = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of extractLimitMap) {
    if (now > entry.resetAt) extractLimitMap.delete(key);
  }
}, 30 * 60_000);

function checkExtractLimit(customerId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = extractLimitMap.get(customerId);
  if (!entry || now > entry.resetAt) {
    extractLimitMap.set(customerId, { count: 1, resetAt: now + EXTRACT_WINDOW_MS });
    return { allowed: true, remaining: EXTRACT_LIMIT - 1 };
  }
  if (entry.count >= EXTRACT_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: EXTRACT_LIMIT - entry.count };
}

// ---------------------------------------------------------------------------
// Route handler
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

  const { allowed, remaining } = checkExtractLimit(customerId);
  if (!allowed) {
    return json(
      { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' },
      { status: 429 },
    );
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
