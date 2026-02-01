import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { authenticate } from '../shopify.server';
import {
  findOrCreateProfile,
  getMeasurements,
  getLatestMeasurements,
  addMeasurement,
  deleteMeasurement,
  toApiMeasurement,
} from '../lib/supabase.server';
import { measurementSchema, METRIC_TYPES } from '../../packages/health-core/src/validation';

function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('logged_in_customer_id') || null;
}

async function getCustomerEmail(admin: any, customerId: string): Promise<string | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const { data } = await response.json();
    return data?.customer?.email || null;
  } catch (error) {
    console.error('Error looking up customer email:', error);
    return null;
  }
}

// GET — Load measurements (authenticated via app proxy HMAC)
// ?metric_type=weight&limit=50  → list measurements for one metric
// (no metric_type)              → latest value per metric
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const email = admin ? await getCustomerEmail(admin, customerId) : null;
    const profile = await findOrCreateProfile(customerId, email || undefined);
    if (!profile) {
      return json({ success: false, error: 'Could not find or create profile' }, { status: 500 });
    }

    const url = new URL(request.url);
    const metricType = url.searchParams.get('metric_type');

    if (metricType) {
      if (!METRIC_TYPES.includes(metricType as any)) {
        return json({ success: false, error: 'Invalid metric_type' }, { status: 400 });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
      const measurements = await getMeasurements(profile.id, metricType, limit);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    // No metric_type — return latest for each metric
    const latest = await getLatestMeasurements(profile.id);
    return json({ success: true, data: latest.map(toApiMeasurement) });
  } catch (error) {
    console.error('Error loading measurements:', error);
    return json({ success: false, error: 'Failed to load' }, { status: 500 });
  }
}

// POST — Add measurement
// DELETE — Remove measurement
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const email = admin ? await getCustomerEmail(admin, customerId) : null;
    const profile = await findOrCreateProfile(customerId, email || undefined);
    if (!profile) {
      return json({ success: false, error: 'Could not find or create profile' }, { status: 500 });
    }

    const body = await request.json();

    if (request.method === 'POST') {
      const validation = measurementSchema.safeParse(body);
      if (!validation.success) {
        return json(
          { success: false, error: 'Invalid input', details: validation.error.issues },
          { status: 400 },
        );
      }

      const { metricType, value, recordedAt } = validation.data;
      const measurement = await addMeasurement(profile.id, metricType, value, recordedAt);

      if (!measurement) {
        return json({ success: false, error: 'Failed to save' }, { status: 500 });
      }

      return json({ success: true, data: toApiMeasurement(measurement) });
    }

    if (request.method === 'DELETE') {
      const { measurementId } = body as { measurementId?: string };
      if (!measurementId) {
        return json({ success: false, error: 'measurementId required' }, { status: 400 });
      }

      const deleted = await deleteMeasurement(profile.id, measurementId);
      return json({ success: deleted });
    }

    return json({ success: false, error: 'Method not allowed' }, { status: 405 });
  } catch (error) {
    console.error('Error with measurement:', error);
    return json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
