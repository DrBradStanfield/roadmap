import { json, type ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getOrCreateSupabaseUser, deleteAllUserData } from '../lib/supabase.server';
import { getCustomerId, getCustomerInfo } from '../lib/route-helpers.server';

// Rate limit: 1 deletion attempt per 5 minutes per customer
const DELETE_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const deleteRateLimitMap = new Map<string, number>(); // customerId -> resetAt timestamp

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, resetAt] of deleteRateLimitMap) {
    if (now > resetAt) deleteRateLimitMap.delete(key);
  }
}, 10 * 60_000);

function isDeleteRateLimited(customerId: string): boolean {
  const resetAt = deleteRateLimitMap.get(customerId);
  return !!resetAt && Date.now() <= resetAt;
}

function recordDeleteRateLimit(customerId: string): void {
  deleteRateLimitMap.set(customerId, Date.now() + DELETE_RATE_LIMIT_WINDOW_MS);
}

// DELETE — Remove all user data (measurements, profile, auth user)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'DELETE') {
    return json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  if (isDeleteRateLimited(customerId)) {
    console.warn(`Delete rate-limited for customer ${customerId}`);
    return json({ success: false, error: 'Too many requests' }, { status: 429 });
  }

  // Record rate limit immediately to prevent concurrent/spam attempts
  recordDeleteRateLimit(customerId);

  try {
    const body = await request.json();
    if (!body.confirmDelete) {
      return json({ success: false, error: 'confirmDelete flag required' }, { status: 400 });
    }

    const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
    if (!customerInfo) {
      return json({ success: false, error: 'Could not retrieve customer info' }, { status: 500 });
    }

    const userId = await getOrCreateSupabaseUser(customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName);
    const result = await deleteAllUserData(userId);

    return json({ success: true, measurementsDeleted: result.measurementsDeleted });
  } catch (error) {
    console.error('Error deleting user data:', error);
    Sentry.captureException(error);
    return json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
