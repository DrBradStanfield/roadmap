import { json, type ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getOrCreateSupabaseUser, deleteAllUserData } from '../lib/supabase.server';

// Rate limit: 1 deletion request per hour per customer
const DELETE_RATE_LIMIT_WINDOW_MS = 60 * 60_000;
const DELETE_RATE_LIMIT_MAX = 1;
const deleteRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkDeleteRateLimit(customerId: string): boolean {
  const now = Date.now();
  const entry = deleteRateLimitMap.get(customerId);
  if (!entry || now > entry.resetAt) {
    deleteRateLimitMap.set(customerId, { count: 1, resetAt: now + DELETE_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= DELETE_RATE_LIMIT_MAX;
}

function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('logged_in_customer_id') || null;
}

async function getCustomerInfo(admin: any, customerId: string): Promise<{ email: string; firstName: string | null; lastName: string | null } | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
          firstName
          lastName
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const customer = result?.data?.customer;
    if (!customer?.email) return null;
    return { email: customer.email, firstName: customer.firstName || null, lastName: customer.lastName || null };
  } catch (error) {
    console.error('Error looking up customer info:', error);
    return null;
  }
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
  if (!checkDeleteRateLimit(customerId)) {
    return json({ success: false, error: 'Too many requests' }, { status: 429 });
  }

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
