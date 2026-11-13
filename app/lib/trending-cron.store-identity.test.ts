import { describe, it, expect, vi, afterEach } from 'vitest';

// US-28 (daily crons) + untangle S-13: the trending cron runs for the store
// its own Fly app serves, on both apps. Each case boots the module under one
// app's env and checks the three things that name the store: the lock row,
// the shop handed to unauthenticated.admin, and the brand/edu handle branch.
vi.mock('../shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock('./supabase-cron-lock.server', () => ({ tryAcquireCronLock: vi.fn(), endCronLock: vi.fn() }));
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

/** Boot the cron under one app's SHOPIFY_SHOP_DOMAIN (and FLY_APP_NAME), run one tick, report what it did. */
async function runOneTick(shopDomain: string | undefined, flyAppName?: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T15:30:00Z')); // 03:30 NZST, 28 Aug
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', shopDomain);
  vi.stubEnv('FLY_APP_NAME', flyAppName);
  vi.resetModules();
  const Sentry = await import('@sentry/react-router');
  vi.mocked(Sentry.captureException).mockReset();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cron = await import('./trending-cron.server');
  vi.stubEnv('NODE_ENV', 'production');
  const { unauthenticated } = await import('../shopify.server');
  const { tryAcquireCronLock } = await import('./supabase-cron-lock.server');
  const admin = adminFor();
  const adminMock = vi.mocked(unauthenticated.admin).mockReset().mockResolvedValue({ admin } as any);
  const lockMock = vi.mocked(tryAcquireCronLock).mockReset().mockResolvedValue('won');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  stop = cron.stopTrendingCron;

  cron.startTrendingCron();
  await vi.advanceTimersByTimeAsync(HOUR_MS);

  const write = admin.graphql.mock.calls.find(([q]) => q.includes('metafieldsSet'));
  const payload = write ? JSON.parse(write[1]!.variables.metafields[0].value) : [];
  const startLine = log.mock.calls.map(([l]) => String(l)).find(l => l.startsWith('Trending cron started'));
  const lockNames = lockMock.mock.calls.map(c => c[2]);
  const adminShops = adminMock.mock.calls.map(c => c[0]);
  // The manual trigger route's entry point, after the tick.
  const manualRun = await cron.computeAndWriteTrending().then(() => 'ran', (e: Error) => e.message);
  log.mockRestore();
  const errorLines = errors.mock.calls.map(c => c.map(String).join(' '));
  errors.mockRestore();
  return {
    lockNames,
    adminShops,
    writtenHandles: payload.map((e: { handle: string }) => e.handle),
    startLine,
    manualRun,
    errorLines,
    sentry: vi.mocked(Sentry.captureException).mock.calls.map(([e, ctx]) => ({ message: (e as Error).message, ctx })),
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

  it('edu app on Fly, the edu shop with a trailing newline: trimmed, one shop for lock and admin', async () => {
    const r = await runOneTick('sz5utw-1r.myshopify.com\n', 'health-tool-edu');
    expect(r.lockNames).toEqual(['trending_cron_edu']);
    expect(r.adminShops).toEqual(['sz5utw-1r.myshopify.com']);
    expect(r.writtenHandles).toEqual(['edu-handle']);
    expect(r.sentry).toEqual([]);
  });

  it('brand app on Fly, SHOPIFY_SHOP_DOMAIN unset: the brand store, no report', async () => {
    const r = await runOneTick(undefined, 'health-tool-app');
    expect(r.lockNames).toEqual(['trending_cron']);
    expect(r.adminShops).toEqual(['microvitamin.myshopify.com']);
    expect(r.sentry).toEqual([]);
  });
});

// S-17: on Fly, an app whose SHOPIFY_SHOP_DOMAIN disagrees with its name, or is
// not a known shop, acts as no store: the trending cron never starts, never
// takes either lock, never writes either store, and the manual trigger refuses.
// One Sentry error and one log line name the app and the store kinds, never
// the domain.
describe('trending cron off when the store identity check fails (S-17)', () => {
  it.each([
    ['edu app with SHOPIFY_SHOP_DOMAIN unset', undefined, 'health-tool-edu', 'mismatch'],
    ['edu app with the brand shop', 'microvitamin.myshopify.com', 'health-tool-edu', 'mismatch'],
    ['brand app with the edu shop', 'sz5utw-1r.myshopify.com', 'health-tool-app', 'mismatch'],
    ['edu app with a malformed domain', 'https://sz5utw-1r.myshopify.com', 'health-tool-edu', 'malformed-domain'],
    ['brand app with an unknown shop', 'stray-shop.myshopify.com', 'health-tool-app', 'unknown-shop'],
    ['an unknown Fly app', 'microvitamin.myshopify.com', 'health-tool-staging', 'unknown-app'],
  ])('%s', async (_name, shopDomain, flyAppName, reason) => {
    const r = await runOneTick(shopDomain, flyAppName);
    expect(r.lockNames).toEqual([]);
    expect(r.adminShops).toEqual([]);
    expect(r.writtenHandles).toEqual([]);
    expect(r.startLine).toBeUndefined();
    expect(r.manualRun).toBe('Store identity check failed: this app acts as no store (see its boot log)');
    expect(r.sentry).toHaveLength(1);
    expect(r.sentry[0].ctx).toEqual({ tags: { feature: 'store_identity', fly_app: flyAppName, reason } });
    expect(r.sentry[0].message).toContain(flyAppName);
    expect(r.errorLines).toEqual([r.sentry[0].message]);
    const said = JSON.stringify(r.sentry) + r.errorLines.join('');
    for (const shop of ['sz5utw', 'microvitamin', 'stray-shop']) expect(said).not.toContain(shop);
  });
});
