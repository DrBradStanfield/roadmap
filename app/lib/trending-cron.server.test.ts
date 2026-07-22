import { describe, it, expect, vi } from 'vitest';

// trending-cron.server.ts imports the Shopify app + Supabase singletons at
// module load; neither is exercised by these tests, so stub them out.
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock('./supabase.server', () => ({ tryAcquireCronLock: vi.fn() }));

import {
  computeTrending,
  buildStoreHandleMap,
  writeTrendingMetafield,
} from './trending-cron.server';
import type { BlogIndexEntry } from './blog-index.server';

const COMMERCE_DOMAIN = 'microvitamin.myshopify.com';
const EDU_DOMAIN = 'sz5utw-1r.myshopify.com';

function indexEntry(
  handle: string,
  commerceHandle?: string,
  publishedAt = '2025-01-01T00:00:00Z',
): BlogIndexEntry {
  return {
    title: handle,
    handle,
    url: `https://drstanfield.com/blogs/articles/${handle}`,
    ...(commerceHandle
      ? { commerceUrl: `https://microvitamin.com/blogs/articles/${commerceHandle}` }
      : {}),
    tags: [],
    publishedAt,
  };
}

// 100 current-7d sessions + 74 baseline sessions over the 37-day window
// (= 14/week) clears both floors (MIN_CURRENT_7D_VIEWS=50, MIN_BASELINE_WEEKLY_VIEWS=12).
const rows = (path: string, views: number) => [{ url: path, views }];

describe('buildStoreHandleMap + computeTrending — per-store article handles', () => {
  // THE BUG (microvitamin.com trending sidebar permanently empty): the two
  // stores publish the same articles under DIFFERENT handles. The blog index
  // is keyed by the drstanfield.com (education) handle; the commerce store's
  // handle only appears in `commerceUrl`. The cron looked up commerce traffic
  // handles against education keys, found nothing, and wrote `[]` every day.
  it('ranks commerce-store traffic recorded under the commerce handle', () => {
    const map = buildStoreHandleMap(
      [indexEntry('edu-handle', 'commerce-handle')],
      COMMERCE_DOMAIN,
    );
    const ranked = computeTrending(
      rows('/blogs/articles/commerce-handle', 100),
      rows('/blogs/articles/commerce-handle', 74),
      map,
    );
    expect(ranked).toHaveLength(1);
    // The payload handle must be the COMMERCE handle so the commerce store's
    // Liquid `articles['articles/' | append: handle]` lookup resolves.
    expect(ranked[0].handle).toBe('commerce-handle');
    expect(ranked[0].score).toBeCloseTo(100 / ((74 / 37) * 7), 2);
  });

  it('keys the education store by the index handle (unchanged behaviour)', () => {
    const map = buildStoreHandleMap(
      [indexEntry('edu-handle', 'commerce-handle')],
      EDU_DOMAIN,
    );
    const ranked = computeTrending(
      rows('/blogs/articles/edu-handle', 100),
      rows('/blogs/articles/edu-handle', 74),
      map,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].handle).toBe('edu-handle');
  });

  it('aggregates pre-split education-handle traffic into the commerce entry (baseline continuity)', () => {
    // Until 2026-06-24 drstanfield.com pointed at the commerce store, so that
    // store's baseline sessions live under the education handles. Current
    // traffic arrives under the new commerce handles. Both must aggregate to
    // one entry or every article fails a floor on one side of the split.
    const map = buildStoreHandleMap(
      [indexEntry('edu-handle', 'commerce-handle')],
      COMMERCE_DOMAIN,
    );
    const ranked = computeTrending(
      rows('/blogs/articles/commerce-handle', 100),
      rows('/blogs/articles/edu-handle', 74), // baseline under the OLD handle
      map,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].handle).toBe('commerce-handle');
    expect(ranked[0].baselineWeekly).toBeCloseTo((74 / 37) * 7, 5);
  });

  it('excludes articles with no commerce version from the commerce store', () => {
    const map = buildStoreHandleMap([indexEntry('edu-only')], COMMERCE_DOMAIN);
    const ranked = computeTrending(
      rows('/blogs/articles/edu-only', 100),
      rows('/blogs/articles/edu-only', 74),
      map,
    );
    expect(ranked).toHaveLength(0);
  });
});

