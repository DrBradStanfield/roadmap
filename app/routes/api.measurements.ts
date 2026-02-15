import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';

// In-memory rate limiter: 60 requests per minute per customer
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60_000);

function checkRateLimit(customerId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(customerId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(customerId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

import {
  getOrCreateSupabaseUser,
  createUserClient,
  getMeasurements,
  getAllMeasurements,
  getLatestMeasurements,
  addMeasurement,
  deleteMeasurement,
  toApiMeasurement,
  getProfile,
  updateProfile,
  toApiProfile,
  getMedications,
  upsertMedication,
  toApiMedication,
  getScreenings,
  upsertScreening,
  toApiScreening,
  getReminderPreferences,
  toApiReminderPreference,
} from '../lib/supabase.server';
import { checkAndSendWelcomeEmail } from '../lib/email.server';
import { measurementSchema, profileUpdateSchema, medicationSchema, screeningSchema, METRIC_TYPES } from '../../packages/health-core/src/validation';

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
  if (!checkRateLimit(customerId)) {
    return json({ success: false, error: 'Too many requests' }, { status: 429 });
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
    const allHistory = url.searchParams.get('all_history');

    if (allHistory) {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100') || 100, 200);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0);
      const measurements = await getAllMeasurements(client, limit, offset);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    if (metricType) {
      if (!METRIC_TYPES.includes(metricType as any)) {
        return json({ success: false, error: 'Invalid metric_type' }, { status: 400 });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
      const measurements = await getMeasurements(client, metricType, limit);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    const [latest, profile, medications, screenings, reminderPrefs] = await Promise.all([
      getLatestMeasurements(client),
      getProfile(client),
      getMedications(client),
      getScreenings(client),
      getReminderPreferences(client),
    ]);
    return json({
      success: true,
      data: latest.map(toApiMeasurement),
      profile: profile ? toApiProfile(profile) : null,
      medications: medications.map(toApiMedication),
      screenings: screenings.map(toApiScreening),
      reminderPreferences: reminderPrefs.map(toApiReminderPreference),
    });
  } catch (error) {
    console.error('Error loading measurements:', error);
    Sentry.captureException(error);
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
  if (!checkRateLimit(customerId)) {
    return json({ success: false, error: 'Too many requests' }, { status: 429 });
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
      // Welcome email trigger — POST { sendWelcomeEmail: true }
      // Called by sync-embed after full data sync completes
      if (body.sendWelcomeEmail) {
        checkAndSendWelcomeEmail(userId, client).catch(err => {
          console.error('Welcome email failed:', err);
          Sentry.captureException(err);
        });
        return json({ success: true });
      }

      // Profile update — POST { profile: { sex?, birthYear?, birthMonth?, unitSystem? } }
      if (body.profile) {
        const validation = profileUpdateSchema.safeParse(body.profile);
        if (!validation.success) {
          return json(
            { success: false, error: 'Invalid profile data', details: validation.error.issues },
            { status: 400 },
          );
        }

        const { sex, birthYear, birthMonth, unitSystem, firstName, lastName, height } = validation.data;
        const updates: Record<string, number | string> = {};
        if (sex !== undefined) updates.sex = sex;
        if (birthYear !== undefined) updates.birth_year = birthYear;
        if (birthMonth !== undefined) updates.birth_month = birthMonth;
        if (unitSystem !== undefined) updates.unit_system = unitSystem;
        if (firstName !== undefined) updates.first_name = firstName;
        if (lastName !== undefined) updates.last_name = lastName;
        if (height !== undefined) updates.height = height;

        const updated = await updateProfile(client, userId, updates);
        if (!updated) {
          return json({ success: false, error: 'Failed to update profile' }, { status: 500 });
        }

        return json({ success: true, profile: toApiProfile(updated) });
      }

      // Medication upsert — POST { medication: { medicationKey, drugName, doseValue?, doseUnit? } }
      if (body.medication) {
        const medValidation = medicationSchema.safeParse(body.medication);
        if (!medValidation.success) {
          return json(
            { success: false, error: 'Invalid medication data', details: medValidation.error.issues },
            { status: 400 },
          );
        }

        const { medicationKey, drugName, doseValue, doseUnit } = medValidation.data;
        const med = await upsertMedication(client, userId, medicationKey, drugName, doseValue ?? null, doseUnit ?? null);
        if (!med) {
          return json({ success: false, error: 'Failed to save medication' }, { status: 500 });
        }

        return json({ success: true, data: toApiMedication(med) });
      }

      // Screening upsert — POST { screening: { screeningKey, value } }
      if (body.screening) {
        const scrValidation = screeningSchema.safeParse(body.screening);
        if (!scrValidation.success) {
          return json(
            { success: false, error: 'Invalid screening data', details: scrValidation.error.issues },
            { status: 400 },
          );
        }

        const scr = await upsertScreening(client, userId, scrValidation.data.screeningKey, scrValidation.data.value);
        if (!scr) {
          return json({ success: false, error: 'Failed to save screening' }, { status: 500 });
        }

        return json({ success: true, data: toApiScreening(scr) });
      }

      // Measurement insert — POST { metricType, value, recordedAt? }
      const validation = measurementSchema.safeParse(body);
      if (!validation.success) {
        return json(
          { success: false, error: 'Invalid input', details: validation.error.issues },
          { status: 400 },
        );
      }

      const { metricType, value, recordedAt, source, externalId } = validation.data;
      const measurement = await addMeasurement(client, userId, metricType, value, recordedAt, source, externalId);

      if (!measurement) {
        return json({ success: false, error: 'Failed to save' }, { status: 500 });
      }

      // Fire-and-forget: check if welcome email should be sent (widget path)
      checkAndSendWelcomeEmail(userId, client).catch(err => {
        Sentry.captureException(err);
      });

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
    Sentry.captureException(error);
    return json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
