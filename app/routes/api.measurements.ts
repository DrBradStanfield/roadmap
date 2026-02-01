import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { authenticate } from '../shopify.server';
import {
  getOrCreateSupabaseUser,
  createUserClient,
  getMeasurements,
  getLatestMeasurements,
  addMeasurement,
  deleteMeasurement,
  toApiMeasurement,
  getProfile,
  updateProfile,
  toApiProfile,
} from '../lib/supabase.server';
import { measurementSchema, profileUpdateSchema, METRIC_TYPES } from '../../packages/health-core/src/validation';

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

// GET — Load measurements (authenticated via app proxy HMAC)
// ?metric_type=weight&limit=50  → list measurements for one metric
// (no metric_type)              → latest value per metric + profile demographics
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
    if (!customerInfo) {
      return json({ success: false, error: 'Could not retrieve customer info' }, { status: 500 });
    }

    const userId = await getOrCreateSupabaseUser(customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName);
    const client = createUserClient(userId);

    const url = new URL(request.url);
    const metricType = url.searchParams.get('metric_type');

    if (metricType) {
      if (!METRIC_TYPES.includes(metricType as any)) {
        return json({ success: false, error: 'Invalid metric_type' }, { status: 400 });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
      const measurements = await getMeasurements(client, metricType, limit);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    const latest = await getLatestMeasurements(client);
    const profile = await getProfile(client);
    return json({
      success: true,
      data: latest.map(toApiMeasurement),
      profile: profile ? toApiProfile(profile) : null,
    });
  } catch (error) {
    console.error('Error loading measurements:', error);
    return json({ success: false, error: 'Failed to load' }, { status: 500 });
  }
}

// POST — Add measurement or update profile
// DELETE — Remove measurement
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
    if (!customerInfo) {
      return json({ success: false, error: 'Could not retrieve customer info' }, { status: 500 });
    }

    const userId = await getOrCreateSupabaseUser(customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName);
    const client = createUserClient(userId);

    const body = await request.json();

    if (request.method === 'POST') {
      // Profile update — POST { profile: { sex?, birthYear?, birthMonth?, unitSystem? } }
      if (body.profile) {
        const validation = profileUpdateSchema.safeParse(body.profile);
        if (!validation.success) {
          return json(
            { success: false, error: 'Invalid profile data', details: validation.error.issues },
            { status: 400 },
          );
        }

        const { sex, birthYear, birthMonth, unitSystem, firstName, lastName } = validation.data;
        const updates: Record<string, number | string> = {};
        if (sex !== undefined) updates.sex = sex;
        if (birthYear !== undefined) updates.birth_year = birthYear;
        if (birthMonth !== undefined) updates.birth_month = birthMonth;
        if (unitSystem !== undefined) updates.unit_system = unitSystem;
        if (firstName !== undefined) updates.first_name = firstName;
        if (lastName !== undefined) updates.last_name = lastName;

        const updated = await updateProfile(client, userId, updates);
        if (!updated) {
          return json({ success: false, error: 'Failed to update profile' }, { status: 500 });
        }

        return json({ success: true, profile: toApiProfile(updated) });
      }

      // Measurement insert — POST { metricType, value, recordedAt? }
      const validation = measurementSchema.safeParse(body);
      if (!validation.success) {
        return json(
          { success: false, error: 'Invalid input', details: validation.error.issues },
          { status: 400 },
        );
      }

      const { metricType, value, recordedAt } = validation.data;
      const measurement = await addMeasurement(client, userId, metricType, value, recordedAt);

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

      const deleted = await deleteMeasurement(client, measurementId);
      return json({ success: deleted });
    }

    return json({ success: false, error: 'Method not allowed' }, { status: 405 });
  } catch (error) {
    console.error('Error with measurement:', error);
    return json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
