import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-17 AC7a: a Google Drive opt-in that cannot be verified because Google
// itself failed (5xx, 429, or no answer) is reported to Sentry, so an outage
// that blocks every Google opt-in is visible. A token Google rejects (4xx),
// a token for another app and an unverified email are the user's case: still
// null, still silent. The caller sees null either way. Synthetic HTTP only.

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => sentry);
vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

import { verifyGoogleIdToken } from './reminder-v2.server';

const CLIENT = 'synthetic-client.apps.googleusercontent.com';
const claims = (over: Record<string, string> = {}) =>
  new Response(JSON.stringify({ aud: CLIENT, email: 'Synthetic@Example.invalid', email_verified: 'true', ...over }));

beforeEach(() => {
  vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', CLIENT);
  sentry.captureException.mockClear();
  sentry.captureMessage.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const answer = (res: Response | Error) =>
  vi.stubGlobal('fetch', vi.fn(async () => { if (res instanceof Error) throw res; return res; }));
const reports = () => sentry.captureException.mock.calls.length + sentry.captureMessage.mock.calls.length;

describe('verifyGoogleIdToken: a Google failure is reported', () => {
  it.each([500, 503, 429])('Google answering %i is null and reported once', async (status) => {
    answer(new Response('synthetic outage', { status }));
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBeNull();
    expect(reports()).toBe(1);
    expect(sentry.captureMessage.mock.calls[0][1]).toMatchObject({ level: 'warning', tags: { feature: 'reminders_v2' }, extra: { status } });
  });

  it('a network failure is null and reported once', async () => {
    const failure = new TypeError('fetch failed');
    answer(failure);
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][0]).toBe(failure);
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({ tags: { feature: 'reminders_v2' } });
  });
});

describe('verifyGoogleIdToken: the user\'s own case stays silent', () => {
  it.each([400, 401])('Google rejecting the token (%i) is null and not reported', async (status) => {
    answer(new Response('{"error":"invalid_token"}', { status }));
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBeNull();
    expect(reports()).toBe(0);
  });

  it('a token for another app is null and not reported', async () => {
    answer(claims({ aud: 'someone-else' }));
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBeNull();
    expect(reports()).toBe(0);
  });

  it('an unverified email is null and not reported', async () => {
    answer(claims({ email_verified: 'false' }));
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBeNull();
    expect(reports()).toBe(0);
  });

  it('a good token still returns the lower-cased email', async () => {
    answer(claims());
    expect(await verifyGoogleIdToken('synthetic-id-token')).toBe('synthetic@example.invalid');
    expect(reports()).toBe(0);
  });
});
