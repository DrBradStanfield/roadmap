/**
 * S-19 (b): the limiter maps and the subscription summary cache hold a bounded number of entries
 * (US-52 AC4f, US-59 AC12). When a new key meets a full map, expired entries go first, then the
 * oldest live entry, and the new key is admitted. A full map says so once an hour, by its name
 * alone. The in-memory maps left unbounded on purpose are a named list below; the spent-challenge
 * set is one of them, unchanged, so one-use holds for a challenge's whole life (US-52 AC1a).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/react-router';

const T0 = 1_000_000;
const W = 1000;
const NEVER = 100 * W; // a sweep interval that never fires in these tests
const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("US-52 AC4f: a full limiter map makes room from its oldest entry ('evictOldest', the default)", () => {
  it('admits a new caller when every tracked key is live; the others keep their counts', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, NEVER, { name: 'test limiter', maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) {
      expect(limit(key)).toBe(true);
      expect(limit(key)).toBe(false); // at its limit
    }
    expect(limit('d')).toBe(true); // a new caller is served
    expect(limit('d')).toBe(false); // and counted
    for (const key of ['b', 'c']) expect(limit(key)).toBe(false); // still in the map: still limited
  });

  it('makes room from expired entries first, in expiry order, a renewed key included', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(1, W, NEVER, { name: 'test limiter', maxKeys: 3 });
    limit('a'); // T0, expires T0+W
    vi.setSystemTime(T0 + 10);
    limit('b'); // expires T0+W+10
    vi.setSystemTime(T0 + 20);
    limit('c'); // expires T0+W+20
    vi.setSystemTime(T0 + W);
    expect(limit('a')).toBe(true); // a's fresh window, expires T0+2W
    vi.setSystemTime(T0 + W + 10); // b has expired; a, renewed, has not
    expect(limit('d')).toBe(true); // room made from b, not from a or c
    expect(limit('a')).toBe(false);
    expect(limit('c')).toBe(false);
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled(); // room from expired entries is not full
  });

  it('a quota keeps a new caller at its normal remaining, and admits it', async () => {
    const { createQuotaCounter } = await import('./rate-limiter');
    const quota = createQuotaCounter(5, W, NEVER, { name: 'test quota', maxKeys: 2 });
    expect(quota.take('a', 5)).toBe(true);
    expect(quota.take('b', 5)).toBe(true);
    expect(quota.remaining('c')).toBe(5);
    expect(quota.reserve('c', 1)).not.toBeNull();
    expect(quota.remaining('c')).toBe(4);
    expect(quota.remaining('b')).toBe(0); // b is still in the map: its used-up day holds
  });

  it('holds every limiter to 50,000 keys unless told otherwise', async () => {
    const { createRateLimiter, MAX_TRACKED_KEYS } = await import('./rate-limiter');
    expect(MAX_TRACKED_KEYS).toBe(50_000);
    const limit = createRateLimiter(1, W, NEVER, { name: 'test limiter' });
    expect(limit('first')).toBe(true);
    for (let i = 1; i < 50_000; i++) limit(`ip-${i}`);
    expect(limit('first')).toBe(false); // the 50,000th key is still held
    expect(limit('one-more')).toBe(true);
    expect(limit('first')).toBe(true); // the oldest made room
  });
});

describe('US-52 AC4f: a full map says so, by name only, once an hour', () => {
  it('warns once per map per hour, with no key, IP or count in it', async () => {
    const { createRateLimiter } = await import('./rate-limiter');
    const limit = createRateLimiter(5, 10 * HOUR, 100 * HOUR, { name: 'feedback per IP', maxKeys: 2 });
    for (const key of ['198.51.100.7', '198.51.100.8', '198.51.100.9', '198.51.100.10']) limit(key);
    const capture = vi.mocked(Sentry.captureMessage);
    expect(capture).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify([capture.mock.calls, vi.mocked(console.error).mock.calls]);
    expect(sent).toContain('feedback per IP');
    expect(sent).not.toMatch(/198\.51\.100/);
    expect(sent).not.toMatch(/\d{3,}/); // no count of anyone
    vi.setSystemTime(T0 + HOUR - 1);
    limit('198.51.100.11');
    expect(capture).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + HOUR);
    limit('198.51.100.12');
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe('US-52 AC4f: one policy, and a named list of unbounded maps', () => {
  /** Every .ts and .tsx file under app/. */
  function appFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return appFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const app = join(__dirname, '..');
  const prod = appFiles(app).filter((file) => !/\.test(-helpers)?\.tsx?$/.test(file));

  /** In-memory maps with an expiry that are not size-bounded, on purpose (lead S-24). */
  const UNBOUNDED_TTL = ['activeBatches', 'guestIpRateMap', 'orderCache', 'spentCodes', 'spentProposals', 'spentWrites', 'undeletedBatches'];
  /** Module maps with no expiry: lookups, in-flight work and content caches. */
  const NOT_TTL = ['DECODERS', 'KNOWN_CLIENTS', 'NUDGED', 'TWO_PHASE', 'WRITE_COSTS', 'articleCache', 'creatingBatches', 'formsCache', 'handleCache', 'inFlight'];

  it('names no other policy anywhere in app/', () => {
    const banned = new RegExp(['when' + 'Full', "'re" + "fuse'"].join('|'));
    expect(appFiles(app).filter((file) => banned.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('names every limit map, and only the spent-challenge set is unbounded', () => {
    const sites: string[] = [];
    for (const file of prod) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(/(?<!function )create(RateLimiter|QuotaCounter)\(/g)) {
        // The call through its options object, which closes with `})`.
        const site = text.slice(call.index, text.indexOf('})', call.index) + 2);
        const name = /name: '([^']+)'/.exec(site)?.[1] ?? `UNNAMED in ${file}`;
        sites.push(`${name}${/maxKeys: Infinity/.test(site) ? ': unbounded' : ''}`);
      }
    }
    expect(sites).toHaveLength(36);
    expect(sites.filter((s) => s.startsWith('UNNAMED'))).toEqual([]);
    expect(sites.filter((s) => s.endsWith(': unbounded'))).toEqual(['app spent challenges: unbounded']);
  });

  it('every other module-level Map is bounded or on a named list', () => {
    const unbounded: string[] = [];
    for (const file of prod) {
      const text = readFileSync(file, 'utf8');
      for (const [, name] of text.matchAll(/^(?:export )?const (\w+)(?::[^=]+)? = new Map\b/gm)) {
        if (!text.includes(`${name}.size`) && !text.includes(`boundedMap(${name}`)) unbounded.push(name);
      }
    }
    expect(unbounded.sort()).toEqual([...UNBOUNDED_TTL, ...NOT_TTL].sort());
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
