/**
 * S-19 (b): every in-memory TTL map has a hard cap on keys (US-52 AC4f, US-59 AC12). When a new key
 * meets a full map, expired entries go first. A limiter never forgets a live count to make room:
 * forgetting it would let that caller start a fresh window early, so the new key is refused instead.
 * The summary cache is only a cache, so it drops its oldest entry and the next read fetches again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const T0 = 1_000_000;
const W = 1000;
const NEVER = 100 * W; // a sweep interval that never fires in these tests

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('US-52 AC4f: createRateLimiter holds at most its key cap', () => {
  it('refuses a new key when every tracked key is live, and keeps every block it holds', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, NEVER, 3);
    for (const key of ['a', 'b', 'c']) {
      expect(limit(key)).toBe(true);
      expect(limit(key)).toBe(false); // blocked
    }
    expect(limit('d')).toBe(false); // full of live entries: refused, not admitted
    for (const key of ['a', 'b', 'c']) expect(limit(key)).toBe(false); // no block forgotten
  });

  it('makes room from expired entries first, in expiry order, a renewed key included', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, NEVER, 3);
    limit('a'); // T0, expires T0+W
    vi.setSystemTime(T0 + 10);
    limit('b'); // expires T0+W+10
    vi.setSystemTime(T0 + 20);
    limit('c'); // expires T0+W+20
    vi.setSystemTime(T0 + W);
    expect(limit('a')).toBe(true); // a's fresh window, expires T0+2W
    vi.setSystemTime(T0 + W + 10); // b has expired; a, renewed, has not
    expect(limit('d')).toBe(true); // room made from b
    expect(limit('a')).toBe(false); // a's renewed window still blocks
    expect(limit('c')).toBe(false); // c's window still blocks
    expect(limit('e')).toBe(false); // full again of live entries
  });

  it('caps every limiter at 50,000 keys unless told otherwise', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, NEVER);
    for (let i = 0; i < 50_000; i++) expect(limit(`ip-${i}`)).toBe(true);
    expect(limit('one-more')).toBe(false);
    vi.setSystemTime(T0 + W);
    expect(limit('one-more')).toBe(true); // the expired ones made room
  });
});

describe('US-52 AC4f: createQuotaCounter holds at most its key cap', () => {
  it('refuses take and reserve for a new key when full of live ones, and says it has none left', async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const quota = createQuotaCounter(5, W, NEVER, 2);
    expect(quota.take('a', 1)).toBe(true);
    expect(quota.take('b', 5)).toBe(true);
    expect(quota.take('c', 1)).toBe(false);
    expect(quota.reserve('c', 1)).toBeNull();
    expect(quota.remaining('c')).toBe(0); // what a take would allow
    expect(quota.remaining('a')).toBe(4);
    expect(quota.remaining('b')).toBe(0); // b's used-up day is kept
    expect(quota.take('a', 1)).toBe(true); // a known key still spends its own window
  });

  it('admits a new key once an expired entry can make room', async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const quota = createQuotaCounter(5, W, NEVER, 2);
    quota.take('a', 1);
    vi.setSystemTime(T0 + 10);
    quota.take('b', 5);
    vi.setSystemTime(T0 + W); // a has expired, b has not
    expect(quota.remaining('c')).toBe(5);
    expect(quota.take('c', 2)).toBe(true);
    expect(quota.remaining('b')).toBe(0);
  });

  it('a web chat turn refused because the IP map is full spends none of the machine budget', async () => {
    const { webChatTurns, takeWebChatTurn } = await import('./rate-limiter');
    webChatTurns.ip.reset();
    webChatTurns.machine.reset();
    for (let i = 0; i < 50_000; i++) webChatTurns.ip.take(`ip-${i}`, 1);
    const before = webChatTurns.machine.remaining('machine');
    expect(takeWebChatTurn('new-ip')).toBe(false);
    expect(webChatTurns.machine.remaining('machine')).toBe(before);
    expect(takeWebChatTurn('ip-0')).toBe(true); // a known IP still has its 199
    webChatTurns.ip.reset();
    webChatTurns.machine.reset();
  });
});

describe('US-59 AC12: the subscription summary cache holds at most 10,000 customers', () => {
  const ENV = { CHAT_SUBSCRIPTION_ACTIONS: 'on', CHAT_SURFACE: 'brand', CS_GATEWAY_CHAT_URL: 'http://gateway.test:8081', CHAT_GATEWAY_SECRET: 'g'.repeat(40) };
  const REQUEST_URL = 'https://health-tool-app.fly.dev/api/chat?shop=a.myshopify.com&logged_in_customer_id=7001&timestamp=1&signature=abc';

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('drops the oldest summary for a new customer, and fetches it again when asked', async () => {
    vi.resetModules();
    const mod = await import('./subscription-gateway.server');
    const fetchMock = vi.fn(async () => Response.json({ ok: true, enabled: true, subscriptions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request(REQUEST_URL);
    for (let i = 0; i < 10_000; i++) await mod.getCachedSubscriptions(request, `c-${i}`);
    expect(fetchMock).toHaveBeenCalledTimes(10_000);
    await mod.getCachedSubscriptions(request, 'c-new'); // the cache is full: c-0 goes
    await mod.getCachedSubscriptions(request, 'c-1'); // still cached
    expect(fetchMock).toHaveBeenCalledTimes(10_001);
    await mod.getCachedSubscriptions(request, 'c-0'); // fetched again
    expect(fetchMock).toHaveBeenCalledTimes(10_002);
  });
});
