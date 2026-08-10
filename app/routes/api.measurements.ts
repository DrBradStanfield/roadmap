import { type ActionFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { subscribeToKlaviyo } from '../lib/klaviyo.server';
import { sendPlanReadyEmail } from '../lib/email.server';
import { createRateLimiter } from '../lib/rate-limiter';

const checkGuestReportLimit = createRateLimiter(5, 24 * 60 * 60_000, 30 * 60_000); // 5/day per email

// ---------------------------------------------------------------------------
// Klaviyo capture (local-first v2) — the "Get Your Personalized Plan" button.
// The ONLY thing that crosses to the server is the email address: subscribe it
// to the Klaviyo guest list, and (US-22) send the plan-ready email, which
// carries no health data of any kind. NO report build — the PDF is still
// generated client-side in the browser and remains the actual delivery.
//
// This is ALL that remains of the old /api/measurements endpoint. The v2 widget
// is local-first (the user's data lives in their own cloud), so the legacy
// per-user CRUD + guest-report-email paths were torn down at the 2026-06-12
// production cutover.
// ---------------------------------------------------------------------------
const klaviyoCaptureSchema = z.object({ email: z.string().email().max(254) });

// US-22: the plan-ready send lives in email.server so the template and the
// send stay together (and so the no-health-data test can target the builder).

async function handleKlaviyoCapture(data: unknown) {
  try {
    const parsed = klaviyoCaptureSchema.safeParse(data);
    if (!parsed.success) {
      return Response.json({ success: false, error: 'Invalid request data' }, { status: 400 });
    }
    const { email } = parsed.data;
    if (!checkGuestReportLimit(email.toLowerCase())) {
      return Response.json({ success: false, error: 'Email limit reached. Try again tomorrow.' }, { status: 429 });
    }
    // Email-only subscribe — no `properties`, so subscribeToKlaviyo skips the
    // profile-properties step entirely. Fire-and-forget so a Klaviyo hiccup
    // never blocks the user's plan.
    subscribeToKlaviyo({ email }).catch(() => {});
    // US-22 AC1/AC2: the plan-ready email. Fire-and-forget for the same reason
    // — the PDF is the delivery, and a Resend outage must never surface to a
    // user who already has their plan. Carries no health data by construction.
    sendPlanReadyEmail(email).catch(() => {});
    // No audit row written here — capture volume is now reported on the admin
    // dashboard straight from the Klaviyo list (the source of truth, with true
    // lifetime totals), so this path stores no email/PII and no tally at all.
    return Response.json({ success: true });
  } catch (error) {
    console.error('Klaviyo capture error:', error);
    Sentry.captureException(error, { tags: { feature: 'klaviyo_capture' } });
    return Response.json({ success: false, error: 'Failed to capture email' }, { status: 500 });
  }
}

// POST { klaviyoCapture: { email } } — the only surviving operation. The Shopify
// app-proxy HMAC signature is still validated so only signed storefront calls
// reach Klaviyo.
export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);
  const body = await request.json();
  if (body.klaviyoCapture) {
    return handleKlaviyoCapture(body.klaviyoCapture);
  }
  return Response.json({ success: false, error: 'Unsupported request' }, { status: 400 });
}
