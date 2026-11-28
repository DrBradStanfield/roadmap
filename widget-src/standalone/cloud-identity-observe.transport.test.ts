// @vitest-environment jsdom
/**
 * US-09 AC67: through the real event transport (server-api's trackProductEvent),
 * with only fetch stubbed. The posted bodies hold closed words alone, and the
 * run stores nothing but its day key and the existing anonymous visitor id
 * (`hr_vid`), which the event send creates when this browser has none.
 * Fake, low-entropy tokens only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { GoogleDriveAdapter } from '../src/storage';
import { bootSignIn } from '../src/storage/sign-in-state';
import { IDENTITY_DAY_KEY, observeCloudIdentity } from './cloud-identity-observe';

const EVENTS_URL = '/apps/health-tool-1/api/events';
const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('https://www.googleapis.com/drive/v3/about')) return new Response(JSON.stringify({ user: { permissionId: 'test-perm-id', emailAddress: 'a@example.test' } }), { status: 200 });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files')) return new Response(JSON.stringify({ files: [{ ownedByMe: true, id: 'test-file-id' }] }), { status: 200 });
  return new Response('{}', { status: 200 });
});
const snapshot = (s: Storage) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
const posted = () => fetchMock.mock.calls.filter(([u]) => String(u) === EVENTS_URL).map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('observeCloudIdentity through the real transport (US-09 AC67)', () => {
  it('posts the exact closed metadata and stores only the day key and the visitor id', async () => {
    localStorage.setItem('health_roadmap_gdrive', JSON.stringify({}));
    localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'test-token-good', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000 }));
    localStorage.setItem('health_roadmap_backend', 'google-drive');
    bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
    const adapter = new GoogleDriveAdapter({ clientId: 'c', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/x' });
    const before = snapshot(localStorage);

    await observeCloudIdentity(adapter);
    await vi.waitFor(() => expect(posted()).toHaveLength(2));

    const visitorId = localStorage.getItem('hr_vid');
    expect(visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted()).toEqual([
      { eventName: 'cloud_identity_read', visitorId, metadata: { provider: 'google-drive', grant: 'refreshable', outcome: 'ok' } },
      { eventName: 'drive_record_copies', visitorId, metadata: { outcome: 'ok', owned: '1', notOwned: '0' } },
    ]);
    expect(snapshot(localStorage)).toEqual({ ...before, [`${IDENTITY_DAY_KEY}google-drive`]: new Date().toISOString().slice(0, 10), hr_vid: visitorId });
    expect(snapshot(sessionStorage)).toEqual({});
  });
});
