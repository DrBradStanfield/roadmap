/**
 * US-17 AC7 — the Drive lane's reminder identity never costs a credential.
 *
 * The ONLY thing the adapter hands the reminders opt-in is a signed ID token
 * (which grants nothing) or the account email decoded from one. The old
 * fallback — a GIS popup whose Drive ACCESS token went to Brad's server as
 * proof — is gone, and this test is what keeps it gone: with a READY GIS
 * client in scope, no path here may reach it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter, decodeIdTokenEmail } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};

const initTokenClient = vi.fn(() => ({ requestAccessToken: vi.fn() }));

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

function fakeIdToken(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}

describe('decodeIdTokenEmail', () => {
  it('reads a verified email from the payload', () => {
    expect(decodeIdTokenEmail(fakeIdToken({ email: 'User@Example.com', email_verified: true }))).toBe('user@example.com');
  });

  it('refuses an unverified email and garbage', () => {
    expect(decodeIdTokenEmail(fakeIdToken({ email: 'x@example.com', email_verified: false }))).toBeNull();
    expect(decodeIdTokenEmail('not-a-token')).toBeNull();
  });
});

describe('GoogleDriveAdapter reminder identity — no popup, no access token, ever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', makeStorage());
    // A GIS client that is READY: if any popup path were taken it would be
    // reached immediately, so "not called" means the code chose not to.
    vi.stubGlobal('window', { google: { accounts: { oauth2: { initTokenClient } } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null with no refresh token and opens NO popup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const adapter = new GoogleDriveAdapter(CONFIG);

    expect(await adapter.getReminderIdToken()).toBeNull();
    expect(adapter.accountEmail()).toBeNull();
    expect(initTokenClient).not.toHaveBeenCalled();
  });

  it('returns the fresh ID token from a refresh grant and remembers the email it names', async () => {
    localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }));
    localStorage.setItem('health_roadmap_gdrive', JSON.stringify({}));
    const idToken = fakeIdToken({ email: 'user@example.com', email_verified: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accessToken: 'a2', expiresIn: 3600, idToken }), { status: 200 })));
    const adapter = new GoogleDriveAdapter(CONFIG);

    expect(await adapter.getReminderIdToken()).toBe(idToken);
    expect(adapter.accountEmail()).toBe('user@example.com');
    expect(new GoogleDriveAdapter(CONFIG).accountEmail()).toBe('user@example.com'); // persisted
    expect(initTokenClient).not.toHaveBeenCalled();
  });
});
