import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Sentry — api.ts imports it at module load.
vi.mock('./sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

// trackProductEvent must ONLY fire on the Shopify surface — the Pages build
// has no Brad server. Each describe re-imports api.ts under a different
// build-flags mock (the flags are module-load constants).

function stubBrowserGlobals() {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('./build-flags');
});

describe('trackProductEvent on the Shopify surface', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('./build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
    fetchMock = stubBrowserGlobals();
  });

  it('POSTs the event with the visitor id', async () => {
    const { trackProductEvent } = await import('./api');
    trackProductEvent('chat_opened');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/apps/health-tool-1/api/events');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.eventName).toBe('chat_opened');
    expect(typeof body.visitorId).toBe('string');
    expect(body.visitorId.length).toBeGreaterThan(0);
  });

  it('throttles to once per event name per tab session', async () => {
    const { trackProductEvent } = await import('./api');
    trackProductEvent('chat_opened');
    trackProductEvent('chat_opened');
    trackProductEvent('results_viewed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends allow-listed metadata when given', async () => {
    const { trackProductEvent } = await import('./api');
    trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.metadata).toEqual({ provider: 'dropbox' });
  });
});

describe('trackProductEvent on the Pages build (no Brad server)', () => {
  it('is a strict no-op', async () => {
    vi.resetModules();
    vi.doMock('./build-flags', () => ({ SHOPIFY_SURFACE: false, LOCAL_FIRST: true }));
    const fetchMock = stubBrowserGlobals();
    const { trackProductEvent } = await import('./api');
    trackProductEvent('chat_opened');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
