import { type ActionFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { subscribeToKlaviyo } from '../lib/klaviyo.server';
import { sendPlanReadyEmail } from '../lib/email.server';
import { buildUnsubscribeUrl, scheduleSchema, upsertTypedOptin } from '../lib/reminder-v2.server';
import { recordServerEvent } from '../lib/product-events.server';
import { getClientIp } from '../lib/local-first-route.server';
import { createRateLimiter } from '../lib/rate-limiter';

const checkGuestReportLimit = createRateLimiter(5, 24 * 60 * 60_000, 30 * 60_000); // 5/day per email
// Per-IP as well as per-victim-email: the email limiter bounds harm to ONE
// address but nothing stopped one client enrolling a whole address LIST
// (N strangers' emails at rest + N sends from our domain). Best-effort — the
// proxy's forwarded IP and a per-process Map — but it turns bulk abuse from
// free into work (review 2026-08-14).
const checkCaptureIpLimit = createRateLimiter(20, 60 * 60_000, 30 * 60_000); // 20/hour per IP

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
// US-23 AC1: the capture MAY carry the client-computed reminder schedule —
// labels validated against health-core's allow-list (never free text), length-
// capped, categories closed. This is the constitution's entire permitted
// server footprint: labels + due dates + the email. Optional so an old cached
// widget bundle (email-only body) keeps working.
const klaviyoCaptureSchema = z.object({
  email: z.string().email().max(254),
  schedule: scheduleSchema.optional(),
});

// US-22: the plan-ready send lives in email.server so the template and the
// send stay together (and so the no-health-data test can target the builder).

async function handleKlaviyoCapture(data: unknown, clientIp: string) {
  try {
    const parsed = klaviyoCaptureSchema.safeParse(data);
    if (!parsed.success) {
      return Response.json({ success: false, error: 'Invalid request data' }, { status: 400 });
    }
    const { email, schedule } = parsed.data;
    if (!checkGuestReportLimit(email.toLowerCase()) || !checkCaptureIpLimit(clientIp)) {
      return Response.json({ success: false, error: 'Email limit reached. Try again tomorrow.' }, { status: 429 });
    }
    // Email-only subscribe — no `properties`, so subscribeToKlaviyo skips the
    // profile-properties step entirely. Fire-and-forget so a Klaviyo hiccup
    // never blocks the user's plan.
    subscribeToKlaviyo({ email }).catch(() => {});

    // US-23 AC1: typed-lane reminder enrolment. AWAITED (unlike the sends)
    // because the response reports `enrolled` — the client's reminder_optin
    // event must count NEW enrolments, not attempts or refreshes — but a
    // Supabase error degrades to enrolled:false rather than failing a capture
    // whose PDF the user already has. upsertTypedOptin never downgrades a
    // provider-verified row, keeps the token and cooldowns on a refresh, and
    // tells us whether this address was new.
    let enrolment: { token: string; isNew: boolean } | null = null;
    if (schedule?.length) {
      try {
        enrolment = await upsertTypedOptin(email, schedule);
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'typed_reminder_enrol' } });
      }
    }

    // US-22 AC1/AC2 + US-23 AC8: the plan-ready email fires ONLY on a NEW
    // enrolment — the one path that proves this address wasn't already known.
    // Every other body shape reaching this line is an attacker or a stale
    // cached bundle, and each was a bypass of the "one email per address ever"
    // bound before 2026-08-14's review: a schedule-less body sent per-capture;
    // a capture against a cloud-enrolled address (upsertTypedOptin → null)
    // sent per-capture to exactly the most engaged users; and unsubscribe+
    // re-capture minted a fresh isNew (closed by the tombstone in
    // unsubscribeByToken, which makes a replayed capture a refresh instead).
    // The email carries the calendar (labels + dates, the permitted footprint)
    // and the one-click unsubscribe (AC5). Fire-and-forget — a Resend outage
    // must never surface to a user who already has their plan.
    if (enrolment?.isNew) {
      sendPlanReadyEmail(email, {
        schedule,
        unsubscribeUrl: buildUnsubscribeUrl(enrolment.token),
      }).catch(() => {});
      // Counted HERE, not by the client: the server is the only party that
      // knows the enrolment landed, and counting server-side also counts
      // abuse enrolments — a client-side event would let an attacked system
      // report optout > optin and look broken (review 2026-08-14).
      void recordServerEvent('reminder_optin', { provider: 'typed' });
    }
    // The response is CONSTANT — no enrolled field. Echoing enrolment state
    // made the endpoint a membership oracle: "enrolled:false" told any
    // storefront visitor that victim@example.com already uses the tool.
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
    return handleKlaviyoCapture(body.klaviyoCapture, getClientIp(request));
  }
  return Response.json({ success: false, error: 'Unsupported request' }, { status: 400 });
}
