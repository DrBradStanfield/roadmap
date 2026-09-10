/**
 * US-09 — server-api calls that need Brad's server must no-op on the GitHub
 * Pages build, so the Pages bundle never ships the fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loadApi(shopify: boolean) {
  vi.resetModules();
  vi.doMock('./build-flags', () => ({ SHOPIFY_SURFACE: shopify, LOCAL_FIRST: true }));
  return import('./server-api');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./build-flags');
  vi.resetModules();
});

describe('sendFeedback', () => {
  it('reports failure without fetching on the Pages build', async () => {
    const fetchMock = stubFetch();
    const { sendFeedback } = await loadApi(false);
    await expect(sendFeedback('a@b.com', 'hi')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the app proxy on the Shopify surface', async () => {
    const fetchMock = stubFetch();
    const { sendFeedback } = await loadApi(true);
    await expect(sendFeedback('a@b.com', 'hi')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/apps/health-tool-1/api/feedback');
  });
});

describe('A/B tracking', () => {
  it('does not fetch on the Pages build even with an assignment stored', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'hr_ab' ? '{"tests":{"t1":"v1"}}' : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const { trackABImpression, trackABConversion } = await loadApi(false);
    trackABImpression();
    trackABConversion();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
