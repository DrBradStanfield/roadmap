import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { z } from 'zod';
import { createRateLimiter } from '../lib/rate-limiter';
import { ALLOWED_ORIGINS, corsHeaders, getClientIp, parseSimpleRequestJson } from '../lib/local-first-route.server';

/**
 * Stateless Google OAuth token exchange for the local-first Drive backend
 * (decision record §14). Google refuses refresh tokens to browser-only apps —
 * the code/refresh exchange requires the client secret, which only this server
 * can hold. This route does exactly one thing: forward the exchange to Google
 * with the secret attached and hand the result straight back to the browser.
 *
 * PRIVACY INVARIANTS — keep these true:
 *  - STORES NOTHING. No DB, no session, no token ever written or logged.
 *  - The refresh token lives in the USER's browser, not here.
 *  - This server never reads the user's Drive (the browser does that directly).
 *
 * Not behind the Shopify app proxy: it serves the GitHub Pages / self-host
 * front door cross-origin, so access control is the CORS allow-list + rate
 * limit. The secret cannot be extracted through it — the endpoint only ever
 * returns tokens for an auth code/refresh token the caller already possesses.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Generous: a real user exchanges ~once an hour; connects are rare.
const allowRequest = createRateLimiter(30, 60_000, 10 * 60_000);

const bodySchema = z.union([
  z.object({
    grantType: z.literal('code'),
    code: z.string().min(1).max(2048),
    codeVerifier: z.string().min(1).max(256),
    redirectUri: z.string().url().max(512),
  }),
  z.object({
    grantType: z.literal('refresh'),
    refreshToken: z.string().min(1).max(2048),
  }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json({ error: 'POST only' }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request }: ActionFunctionArgs) {
  const headers = corsHeaders(request);
  // Defense-in-depth: unreachable under remix-serve (it 405s OPTIONS before
  // route handlers run — see the body-parse comment) but kept in case the
  // server stack ever changes.
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers });

  // Cross-origin callers must be on the allow-list (browsers enforce the CORS
  // response; this server-side check also rejects spoofed/missing origins).
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403, headers });
  }

  if (!allowRequest(getClientIp(request))) {
    return Response.json({ error: 'Too many requests' }, { status: 429, headers });
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_SECRET;
  if (!clientId || !clientSecret) {
    return Response.json({ error: 'Google Drive exchange is not configured' }, { status: 503, headers });
  }

  const parsed = bodySchema.safeParse(await parseSimpleRequestJson(request));
  if (!parsed.success) return Response.json({ error: 'Invalid input' }, { status: 400, headers });

  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  if (parsed.data.grantType === 'code') {
    params.set('grant_type', 'authorization_code');
    params.set('code', parsed.data.code);
    params.set('code_verifier', parsed.data.codeVerifier);
    params.set('redirect_uri', parsed.data.redirectUri);
  } else {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', parsed.data.refreshToken);
  }

  const googleRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const payload = (await googleRes.json().catch(() => ({}))) as Record<string, unknown>;

  if (!googleRes.ok) {
    // Pass Google's machine-readable error through (e.g. invalid_grant so the
    // client knows to re-auth) — never log it (it can reference the token).
    return Response.json(
      { error: String(payload.error ?? 'exchange_failed'), errorDescription: String(payload.error_description ?? '') },
      { status: googleRes.status, headers },
    );
  }

  // Whitelist the fields the client needs — nothing else passes through.
  return Response.json(
    {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token, // present on code exchange only
      expiresIn: payload.expires_in,
      // Signed ID token (present when the grant includes openid). The browser
      // forwards it to the reminders opt-in as proof of the verified email —
      // this endpoint still stores nothing.
      idToken: payload.id_token,
    },
    { headers },
  );
}
