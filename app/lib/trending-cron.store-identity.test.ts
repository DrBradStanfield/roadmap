import { describe, it, expect, vi, afterEach } from 'vitest';

// US-28 (daily crons) + untangle S-13: the trending cron runs for the store
// its own Fly app serves, on both apps. Each case boots the module under one
// app's env and checks the three things that name the store: the lock row,
// the shop handed to unauthenticated.admin, and the brand/edu handle branch.
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock('./supabase.server', () => ({ tryAcquireCronLock: vi.fn(), endCronLock: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
// One article published under a different handle on each store.
vi.mock('./blog-index.server', () => ({
  loadBlogIndex: () => [{
    title: 't',
    handle: 'edu-handle',
    url: 'https://drstanfield.com/blogs/articles/edu-handle',
    commerceUrl: 'https://microvitamin.com/blogs/articles/commerce-handle',
    tags: [],
    publishedAt: '2025-01-01T00:00:00Z',
  }],
}));

const HOUR_MS = 60 * 60 * 1000;

// Traffic under the education handle clears both floors; the brand store
// aliases it to its commerce handle, the edu store keeps it as is.
function adminFor() {
  return {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      let body: unknown;
      if (query.includes('shopifyqlQuery')) {
        const views = query.includes('SINCE -8d') ? 100 : 74;
        body = { data: { shopifyqlQuery: { parseErrors: [], tableData: {
          columns: [{ name: 'landing_page_path' }, { name: 'sessions' }],
          rows: [{ landing_page_path: '/blogs/articles/edu-handle', sessions: views }],
        } } } };
      } else if (query.includes('shop { id }')) {
        body = { data: { shop: { id: 'gid://shopify/Shop/1' } } };
      } else {
        const value = opts?.variables?.metafields?.[0]?.value;
        body = { data: { metafieldsSet: { userErrors: [], metafields: [
          { id: 'gid://shopify/Metafield/1', value, updatedAt: '2026-08-28T00:00:00Z' },
        ] } } };
      }
      return { json: async () => body };
    }),
  };
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Boot the cron under one app's SHOPIFY_SHOP_DOMAIN, run one tick, report what it did. */
async function runOneTick(shopDomain: string | undefined) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T15:30:00Z')); // 03:30 NZST, 28 Aug
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', shopDomain);
  vi.resetModules();
  const cron = await import('./trending-cron.server');
  vi.stubEnv('NODE_ENV', 'production');
  const { unauthenticated } = await import('../shopify.server');
  const { tryAcquireCronLock } = await import('./supabase.server');
  const admin = adminFor();
  const adminMock = vi.mocked(unauthenticated.admin).mockReset().mockResolvedValue({ admin } as any);
  const lockMock = vi.mocked(tryAcquireCronLock).mockReset().mockResolvedValue('won');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  stop = cron.stopTrendingCron;

  cron.startTrendingCron();
  await vi.advanceTimersByTimeAsync(HOUR_MS);

  const write = admin.graphql.mock.calls.find(([q]) => q.includes('metafieldsSet'));
  const payload = JSON.parse(write![1]!.variables.metafields[0].value);
  const startLine = log.mock.calls.map(([l]) => String(l)).find(l => l.startsWith('Trending cron started'));
  log.mockRestore();
  return {
    lockNames: lockMock.mock.calls.map(c => c[2]),
    adminShops: adminMock.mock.calls.map(c => c[0]),
    writtenHandles: payload.map((e: { handle: string }) => e.handle),
    startLine,
  };
}

describe('trending cron store identity (US-28, S-13)', () => {
  it('brand app, SHOPIFY_SHOP_DOMAIN set to the brand shop', async () => {
    const r = await runOneTick('microvitamin.myshopify.com');
    expect(r.lockNames).toEqual(['trending_cron']);
    expect(r.adminShops).toEqual(['microvitamin.myshopify.com']);
    expect(r.writtenHandles).toEqual(['commerce-handle']); // brand branch
    expect(r.startLine).toContain('shop: microvitamin.myshopify.com, lock: trending_cron)');
  });

  it('brand app, SHOPIFY_SHOP_DOMAIN unset (the default)', async () => {
    const r = await runOneTick(undefined);
    expect(r.lockNames).toEqual(['trending_cron']);
    expect(r.adminShops).toEqual(['microvitamin.myshopify.com']);
    expect(r.writtenHandles).toEqual(['commerce-handle']); // brand branch
    expect(r.startLine).toContain('shop: microvitamin.myshopify.com, lock: trending_cron)');
  });

  it('edu app, SHOPIFY_SHOP_DOMAIN set to the edu shop', async () => {
    const r = await runOneTick('sz5utw-1r.myshopify.com');
    expect(r.lockNames).toEqual(['trending_cron_edu']);
    expect(r.adminShops).toEqual(['sz5utw-1r.myshopify.com']);
    expect(r.writtenHandles).toEqual(['edu-handle']); // edu branch
    expect(r.startLine).toContain('shop: sz5utw-1r.myshopify.com, lock: trending_cron_edu)');
  });
});
