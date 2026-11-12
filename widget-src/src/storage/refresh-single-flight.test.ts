/**
 * US-09 AC47: one sign-in refresh at a time per page and sign-in, on the real
 * adapters; and Google Drive forgets a sign-in only when Google says
 * `invalid_grant`. Before, every caller with an expired token posted its own
 * refresh, and a late refusal beside a success deleted the working sign-in.
 * Synthetic tokens and providers; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropboxAdapter } from './dropbox';
import { GoogleDriveAdapter } from './drive';

const DRIVE = {
  clientId: 'test-client-id',
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const DROPBOX = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
const DRIVE_TOKENS = 'health_roadmap_gdrive_tokens';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeIdToken(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}

/**
 * A fake network. Token POSTs (to `tokenUrl`) wait until `release`, then get
 * `token()`'s answer; every other call gets `other()` and has its bearer
 * recorded.
 */
function network(tokenUrl: string, token: (n: number) => Response, other: (url: string) => Response = () => json({}, 404)) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const bearers: string[] = [];
  let tokenPosts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === tokenUrl) {
      const n = ++tokenPosts;
      await gate;
      return token(n);
    }
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth) bearers.push(auth);
    return other(String(url));
  }));
  return { release: () => release(), tokenPosts: () => tokenPosts, bearers };
}

function seedDrive(refreshToken = 'test-refresh-a') {
  local.set(DRIVE_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken, expiresAt: 0 }));
  local.set('health_roadmap_gdrive', JSON.stringify({}));
}
function seedDropbox(refreshToken = 'test-refresh-a') {
  local.set(DROPBOX_TOKENS, JSON.stringify({ accessToken: 'test-token-old', refreshToken, expiresAt: 0 }));
}
const driveTokens = () => JSON.parse(local.get(DRIVE_TOKENS) ?? 'null') as { accessToken: string; refreshToken?: string } | null;

beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', storage(local));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('US-09 AC47: Google Drive refreshes once per page and sign-in', () => {
  it('a record read and a document write at once make ONE post to the exchange, and both use its token', async () => {
    seedDrive();
    const net = network(DRIVE.exchangeUrl, () => json({ accessToken: 'test-token-good', expiresIn: 3600 }));
    const adapter = new GoogleDriveAdapter(DRIVE);
    const read = adapter.read('health-roadmap.json').catch(() => undefined);
    const write = adapter.writeDocument('Lab results/test.pdf', new Blob(['x'])).catch(() => undefined);
    await flush();
    net.release();
    await Promise.all([read, write]);
    expect(net.tokenPosts()).toBe(1);
    expect(net.bearers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(net.bearers)).toEqual(new Set(['Bearer test-token-good']));
  });

  it("a store read and a reminder's ID-token call on a second adapter make ONE post, and the reminder gets its ID token", async () => {
    seedDrive();
    const idToken = fakeIdToken({ email: 'user@example.com', email_verified: true });
    const net = network(DRIVE.exchangeUrl, () => json({ accessToken: 'test-token-good', expiresIn: 3600, idToken }));
    const read = new GoogleDriveAdapter(DRIVE).read('health-roadmap.json').catch(() => undefined);
    const reminder = new GoogleDriveAdapter(DRIVE).getReminderIdToken();
    await flush();
    net.release();
    await read;
    expect(await reminder).toBe(idToken);
    expect(net.tokenPosts()).toBe(1);
  });

  it('one 200 and a late 400 cannot both happen for one token: one post, and the grant is kept', async () => {
    seedDrive();
    const net = network(DRIVE.exchangeUrl, (n) => n === 1
      ? json({ accessToken: 'test-token-good', expiresIn: 3600 })
      : json({ error: 'invalid_grant' }, 400));
    const one = new GoogleDriveAdapter(DRIVE).tryServerRefresh();
    const two = new GoogleDriveAdapter(DRIVE).tryServerRefresh();
    await flush();
    net.release();
    expect([await one, await two]).toEqual([true, true]);
    expect(net.tokenPosts()).toBe(1);
    expect(driveTokens()).toMatchObject({ accessToken: 'test-token-good', refreshToken: 'test-refresh-a' });
  });

  it('a refresh begun before a new sign-in is never joined after it: the new grant posts its own', async () => {
    seedDrive('test-refresh-a');
    const net = network(DRIVE.exchangeUrl, (n) => json({ accessToken: `test-token-${n}`, expiresIn: 3600 }));
    const before = new GoogleDriveAdapter(DRIVE).tryServerRefresh();
    await flush();
    seedDrive('test-refresh-b'); // a sign-in on another adapter
    const after = new GoogleDriveAdapter(DRIVE).tryServerRefresh();
    await flush();
    net.release();
    expect(await before).toBe(false); // AC2f: the old grant's answer is not kept
    expect(await after).toBe(true);
    expect(net.tokenPosts()).toBe(2);
    expect(driveTokens()).toMatchObject({ refreshToken: 'test-refresh-b' });
  });
});

