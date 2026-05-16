import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { getCustomerId, getCustomerInfo, tagShopifyCustomer, ensureKlaviyoSubscribed } from '../lib/route-helpers.server';
import { migrateGuestChat } from '../lib/supabase.server';
import { subscribeToKlaviyo } from '../lib/klaviyo.server';
import { createRateLimiter } from '../lib/rate-limiter';

const checkRateLimit = createRateLimiter(60, 60_000, 5 * 60_000);           // 60/min per customer
const checkReportLimit = createRateLimiter(5, 24 * 60 * 60_000, 30 * 60_000); // 5/day per customer
const checkGuestReportLimit = createRateLimiter(5, 24 * 60 * 60_000, 30 * 60_000); // 5/day per email

import {
  getOrCreateSupabaseUser,
  createUserClient,
  getMeasurements,
  getAllMeasurements,
  getLatestMeasurements,
  addMeasurementWithStatus,
  correctMeasurement,
  deleteMeasurement,
  toApiMeasurement,
  getProfile,
  updateProfile,
  toApiProfile,
  getMedications,
  upsertMedication,
  toApiMedication,
  getMedicationHistory,
  toApiMedicationHistory,
  getSupplements,
  upsertSupplement,
  deleteSupplement,
  toApiSupplement,
  getSupplementHistory,
  toApiSupplementHistory,
  getScreenings,
  upsertScreening,
  toApiScreening,
  getReminderPreferences,
  toApiReminderPreference,
} from '../lib/supabase.server';
import { checkAndSendWelcomeEmail, sendReportEmail, generateReportHtml, buildReportHtml, sendEmail } from '../lib/email.server';
import type { HealthInputs, MedicationInputs, ScreeningInputs } from '../../packages/health-core/src/types';
import { measurementSchema, profileUpdateSchema, medicationSchema, screeningSchema, supplementSchema, bulkMeasurementSchema, correctMeasurementSchema, healthInputSchema, METRIC_TYPES } from '../../packages/health-core/src/validation';

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
    const medicationHistoryParam = url.searchParams.get('medication_history');

    if (medicationHistoryParam) {
      const history = await getMedicationHistory(client);
      return json({ success: true, data: history.map(toApiMedicationHistory) });
    }

    const supplementHistoryParam = url.searchParams.get('supplement_history');
    if (supplementHistoryParam) {
      const history = await getSupplementHistory(client);
      return json({ success: true, data: history.map(toApiSupplementHistory) });
    }

    // Audit-mode flag for the history view: when true, include rows with
    // status='entered-in-error' so the user can see their correction history.
    // Default false. See docs/lab-upload-redesign.html §6, §8.
    const includeCorrected = url.searchParams.get('include_corrected') === 'true';

    if (allHistory) {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100') || 100, 200);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0);
      const measurements = await getAllMeasurements(client, limit, offset, includeCorrected);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    if (metricType) {
      if (!METRIC_TYPES.includes(metricType as any)) {
        return json({ success: false, error: 'Invalid metric_type' }, { status: 400 });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
      const measurements = await getMeasurements(client, metricType, limit, includeCorrected);
      return json({ success: true, data: measurements.map(toApiMeasurement) });
    }

    const [latest, profile, medications, screenings, reminderPrefs, supplements] = await Promise.all([
      getLatestMeasurements(client),
      getProfile(client),
      getMedications(client),
      getScreenings(client),
      getReminderPreferences(client),
      getSupplements(client),
    ]);
    return json({
      success: true,
      data: latest.map(toApiMeasurement),
      profile: profile ? toApiProfile(profile) : null,
      medications: medications.map(toApiMedication),
      screenings: screenings.map(toApiScreening),
      reminderPreferences: reminderPrefs.map(toApiReminderPreference),
      supplements: supplements.map(toApiSupplement),
    });
  } catch (error) {
    console.error('Error loading measurements:', error);
    Sentry.captureException(error);
    return json({ success: false, error: 'Failed to load' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Guest report — stateless email-only flow (no Supabase, no auth required)
// ---------------------------------------------------------------------------

const guestReportSchema = z.object({
  email: z.string().email().max(254),
  inputs: healthInputSchema,
  medications: z.any().optional(),
  screenings: z.any().optional(),
});

async function handleGuestReport(data: unknown) {
  try {
    const parsed = guestReportSchema.safeParse(data);
    if (!parsed.success) {
      return json({ success: false, error: 'Invalid request data' }, { status: 400 });
    }
    const { email, inputs, medications, screenings } = parsed.data;

    if (!checkGuestReportLimit(email.toLowerCase())) {
      return json({ success: false, error: 'Email limit reached. Try again tomorrow.' }, { status: 429 });
    }

    const result = buildReportHtml(inputs as HealthInputs, medications as MedicationInputs | undefined, screenings as ScreeningInputs | undefined);
    if ('error' in result) {
      return json({ success: false, error: result.error }, { status: 400 });
    }

    await sendEmail(email, 'Your Personalized Health Plan', result.html);
    subscribeToKlaviyo({
      email,
      sex: inputs.sex,
      heightCm: inputs.heightCm,
      weightKg: inputs.weightKg,
      birthMonth: inputs.birthMonth,
      birthYear: inputs.birthYear,
    }).catch(() => {});

    return json({ success: true });
  } catch (error) {
    console.error('Guest report error:', error);
    Sentry.captureException(error, { tags: { feature: 'guest_report' } });
    return json({ success: false, error: 'Failed to send report' }, { status: 500 });
  }
}

// POST — Add measurement or update profile
// DELETE — Remove measurement
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const body = await request.json();

  // Guest report — no auth required (checked before customerId gate)
  if (body.guestReport) {
    return handleGuestReport(body.guestReport);
  }

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

    if (request.method === 'POST') {
      // Guest chat migration — POST { migrateGuestChat: sessionToken }
      // Called by sync-embed when a guest creates an account
      if (body.migrateGuestChat && typeof body.migrateGuestChat === 'string') {
        const migrated = await migrateGuestChat(body.migrateGuestChat, userId);
        return json({ success: migrated });
      }

      // Welcome email trigger — POST { sendWelcomeEmail: true }
      // Called by sync-embed after full data sync completes
      if (body.sendWelcomeEmail) {
        const sent = await checkAndSendWelcomeEmail(userId, client);
        // Fire-and-forget: tag Shopify customer for Klaviyo audiences
        tagShopifyCustomer(admin, customerId).catch(() => {});
        ensureKlaviyoSubscribed(customerInfo.email).catch(() => {});
        return json({ success: sent });
      }

      // Report email — POST { sendReportEmail: true }
      if (body.sendReportEmail) {
        if (!checkReportLimit(customerId)) {
          return json({ success: false, error: 'Email limit reached. Try again tomorrow.' }, { status: 429 });
        }
        try {
          const result = await sendReportEmail(userId, client);
          if (!result.success) {
            return json({ success: false, error: result.error || 'Failed to send email' }, { status: 500 });
          }
          return json({ success: true });
        } catch (error) {
          console.error('Report email error:', error);
          Sentry.captureException(error, { tags: { feature: 'report_email' } });
          return json({ success: false, error: 'Failed to send email' }, { status: 500 });
        }
      }

      // Report HTML (for print) — POST { getReportHtml: true }
      if (body.getReportHtml) {
        if (!checkReportLimit(customerId)) {
          return json({ success: false, error: 'Report limit reached. Try again tomorrow.' }, { status: 429 });
        }
        try {
          const result = await generateReportHtml(userId, client);
          if ('error' in result) {
            return json({ success: false, error: result.error }, { status: 500 });
          }
          return json({ success: true, html: result.html });
        } catch (error) {
          console.error('Report HTML error:', error);
          Sentry.captureException(error, { tags: { feature: 'report_html' } });
          return json({ success: false, error: 'Failed to generate report' }, { status: 500 });
        }
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
        if (firstName !== undefined) updates.first_name = firstName.trim();
        if (lastName !== undefined) updates.last_name = lastName.trim();
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

      // Supplement upsert — POST { supplement: { supplementKey, supplementName, ... } }
      if (body.supplement) {
        const supValidation = supplementSchema.safeParse(body.supplement);
        if (!supValidation.success) {
          return json(
            { success: false, error: 'Invalid supplement data', details: supValidation.error.issues },
            { status: 400 },
          );
        }
        const { supplementKey, supplementName, doseValue, doseUnit, status, startedAt } = supValidation.data;
        const sup = await upsertSupplement(client, userId, supplementKey, supplementName, doseValue ?? null, doseUnit ?? null, status ?? 'active', startedAt);
        if (!sup) {
          return json({ success: false, error: 'Failed to save supplement' }, { status: 500 });
        }
        return json({ success: true, data: toApiSupplement(sup) });
      }

      // Supplement delete — POST { deleteSupplement: { supplementKey } }
      if (body.deleteSupplement) {
        const delValidation = supplementSchema.pick({ supplementKey: true }).safeParse(body.deleteSupplement);
        if (!delValidation.success) {
          return json(
            { success: false, error: 'Invalid supplement key', details: delValidation.error.issues },
            { status: 400 },
          );
        }
        const deleted = await deleteSupplement(client, userId, delValidation.data.supplementKey);
        if (!deleted) {
          return json({ success: false, error: 'Failed to delete supplement' }, { status: 500 });
        }
        return json({ success: true });
      }

      // Bulk measurement save (from lab import)
      if (body.bulkMeasurements) {
        const bulkValidation = bulkMeasurementSchema.safeParse(body);
        if (!bulkValidation.success) {
          return json(
            { success: false, error: 'Invalid bulk data', details: bulkValidation.error.issues },
            { status: 400 },
          );
        }

        const results = await Promise.all(
          bulkValidation.data.bulkMeasurements.map(m =>
            addMeasurementWithStatus(client, userId, m.metricType, m.value, m.recordedAt, m.source, m.externalId),
          ),
        );

        const saved = results.flatMap(r => r.status === 'inserted' ? [r.row] : []);
        const skippedDuplicates = results.filter(r => r.status === 'duplicate').length;
        const errors = results.filter(r => r.status === 'error').length;

        // All-duplicates is a legitimate no-op (user re-uploaded the same data).
        // Only fail if everything errored AND nothing was a known-duplicate.
        if (saved.length === 0 && errors > 0 && skippedDuplicates === 0) {
          return json({ success: false, error: 'Failed to save measurements' }, { status: 500 });
        }

        // Skip downstream side-effects when nothing actually changed.
        if (saved.length > 0) {
          checkAndSendWelcomeEmail(userId, client).catch(err => Sentry.captureException(err));
          tagShopifyCustomer(admin, customerId).catch(() => {});
          ensureKlaviyoSubscribed(customerInfo.email).catch(() => {});
        }

        return json({
          success: true,
          data: saved.map(m => toApiMeasurement(m)),
          savedCount: saved.length,
          skippedDuplicates,
          errorCount: errors,
          totalCount: bulkValidation.data.bulkMeasurements.length,
        });
      }

      // FHIR replaces: POST { correctMeasurement: { oldId, newValue } }.
      // 404 covers all three failure modes (not found / not owned / already
      // corrected) without leaking ownership info.
      if (body.correctMeasurement) {
        const correctValidation = correctMeasurementSchema.safeParse(body);
        if (!correctValidation.success) {
          return json(
            { success: false, error: 'Invalid correction', details: correctValidation.error.issues },
            { status: 400 },
          );
        }
        const { oldId, newValue } = correctValidation.data.correctMeasurement;
        const result = await correctMeasurement(client, userId, oldId, newValue);
        if (result.status === 'conflict') {
          return json(
            { success: false, error: 'Another value was saved at this date while you were correcting. Refresh and try again.' },
            { status: 409 },
          );
        }
        if (result.status === 'not_found') {
          return json({ success: false, error: 'Measurement not found or not correctable' }, { status: 404 });
        }
        return json({ success: true, newId: result.newId });
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
      const insert = await addMeasurementWithStatus(client, userId, metricType, value, recordedAt, source, externalId);

      if (insert.status === 'duplicate') {
        return json(
          { success: false, error: 'A measurement already exists for this metric at this time. Use the correction UI to update it.' },
          { status: 409 },
        );
      }
      if (insert.status === 'error') {
        return json({ success: false, error: 'Failed to save' }, { status: 500 });
      }
      const measurement = insert.row;

      // Fire-and-forget: check if welcome email should be sent (widget path)
      checkAndSendWelcomeEmail(userId, client).catch(err => {
        Sentry.captureException(err);
      });
      // Fire-and-forget: tag Shopify customer for Klaviyo audiences
      tagShopifyCustomer(admin, customerId).catch(() => {});
      ensureKlaviyoSubscribed(customerInfo.email).catch(() => {});

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
