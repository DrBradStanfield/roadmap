import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { z } from 'zod';
import { createRateLimiter, DAY_MS } from '../lib/rate-limiter';
import { ALLOWED_ORIGINS, corsHeaders, getClientIp, parseSimpleRequestJson } from '../lib/local-first-route.server';
import {
  buildUnsubscribeUrl,
  cancelByToken,
  emailLimiterKey,
  enrolByEmail,
  scheduleSchema,
  updateScheduleByToken,
  upsertVerifiedOptin,
  verifyGoogleIdToken,
  type Enrolment,
} from '../lib/reminder-v2.server';
import { subscribeToKlaviyo } from '../lib/klaviyo.server';
import { sendPlanReadyEmail } from '../lib/email.server';
import { hashClientIp } from '../lib/supabase.server';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * v2 email reminders API (decision record §10). Three ops, all POST:
 *
 *  - optin:  two disjoint body shapes, one per lane.
 *            VERIFIED: provider 'google-drive' + a signed ID token, never an
 *            address (it grants nothing; the server reads the verified email
 *            from it — US-17 AC7). The token is what makes the lane, so the
 *            schema requires it: a 'google-drive' body carrying only an
 *            address is 400, never an address-lane row wearing the verified
 *            provider — that row would survive its inbox owner's own
 *            verification and keep the squatter's cancel capability. This
 *            caller proved the inbox, so the reply ALWAYS carries the
 *            capability token: new row, new device, or rotated.
 *            ADDRESS: provider dropbox/github/typed + the ADDRESS the browser
 *            read from the provider — no storage credential ever reaches this
 *            server (Brad, 2026-09-10 — a Dropbox token or a GitHub PAT
 *            confers far more than "verify my email"). Anyone can name anyone's
 *            inbox here, so the typed lane's rules hold (AC8): a new address
 *            gets its capability token ONCE (the browser saves it in the user's
 *            own cloud file); an existing address is a schedule refresh and
 *            gets nothing back.
 *  - update: capability token + replacement schedule (client re-pushes on
 *            every data change / app visit).
 *  - cancel: capability token → the row is tombstoned (schedule emptied);
 *            with a Google ID token for the row's own address it is deleted.
 *
 * Same cross-origin posture as api.google-token.ts: CORS allow-list (HARD
 * RULE: never localhost), text/plain simple-request bodies (remix-serve 405s
 * preflights), rate-limited, stateless beyond the §10-minimum opt-in row.
 */

// Opt-ins and schedule pushes are rare per user; this mostly slows abuse.
const allowRequest = createRateLimiter(20, 60_000, 10 * 60_000);
// An address-only optin names someone ELSE'S inbox for free, so it carries
// the capture route's bounds (US-23 AC8): 5/day per email, 20/hour per IP.
// Keyed on the hashed IP — the raw address never sits in process memory.
const allowOptinEmail = createRateLimiter(5, DAY_MS, 30 * 60_000);
const allowOptinIp = createRateLimiter(20, 60 * 60_000, 30 * 60_000);

const bodySchema = z.union([
  // Optional TYPED marketing opt-in on both optin shapes (§10: a deliberate
  // typed step at the reminders flow, never harvested from the provider).
  // Transits straight to Klaviyo; never stored in the reminder row.
  z.object({
    op: z.literal('optin'),
    provider: z.literal('google-drive'),
    idToken: z.string().min(1).max(4096),
    schedule: scheduleSchema,
    marketingEmail: z.string().email().max(320).optional(),
  }),
  z.object({
    op: z.literal('optin'),
    // 'typed' here is also the widget's Drive fallback with no fresh ID token —
    // an address-only optin must never be recorded as the verified lane.
    provider: z.enum(['dropbox', 'github', 'typed']),
    email: z.string().email().max(254),
    schedule: scheduleSchema,
    marketingEmail: z.string().email().max(320).optional(),
  }),
  z.object({
    op: z.literal('update'),
    token: z.string().min(1).max(256),
    schedule: scheduleSchema,
  }),
  z.object({
    op: z.literal('cancel'),
    token: z.string().min(1).max(256),
    idToken: z.string().min(1).max(4096).optional(),
  }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json({ error: 'POST only' }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request }: ActionFunctionArgs) {
  const headers = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers });

  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403, headers });
  }

  const ipHash = hashClientIp(getClientIp(request, 'fly'));
  if (!allowRequest(ipHash)) {
    return Response.json({ error: 'Too many requests' }, { status: 429, headers });
  }

  const parsed = bodySchema.safeParse(await parseSimpleRequestJson(request));
  if (!parsed.success) return Response.json({ error: 'Invalid input' }, { status: 400, headers });
  const input = parsed.data;

  if (input.op === 'optin') {
    let email: string;
    let enrolment: Enrolment;
    if (input.provider === 'google-drive') {
      const verified = await verifyGoogleIdToken(input.idToken);
      if (!verified) {
        return Response.json({ error: 'Could not verify your email with Google' }, { status: 401, headers });
      }
      email = verified;
      enrolment = await upsertVerifiedOptin(email, input.schedule);
    } else {
      email = input.email.toLowerCase();
      if (!allowOptinEmail(emailLimiterKey(email)) || !allowOptinIp(ipHash)) {
        return Response.json({ error: 'Too many requests' }, { status: 429, headers });
      }
      enrolment = await enrolByEmail(email, input.provider, input.schedule);
    }

    // Fire-and-forget — Klaviyo must never block or fail the reminders opt-in.
    if (input.marketingEmail) void subscribeToKlaviyo({ email: input.marketingEmail });

    if (enrolment.isNew) {
      // Every lane's consent gate is delivery (US-22 AC4 / US-17 AC8): the
      // plan-ready email's bounce or complaint un-enrols before the 3-day
      // quiet period ends. Fire-and-forget; counted HERE because only the
      // server knows the enrolment landed — abuse enrolments count too. Both
      // fire once per enrolment, so they hang off isNew, not off the token.
      sendPlanReadyEmail(email, {
        schedule: input.schedule,
        unsubscribeUrl: buildUnsubscribeUrl(enrolment.token),
      }).catch(() => {});
      void recordServerEvent('reminder_optin', { provider: input.provider });
    }
    // A token comes back whenever the enrolment yielded one. The verified lane
    // always does: that caller proved the inbox, and withholding it stranded
    // every Drive user on a second device and every user whose squatted row
    // had just been rotated — no token in their file means schedule pushes
    // never start and toggle-off is a no-op.
    if (enrolment.token) return Response.json({ token: enrolment.token, email }, { headers });
    // The address lane, already enrolled: the schedule was refreshed and NO
    // token is returned (AC8 — it would hand the cancel capability to whoever
    // typed the address). This reply is a bounded membership oracle, accepted
    // by Brad 2026-09-10; the limits above bound it.
    return Response.json({ refreshed: true, email }, { headers });
  }

  if (input.op === 'update') {
    const found = await updateScheduleByToken(input.token, input.schedule);
    if (!found) return Response.json({ error: 'Unknown token' }, { status: 404, headers });
    return Response.json({ ok: true }, { headers });
  }

  // cancel — idempotent: cancelling an already-gone opt-in succeeds. An ID
  // token that fails to verify degrades to the tombstone, never to an error.
  await cancelByToken(input.token, input.idToken ? await verifyGoogleIdToken(input.idToken) : null);
  return Response.json({ ok: true }, { headers });
}
