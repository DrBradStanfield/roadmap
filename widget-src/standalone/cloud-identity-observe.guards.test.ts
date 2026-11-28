// @vitest-environment jsdom
/**
 * US-09 AC67: the three guards the AC promises, each pinned so the test fails
 * if its guard is deleted. A log-off and a write stop are one-way for a page,
 * so each test loads fresh modules. Fake, low-entropy tokens only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
const { trackProductEvent } = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/server-api', async (real) => ({ ...(await real<object>()), trackProductEvent }));

const DAY_KEY = 'hr_cloud_identity_day_google-drive';
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { permissionId: 'p' }, files: [] }), { status: 200 }));

/** Fresh modules, a Drive sign-in with an unexpired token, and the page's adapter. */
async function load() {
  vi.resetModules();
  localStorage.setItem('health_roadmap_gdrive', JSON.stringify({}));
  localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000 }));
  localStorage.setItem('health_roadmap_backend', 'google-drive');
  const storage = await import('../src/lib/storage');
  const signIn = await import('../src/storage/sign-in-state');
  const { GoogleDriveAdapter } = await import('../src/storage');
  const { observeCloudIdentity } = await import('./cloud-identity-observe');
  signIn.bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
  const adapter = new GoogleDriveAdapter({ clientId: 'c', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/x' });
  return { storage, signIn, adapter, observe: () => observeCloudIdentity(adapter) };
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  trackProductEvent.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('US-09 AC67 guards', () => {
  it('control: the same page with no guard tripped reads', async () => {
    const page = await load();
    await page.observe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a signed-out page with an unexpired Drive token sends skipped and makes no fetch', async () => {
    const page = await load();
    page.signIn.signInEnded('google-drive', null); // the page's sign-in ends; the token is still unexpired
    expect(page.signIn.isSignedOut('google-drive')).toBe(true);
    expect(page.adapter.heldToken().token).toBe('test-token-good');
    await page.observe();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackProductEvent.mock.calls).toEqual([['cloud_identity_read', { provider: 'google-drive', grant: 'refreshable', outcome: 'skipped' }]]);
  });

  it('a log-off begun before the run: no key, no event, no fetch', async () => {
    const page = await load();
    page.storage.newLogOffId();
    // Put the old log-off id back, so the write-stop guard alone would let this run: only the log-off claim stops it.
    localStorage.removeItem('health_roadmap_log_off_id');
    expect(page.storage.healthWritesAllowed()).toBe(true);
    await page.observe();
    expect(localStorage.getItem(DAY_KEY)).toBeNull();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a page whose health writes are stopped: no key, no event, no fetch', async () => {
    const page = await load();
    page.storage.stopLocalHealthWrites();
    expect(page.storage.ownLogOffHasBegun()).toBe(false);
    await page.observe();
    expect(localStorage.getItem(DAY_KEY)).toBeNull();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
