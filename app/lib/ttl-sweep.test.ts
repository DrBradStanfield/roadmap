/**
 * S-5: the in-memory TTL maps behind the rate limits (US-15 AC45 web chat turns, US-35 AC10 the
 * per-machine file cap, US-52 AC4a) and the subscription summary cache (US-59). No path may end with
 * no limit: an entry is never served past its expiry, even between sweeps, and the sweep brings
 * each map back to what is live. These pins observe the factories' own maps (a Map subclass
 * stubbed in while they are built), so they hold for the old per-file sweeps and the shared one.
 *
 * One expiry rule for all three (S-19, US-52 AC4f): an entry is live until its expiry instant and
 * not at it, so a window of W ms is exactly W ms long. The sweep keeps a map to the keys written in
 * the last `ttl + sweep interval`; the hard cap on keys is pinned in ttl-bound.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
// sweepExpired, watched, so a pin can find the timer a module's own map was given (S-19 c).
vi.mock('./rate-limiter', async (importOriginal) => {
  const real = await importOriginal<typeof import('./rate-limiter')>();
  return { ...real, sweepExpired: vi.fn(real.sweepExpired) };
});

const T0 = 1_000_000;
const OPTS = { name: 'test map' };
const created: Map<unknown, unknown>[] = [];
class TrackingMap<K, V> extends Map<K, V> {
  constructor(entries?: readonly (readonly [K, V])[] | null) {
    super(entries);
    created.push(this as Map<unknown, unknown>);
  }
}

/** Run `build` with every `new Map` recorded; returns what it built and the maps it made. */
async function tracked<T>(build: () => T | Promise<T>): Promise<{ value: T; maps: Map<unknown, unknown>[] }> {
  created.length = 0;
  vi.stubGlobal('Map', TrackingMap);
  try {
    const value = await build();
    return { value, maps: [...created] };
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('S-5: createRateLimiter', () => {
  const W = 1000;
  const SWEEP = 500;

  it('never counts a request against a window at or past its end, between sweeps too (US-52 AC4f)', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, 10 * W, OPTS); // the sweep never runs in this test
    expect(limit('k')).toBe(true);
    expect(limit('k')).toBe(false);
    vi.setSystemTime(T0 + W - 1); // the window's last instant still counts
    expect(limit('k')).toBe(false);
    vi.setSystemTime(T0 + W); // its expiry instant is a fresh window, though no sweep has run
    expect(limit('k')).toBe(true);
  });

  it('sweeps a flood of distinct keys back to the live ones, on the same ticks', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const { value: limit, maps } = await tracked(() => createRateLimiter(5, W, SWEEP, OPTS));
    expect(maps).toHaveLength(1);
    const [map] = maps;
    for (let i = 0; i < 1000; i++) limit(`ip-${i}`);
    expect(map.size).toBe(1000); // under the key cap, a burst inside one window is held whole
    vi.advanceTimersByTime(SWEEP); // sweep at T0+SWEEP: the flood is still live
    expect(map.size).toBe(1000);
    limit('late'); // written at T0+SWEEP, live until T0+SWEEP+W
    vi.advanceTimersByTime(SWEEP); // sweep at T0+W, the flood's expiry instant (US-52 AC4f)
    expect(map.size).toBe(1);
    expect([...map.keys()]).toEqual(['late']);
  });

  it("the sweep's timer does not hold the process open", async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const spy = vi.spyOn(globalThis, 'setInterval');
    createRateLimiter(1, W, SWEEP, OPTS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(SWEEP);
    expect((spy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
  });
});

describe('S-5: createQuotaCounter', () => {
  const W = 1000;
  const SWEEP = 500;

  it('never serves a used-up window at or past its end, between sweeps too (US-52 AC4f)', async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const quota = createQuotaCounter(3, W, 10 * W, OPTS);
    expect(quota.take('k', 3)).toBe(true);
    vi.setSystemTime(T0 + W - 1);
    expect(quota.remaining('k')).toBe(0); // the window's last instant still counts
    vi.setSystemTime(T0 + W); // its expiry instant is a fresh window
    expect(quota.remaining('k')).toBe(3);
    expect(quota.take('k', 3)).toBe(true);
  });

  it('sweeps a flood of distinct keys back to the live ones, on the same ticks', async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const { value: quota, maps } = await tracked(() => createQuotaCounter(10, W, SWEEP, OPTS));
    expect(maps).toHaveLength(1);
    const [map] = maps;
    for (let i = 0; i < 1000; i++) quota.take(`ip-${i}`, 1);
    expect(map.size).toBe(1000);
    vi.advanceTimersByTime(SWEEP);
    expect(map.size).toBe(1000);
    quota.take('late', 1);
    vi.advanceTimersByTime(SWEEP); // the flood's expiry instant (US-52 AC4f)
    expect([...map.keys()]).toEqual(['late']);
  });

  it("the sweep's timer does not hold the process open", async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const spy = vi.spyOn(globalThis, 'setInterval');
    createQuotaCounter(1, W, SWEEP, OPTS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(SWEEP);
    expect((spy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
  });
});

describe('S-5: the subscription summary cache (US-59)', () => {
  const TTL = 60_000;
  const SWEEP = 5 * 60_000;
  const ENV = { CHAT_SUBSCRIPTION_ACTIONS: 'on', CHAT_SURFACE: 'brand', CS_GATEWAY_CHAT_URL: 'http://gateway.test:8081', CHAT_GATEWAY_SECRET: 'g'.repeat(40) };
  const REQUEST_URL = 'https://health-tool-app.fly.dev/api/chat?shop=a.myshopify.com&logged_in_customer_id=7001&timestamp=1&signature=abc';

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** A fresh copy of the module, built under fake timers, with its maps and its setInterval calls. */
  async function freshGateway() {
    vi.resetModules();
    const { sweepExpired } = await import('./rate-limiter');
    const { value: mod, maps } = await tracked(() => import('./subscription-gateway.server'));
    const fetchMock = vi.fn(async () => Response.json({ ok: true, enabled: true, subscriptions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    return { mod, maps, fetchMock, sweeps: vi.mocked(sweepExpired) };
  }

  it('never serves a summary past its minute, between sweeps too', async () => {
    const { mod, fetchMock } = await freshGateway();
    await mod.getCachedSubscriptions(new Request(REQUEST_URL), '7001');
    vi.setSystemTime(T0 + TTL - 1);
    await mod.getCachedSubscriptions(new Request(REQUEST_URL), '7001');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + TTL); // the expiry instant itself is not served
    await mod.getCachedSubscriptions(new Request(REQUEST_URL), '7001');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sweeps a flood of customers back to the live ones, every 5 minutes, unref\'d', async () => {
    const { mod, maps, sweeps } = await freshGateway();
    for (let i = 0; i < 300; i++) await mod.getCachedSubscriptions(new Request(REQUEST_URL), `c-${i}`);
    const cache = maps.find((m) => m.has('c-0'));
    expect(cache?.size).toBe(300);
    vi.advanceTimersByTime(SWEEP - TTL / 2); // no sweep yet: the first is at T0 + 5 minutes
    expect(cache?.size).toBe(300);
    await mod.getCachedSubscriptions(new Request(REQUEST_URL), 'late'); // live until after the first sweep
    vi.advanceTimersByTime(TTL / 2);
    expect([...cache!.keys()]).toEqual(['late']);
    // The timer handed to this cache's own sweep, found by the map itself, not by its interval (S-19 c).
    const sweep = sweeps.mock.calls.findIndex((call) => call[0] === cache);
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(sweeps.mock.calls[sweep][2]).toBe(SWEEP);
    expect((sweeps.mock.results[sweep].value as NodeJS.Timeout).hasRef()).toBe(false);
  });
});
