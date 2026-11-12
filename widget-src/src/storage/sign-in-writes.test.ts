/**
 * US-09 AC45: once a log-off has begun, nothing saves a cloud sign-in. Each
 * Dropbox and Google Drive write of a token or an account is tried after
 * beginRoadmapLogOff, and, as a control, before it. Synthetic tokens; no
 * network. A fresh module graph per test is a fresh page, so the log-off latch
 * starts open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DROPBOX = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_PKCE = 'health_roadmap_dropbox_pkce';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = {
  clientId: 'test-client-id',
  scope: `openid email ${DRIVE_SCOPE}`,
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DRIVE_CONFIG = 'health_roadmap_gdrive';
const DRIVE_PKCE = 'health_roadmap_gdrive_pkce';
const EXPIRED = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 0 };

let local: Map<string, string>;
function storage(s: Map<string, string>): Storage {
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({ email: 'b@example.com', email_verified: true })}.sig`;
const read = (key: string) => JSON.parse(local.get(key) ?? 'null');

/** The page as a provider returns it: our PKCE entry in place, `?code` in the URL. */
function returningFrom(pkceKey: string): void {
  vi.stubGlobal('sessionStorage', storage(new Map([[pkceKey, JSON.stringify({ verifier: 'v', state: 's' })]])));
  vi.stubGlobal('window', {
    location: { search: `?code=c&state=s&scope=${encodeURIComponent(DRIVE_SCOPE)}` },
    history: { replaceState: vi.fn() },
  });
}

/** Begin a log-off on this page, or not (the control). */
async function page(logOffBegun: boolean): Promise<void> {
  if (!logOffBegun) return;
  const { beginRoadmapLogOff } = await import('./web-record-host');
  beginRoadmapLogOff();
}

beforeEach(() => {
  vi.resetModules();
  local = new Map();
  vi.stubGlobal('localStorage', storage(local));
});
afterEach(() => { vi.unstubAllGlobals(); });

const CASES: [string, boolean][] = [['once log-off has begun', true], ['control: before log-off', false]];

describe('US-09 AC45: once log-off has begun, Dropbox and Google Drive save no sign-in', () => {
  it.each(CASES)('Dropbox code exchange, %s', async (_name, logOffBegun) => {
    returningFrom(DROPBOX_PKCE);
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 })));
    await page(logOffBegun);
    const { DropboxAdapter } = await import('./dropbox');
    await DropboxAdapter.completeRedirect(DROPBOX);
    if (logOffBegun) expect(local.has(DROPBOX_TOKENS)).toBe(false);
    else expect(read(DROPBOX_TOKENS)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
  });

  it.each(CASES)('Dropbox token refresh, %s', async (_name, logOffBegun) => {
    local.set(DROPBOX_TOKENS, JSON.stringify(EXPIRED));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('oauth2/token')
      ? json({ access_token: 'at-new', expires_in: 14400 })
      : json({ email: 'a@example.com', email_verified: true }))));
    await page(logOffBegun);
    const { DropboxAdapter } = await import('./dropbox');
    await new DropboxAdapter(DROPBOX).accountEmail();
    expect(read(DROPBOX_TOKENS).accessToken).toBe(logOffBegun ? 'at-old' : 'at-new');
  });

  it.each(CASES)('Google Drive code exchange, %s', async (_name, logOffBegun) => {
    returningFrom(DRIVE_PKCE);
    vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600, idToken })));
    await page(logOffBegun);
    const { GoogleDriveAdapter } = await import('./drive');
    await GoogleDriveAdapter.completeRedirect(DRIVE);
    if (logOffBegun) {
      expect([local.has(DRIVE_TOKENS), local.has(DRIVE_CONFIG)]).toEqual([false, false]);
    } else {
      expect(read(DRIVE_TOKENS)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
      expect(read(DRIVE_CONFIG)).toEqual({ accountEmail: 'b@example.com' });
    }
  });

  it.each(CASES)('Google Drive token refresh, %s', async (_name, logOffBegun) => {
    local.set(DRIVE_TOKENS, JSON.stringify(EXPIRED));
    local.set(DRIVE_CONFIG, JSON.stringify({ accountEmail: 'a@example.com' }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken: 'at-new', expiresIn: 3600, idToken })));
    await page(logOffBegun);
    const { GoogleDriveAdapter } = await import('./drive');
    expect(await new GoogleDriveAdapter(DRIVE).tryServerRefresh()).toBe(true);
    expect(read(DRIVE_TOKENS).accessToken).toBe(logOffBegun ? 'at-old' : 'at-new');
    expect(read(DRIVE_CONFIG)).toEqual({ accountEmail: logOffBegun ? 'a@example.com' : 'b@example.com' });
  });

  it.each(CASES)('Google Drive file-id cache, %s', async (_name, logOffBegun) => {
    // A legacy single-file slot is folded into the per-name map on construction: a config write.
    local.set(DRIVE_CONFIG, JSON.stringify({ fileId: 'file-1' }));
    const before = local.get(DRIVE_CONFIG);
    await page(logOffBegun);
    const { GoogleDriveAdapter } = await import('./drive');
    new GoogleDriveAdapter(DRIVE);
    if (logOffBegun) expect(local.get(DRIVE_CONFIG)).toBe(before);
    else expect(read(DRIVE_CONFIG)).toMatchObject({ fileIds: { 'health-roadmap.json': 'file-1' } });
  });
});