describe('computeTrending — baseline floor clamps the denominator, never excludes', () => {
  // THE JULY-13 BUG (microvitamin.com sidebar empty again): sub-floor-baseline
  // articles were EXCLUDED instead of having the denominator clamped, so a
  // store whose surging articles had a near-zero baseline wrote `[]` daily.
  // Full story: docs/newspaper-blog-trending.md, "The baseline floor must
  // CLAMP the denominator" (Lessons learned).
  const map = buildStoreHandleMap(
    [indexEntry('edu-handle', 'commerce-handle')],
    COMMERCE_DOMAIN,
  );

  it('includes a zero-baseline surging article, scored against the clamped floor', () => {
    const ranked = computeTrending(
      rows('/blogs/articles/commerce-handle', 100),
      [], // no baseline traffic at all
      map,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].handle).toBe('commerce-handle');
    // Denominator clamped to MIN_BASELINE_WEEKLY_VIEWS (12), not 0/undefined.
    expect(ranked[0].score).toBeCloseTo(100 / 12, 5);
    // baselineWeekly reports the REAL baseline for logging transparency.
    expect(ranked[0].baselineWeekly).toBe(0);
  });

  it('clamps a sub-floor baseline so a tiny denominator cannot inflate the score', () => {
    // 37 baseline sessions over the 37-day window = 7/week, under the 12 floor.
    const ranked = computeTrending(
      rows('/blogs/articles/commerce-handle', 100),
      rows('/blogs/articles/commerce-handle', 37),
      map,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeCloseTo(100 / 12, 5); // NOT 100/7 ≈ 14.3
  });
});

describe('writeTrendingMetafield — commit verification', () => {
  const payload = [{ handle: 'foo', score: 3.2 }];

  function fakeAdmin(metafieldsSetResult: unknown) {
    return {
      graphql: vi.fn(async (_query: string, _opts?: unknown) => ({
        json: async () => ({ data: { metafieldsSet: metafieldsSetResult } }),
      })),
    };
  }

  // THE SENTRY ISSUE ("Metafield write returned stale updatedAt", daily):
  // `metafieldsSet` is idempotent — when the submitted value equals the stored
  // value, Shopify commits nothing and echoes the existing record with the OLD
  // updatedAt. That is a successful no-op, not a failure. The old guard
  // asserted on updatedAt freshness and threw every day the trending list was
  // unchanged (e.g. `[]` written over `[]` on the commerce store).
  it('treats an identical-value echo (old updatedAt) as success', async () => {
    const admin = fakeAdmin({
      metafields: [{
        id: 'gid://shopify/Metafield/1',
        key: 'trending_articles',
        namespace: 'health_roadmap',
        updatedAt: '2026-07-02T15:09:21Z', // days old
        value: JSON.stringify(payload), // …but the stored value IS what we sent
      }],
      userErrors: [],
    });
    await expect(writeTrendingMetafield(admin, 'gid://shopify/Shop/1', payload))
      .resolves.toBeUndefined();
  });

  // The real silent-failure mode the old guard was built for: Shopify echoes
  // the existing record with a DIFFERENT value — nothing was written.
  it('throws when the echoed value differs from the submitted value', async () => {
    const admin = fakeAdmin({
      metafields: [{
        id: 'gid://shopify/Metafield/1',
        key: 'trending_articles',
        namespace: 'health_roadmap',
        updatedAt: new Date().toISOString(), // freshness proves nothing
        value: JSON.stringify([{ handle: 'stale-old-entry', score: 9.9 }]),
      }],
      userErrors: [],
    });
    await expect(writeTrendingMetafield(admin, 'gid://shopify/Shop/1', payload))
      .rejects.toThrow(/different value/i);
  });

  it('throws on userErrors', async () => {
    const admin = fakeAdmin({
      metafields: [],
      userErrors: [{ field: ['value'], message: 'invalid', code: 'INVALID' }],
    });
    await expect(writeTrendingMetafield(admin, 'gid://shopify/Shop/1', payload))
      .rejects.toThrow(/userErrors/);
  });

  it('throws when no metafield row is returned', async () => {
    const admin = fakeAdmin({ metafields: [], userErrors: [] });
    await expect(writeTrendingMetafield(admin, 'gid://shopify/Shop/1', payload))
      .rejects.toThrow(/empty metafields/i);
  });
});
