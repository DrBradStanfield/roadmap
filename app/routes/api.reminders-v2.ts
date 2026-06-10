import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { z } from 'zod';
import { createRateLimiter } from '../lib/rate-limiter';
import { ALLOWED_ORIGINS, corsHeaders, getClientIp, parseSimpleRequestJson } from '../lib/local-first-route.server';
import {
  deleteByToken,
  scheduleSchema,
  updateScheduleByToken,
  upsertOptin,
  verifyProviderEmail,
  type ProviderProof,
} from '../lib/reminder-v2.server';

/**
 * v2 email reminders API (decision record §10). Three ops, all POST:
 *
 *  - optin:  provider proof (Google ID token, or a one-time-read access token
 *            for Dropbox/GitHub/popup-Google) + the client-computed schedule.
 *            The provider vouches for the email — the only address anyone can
 *            ever target is their own. Returns the capability token ONCE; the
 *            browser saves it in the user's own cloud file.
 *  - update: capability token + replacement schedule (client re-pushes on
 *            every data change / app visit).
 *  - cancel: capability token → opt-in row is DELETED.
 *
 * Same cross-origin posture as api.google-token.ts: CORS allow-list (HARD
 * RULE: never localhost), text/plain simple-request bodies (remix-serve 405s
 * preflights), rate-limited, stateless beyond the §10-minimum opt-in row.
 */

// Opt-ins and schedule pushes are rare per user; this mostly slows abuse.
const allowRequest = createRateLimiter(20, 60_000, 10 * 60_000);

const bodySchema = z.union([
  z.object({
    op: z.literal('optin'),
    provider: z.enum(['google-drive', 'dropbox', 'github']),
    idToken: z.string().min(1).max(4096).optional(),
    accessToken: z.string().min(1).max(4096).optional(),
    schedule: scheduleSchema,
  }),
  z.object({
    op: z.literal('update'),
    token: z.string().min(1).max(256),
    schedule: scheduleSchema,
  }),
  z.object({
    op: z.literal('cancel'),
    token: z.string().min(1).max(256),
  }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ error: 'POST only' }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request }: ActionFunctionArgs) {
  const headers = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ error: 'POST only' }, { status: 405, headers });

  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: 'Origin not allowed' }, { status: 403, headers });
  }

  if (!allowRequest(getClientIp(request))) {
    return json({ error: 'Too many requests' }, { status: 429, headers });
  }

  const parsed = bodySchema.safeParse(await parseSimpleRequestJson(request));
  if (!parsed.success) return json({ error: 'Invalid input' }, { status: 400, headers });
  const input = parsed.data;

  if (input.op === 'optin') {
    let proof: ProviderProof | null = null;
    if (input.provider === 'google-drive' && input.idToken) {
      proof = { provider: 'google-drive', idToken: input.idToken };
    } else if (input.accessToken) {
      proof = { provider: input.provider, accessToken: input.accessToken } as ProviderProof;
    }
    if (!proof) return json({ error: 'Missing provider proof' }, { status: 400, headers });

    const verified = await verifyProviderEmail(proof);
    if ('reason' in verified) {
      // The server knows WHY (e.g. the GitHub PAT lacks the email permission);
      // pass the machine-readable reason so the client never has to guess.
      return json(
        { error: 'Could not verify your email with the provider', reason: verified.reason },
        { status: 401, headers },
      );
    }

    const token = await upsertOptin(verified.email, input.provider, input.schedule);
    return json({ token, email: verified.email }, { headers });
  }

  if (input.op === 'update') {
    const found = await updateScheduleByToken(input.token, input.schedule);
    if (!found) return json({ error: 'Unknown token' }, { status: 404, headers });
    return json({ ok: true }, { headers });
  }

  // cancel — idempotent: cancelling an already-gone opt-in succeeds.
  await deleteByToken(input.token);
  return json({ ok: true }, { headers });
}
