import type { ActionFunctionArgs } from 'react-router';
import * as Sentry from '@sentry/node';
import { verifyResendSignature, parseResendEvent } from '../lib/resend-webhook.server';
import { suppressInKlaviyo } from '../lib/klaviyo.server';
import { deleteByEmail } from '../lib/reminder-v2.server';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * Resend bounce + spam-complaint webhook (US-22 AC3, AC10).
 *
 * ONE endpoint serves both Fly apps: they send through the same Resend
 * account, and this handler writes to the shared Supabase and the single
 * commerce Klaviyo list. Register it on commerce only.
 *
 * Authentication is the Svix signature — this route is called by Resend, not
 * by a storefront, so there is no app-proxy HMAC and no session. An unsigned
 * or stale request is rejected outright; nothing about the request body is
 * trusted until the signature passes.
 *
 * On a permanent bounce or a complaint the address is (1) unsubscribed in
 * Klaviyo so it stops costing per-contact spend and diluting ad audiences, and
 * (2) deleted from reminder_optin_v2 so it can never receive a reminder. A
 * complaint is the loudest possible "I never wanted this" under an opt-out
 * model, so it is treated exactly as harshly as a dead address.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Raw body — the signature covers the exact bytes, so it must not be parsed
  // and re-serialised before verification.
  const rawBody = await request.text();
  const verdict = verifyResendSignature(
    rawBody,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    process.env.RESEND_WEBHOOK_SECRET,
  );

  if (!verdict.ok) {
    console.warn(`Resend webhook rejected: ${verdict.reason}`);
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const { kind, emails } = parseResendEvent(payload);
  if (kind === 'ignored') return Response.json({ ok: true, action: 'ignored' });

  for (const email of emails) {
    // Both sides are attempted independently: a Klaviyo outage must not leave
    // a dead address still enrolled for reminders.
    const [suppressed, unenrolled] = await Promise.allSettled([
      suppressInKlaviyo(email),
      deleteByEmail(email),
    ]);
    if (suppressed.status === 'rejected') {
      Sentry.captureException(suppressed.reason, { tags: { feature: 'resend_webhook', step: 'klaviyo' } });
    }
    if (unenrolled.status === 'rejected') {
      Sentry.captureException(unenrolled.reason, { tags: { feature: 'resend_webhook', step: 'reminders' } });
    }
  }

  await recordServerEvent(kind === 'complained' ? 'report_email_complained' : 'report_email_bounced');
  return Response.json({ ok: true, action: kind, count: emails.length });
}

/** Resend only POSTs here; a GET is almost always a misconfigured endpoint. */
export function loader() {
  return new Response('Method not allowed', { status: 405 });
}