describe('US-09 AC47: Google Drive forgets a sign-in only on invalid_grant', () => {
  it('a 400 invalid_grant clears the tokens; the refresh is "none"', async () => {
    seedDrive();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_grant', errorDescription: 'Token has been expired or revoked.' }, 400)));
    await expect(new GoogleDriveAdapter(DRIVE).tryServerRefresh()).resolves.toBe(false);
    expect(local.has(DRIVE_TOKENS)).toBe(false);
  });

  it.each([
    ['a 400 with another error', () => json({ error: 'invalid_request' }, 400)],
    ['a 401 without invalid_grant', () => json({ error: 'unauthorized_client' }, 401)],
    ['a 401 with no readable body', () => new Response('<html>no</html>', { status: 401 })],
  ])('%s keeps the tokens; the refresh is still "none", so the page falls back as before', async (_label, answer) => {
    seedDrive();
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    await expect(new GoogleDriveAdapter(DRIVE).tryServerRefresh()).resolves.toBe(false);
    expect(driveTokens()).toMatchObject({ refreshToken: 'test-refresh-a' });
    await expect(new GoogleDriveAdapter(DRIVE).getReminderIdToken()).resolves.toBeNull();
  });

  it('a network error keeps the tokens and is transient', async () => {
    seedDrive();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('test-network-down'); }));
    await expect(new GoogleDriveAdapter(DRIVE).tryServerRefresh()).resolves.toBe(false);
    expect(driveTokens()).toMatchObject({ refreshToken: 'test-refresh-a' });
    await expect(new GoogleDriveAdapter(DRIVE).getReminderIdToken()).rejects.toThrow('retry later');
  });
});

describe('US-09 AC47: Dropbox refreshes once per page and sign-in', () => {
  it("a read and the watch's list at once make ONE token post, and both use its token", async () => {
    seedDropbox();
    const net = network(DROPBOX_TOKEN_URL, () => json({ access_token: 'test-token-good', expires_in: 14_400 }),
      (url) => url.includes('list_folder') && !url.includes('longpoll') ? json({ cursor: 'test-cursor', entries: [] }) : json({}, 409));
    const adapter = new DropboxAdapter(DROPBOX);
    const stop = new AbortController();
    adapter.watch('health-roadmap.json', () => undefined, stop.signal);
    const read = adapter.read('health-roadmap.json').catch(() => undefined);
    await flush();
    net.release();
    await read;
    await flush();
    stop.abort();
    expect(net.tokenPosts()).toBe(1);
    expect(net.bearers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(net.bearers)).toEqual(new Set(['Bearer test-token-good']));
  });

  it("a store read and the reminders' email read on a second adapter make ONE token post", async () => {
    seedDropbox();
    const net = network(DROPBOX_TOKEN_URL, () => json({ access_token: 'test-token-good', expires_in: 14_400 }),
      (url) => url.includes('get_current_account') ? json({ email: 'user@example.com', email_verified: true }) : json({}, 409));
    const read = new DropboxAdapter(DROPBOX).read('health-roadmap.json').catch(() => undefined);
    const email = new DropboxAdapter(DROPBOX).accountEmail();
    await flush();
    net.release();
    await read;
    expect(await email).toBe('user@example.com');
    expect(net.tokenPosts()).toBe(1);
  });
});
