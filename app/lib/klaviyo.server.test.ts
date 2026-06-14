import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Klaviyo module captures KLAVIYO_API_KEY / KLAVIYO_LIST_ID into
// module-level consts at import time, so set them BEFORE importing it.
process.env.KLAVIYO_API_KEY = 'pk_test_dummy';
process.env.KLAVIYO_LIST_ID = 'TESTLIST';

import {
  computeCaptureTrend,
  getKlaviyoCaptureStats,
} from './klaviyo.server';

describe('computeCaptureTrend', () => {
  it('reports an increase', () => {
    expect(computeCaptureTrend(150, 100)).toEqual({
      trendPct: 50,
      trendDirection: 'up',
    });
  });

  it('reports a decrease', () => {
    expect(computeCaptureTrend(80, 100)).toEqual({
      trendPct: -20,
      trendDirection: 'down',
    });
  });

  it('reports flat when equal', () => {
    expect(computeCaptureTrend(100, 100)).toEqual({
      trendPct: 0,
      trendDirection: 'flat',
    });
  });

  it('avoids divide-by-zero: prior=0 with signups reads as up 100%', () => {
    expect(computeCaptureTrend(42, 0)).toEqual({
      trendPct: 100,
      trendDirection: 'up',
    });
  });

  it('avoids divide-by-zero: prior=0 and current=0 reads as flat', () => {
    expect(computeCaptureTrend(0, 0)).toEqual({
      trendPct: 0,
      trendDirection: 'flat',
    });
  });

  it('rounds the percentage', () => {
    // (133 - 100) / 100 = 33%
    expect(computeCaptureTrend(133, 100).trendPct).toBe(33);
    // (1 - 3) / 3 = -66.67 -> -67
    expect(computeCaptureTrend(1, 3).trendPct).toBe(-67);
  });
});

// --- getKlaviyoCaptureStats (mocked fetch) ---

const REAL_FETCH = global.fetch;

// Build a profile row that joined N days ago, as Klaviyo's List Profiles
// endpoint returns it (sparse-fielded to joined_group_at).
function profileJoinedDaysAgo(days: number) {
  const joined = new Date(Date.now() - days * 86_400_000).toISOString();
  return { attributes: { joined_group_at: joined } };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('getKlaviyoCaptureStats', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    vi.restoreAllMocks();
  });

  it('returns total + windowed counts + trend from list + a single profile page', async () => {
    const profiles = [
      profileJoinedDaysAgo(5), // last30
      profileJoinedDaysAgo(20), // last30
      profileJoinedDaysAgo(40), // prev30
      profileJoinedDaysAgo(55), // prev30
      profileJoinedDaysAgo(50), // prev30
      { attributes: { joined_group_at: null } }, // ignored
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/lists/TESTLIST/profiles/')) {
        return jsonResponse({ data: profiles, links: { next: null } });
      }
      // Get List
      return jsonResponse({ data: { attributes: { profile_count: 690 } } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const stats = await getKlaviyoCaptureStats();
    expect(stats.total).toBe(690);
    expect(stats.last30d).toBe(2);
    expect(stats.prev30d).toBe(3);
    // (2 - 3) / 3 = -33%
    expect(stats.trendDirection).toBe('down');
    expect(stats.trendPct).toBe(-33);
  });

  it('follows the pagination cursor across pages', async () => {
    const page1 = [profileJoinedDaysAgo(5), profileJoinedDaysAgo(10)];
    const page2 = [profileJoinedDaysAgo(40)];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/lists/TESTLIST/profiles/') && !url.includes('cursor=2')) {
        return jsonResponse({ data: page1, links: { next: 'https://a.klaviyo.com/next?cursor=2' } });
      }
      if (url.includes('cursor=2')) {
        return jsonResponse({ data: page2, links: { next: null } });
      }
      return jsonResponse({ data: { attributes: { profile_count: 3 } } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const stats = await getKlaviyoCaptureStats();
    expect(stats.total).toBe(3);
    expect(stats.last30d).toBe(2);
    expect(stats.prev30d).toBe(1);
  });

  it('throws when the Get List call fails (caller falls back)', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/profiles/')) return jsonResponse({ data: [] });
      return jsonResponse({}, false, 500);
    }) as unknown as typeof fetch;

    await expect(getKlaviyoCaptureStats()).rejects.toThrow(/Get List failed/);
  });

  it('throws when a profile page fails', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/profiles/')) return jsonResponse({}, false, 429);
      return jsonResponse({ data: { attributes: { profile_count: 5 } } });
    }) as unknown as typeof fetch;

    await expect(getKlaviyoCaptureStats()).rejects.toThrow(/List Profiles failed/);
  });

  it('propagates fetch rejection (timeout/network) so the caller can fall back', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;

    await expect(getKlaviyoCaptureStats()).rejects.toThrow(/timeout/);
  });
});
