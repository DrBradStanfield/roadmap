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
    const { trackProductEvent } = await import('./server-api');
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
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('chat_opened');
    trackProductEvent('chat_opened');
    trackProductEvent('results_viewed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('US-61 AC8 — counts a US product event once per product per tab, sending the product alone', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('us_product_shown', { product: 'microvitamin_plus' });
    trackProductEvent('us_product_shown', { product: 'microvitamin_plus' });
    trackProductEvent('us_product_shown', { product: 'sleep' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const metadata = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).metadata);
    expect(metadata).toEqual([{ product: 'microvitamin_plus' }, { product: 'sleep' }]);
  });

  it('US-62 AC2 — counts each onboarding step once per tab, so three steps in one tab all arrive', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('onboarding_step', { step: 'measurements' });
    trackProductEvent('onboarding_step', { step: 'sex' });
    trackProductEvent('onboarding_step', { step: 'birth' });
    trackProductEvent('onboarding_step', { step: 'sex' }); // a re-answered step counts once
    const metadata = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).metadata);
    expect(metadata).toEqual([{ step: 'measurements' }, { step: 'sex' }, { step: 'birth' }]);
  });

  it('US-62 AC2 — counts sign-in and guide opens once per placement per tab', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('signin_opened', { placement: 'top_bar' });
    trackProductEvent('signin_opened', { placement: 'top_bar' });
    trackProductEvent('signin_opened', { placement: 'plan_panel' });
    trackProductEvent('guide_opened', { placement: 'header' });
    trackProductEvent('guide_opened', { placement: 'footer' });
    trackProductEvent('guide_opened', { placement: 'header' });
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent.map((b) => [b.eventName, b.metadata.placement])).toEqual([
      ['signin_opened', 'top_bar'], ['signin_opened', 'plan_panel'], ['guide_opened', 'header'], ['guide_opened', 'footer'],
    ]);
  });

  it('US-09 AC22 — counts a cloud-connect outcome once per provider per tab, so a second provider is not dropped', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('cloud_connect_cancelled', { provider: 'dropbox' });
    trackProductEvent('cloud_connect_cancelled', { provider: 'dropbox' });
    trackProductEvent('cloud_connect_cancelled', { provider: 'google-drive' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends every upload outcome, so a second upload in the tab still counts (US-12 AC10)', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('upload_outcome', { picked: 2, withValues: 2 });
    trackProductEvent('upload_outcome', { picked: 1, openFailed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.metadata).toEqual({ picked: 1, openFailed: 1 });
  });

  it('US-35 AC17 — counts a refused measurement once per metric and refusal word, not once per tab', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('measurement_refused', { metric: 'ldl', refusal: 'invalid-value' });
    trackProductEvent('measurement_refused', { metric: 'ldl', refusal: 'invalid-value' });
    trackProductEvent('measurement_refused', { metric: 'psa', refusal: 'invalid-value' });
    trackProductEvent('measurement_refused', { refusal: 'unknown-metric' });
    expect(fetchMock.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string).metadata)).toEqual([
      { metric: 'ldl', refusal: 'invalid-value' }, { metric: 'psa', refusal: 'invalid-value' }, { refusal: 'unknown-metric' },
    ]);
  });

  // Codex R1 2026-10-20: dropping `metric` from an out-of-range row must not
  // collapse the throttle, so the metric stays in the LOCAL key only.
  it('US-35 AC17 — counts two out-of-range metrics as two events, neither sending its metric', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('measurement_refused', { refusal: 'out-of-range' }, 'weight');
    trackProductEvent('measurement_refused', { refusal: 'out-of-range' }, 'weight');
    trackProductEvent('measurement_refused', { refusal: 'out-of-range' }, 'psa');
    const bodies = fetchMock.mock.calls.map(c => (c[1] as RequestInit).body as string);
    expect(bodies.map(b => JSON.parse(b).metadata)).toEqual([{ refusal: 'out-of-range' }, { refusal: 'out-of-range' }]);
    expect(bodies.join()).not.toMatch(/weight|psa/);
  });

  it('sends allow-listed metadata when given', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.metadata).toEqual({ provider: 'dropbox' });
  });

  it('sends the backend a remote change came in on (US-34)', async () => {
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('remote_change_applied', { backend: 'local' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.metadata).toEqual({ backend: 'local' });
  });
});

describe('trackProductEvent on the Pages build (no Brad server)', () => {
  it('is a strict no-op', async () => {
    vi.resetModules();
    vi.doMock('./build-flags', () => ({ SHOPIFY_SURFACE: false, LOCAL_FIRST: true }));
    const fetchMock = stubBrowserGlobals();
    const { trackProductEvent } = await import('./server-api');
    trackProductEvent('chat_opened');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
