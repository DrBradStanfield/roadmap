/**
 * The three manual-trigger admin pages send real email and rewrite real rows.
 * A loader runs on any plain visit — a refresh, a back button, an admin link
 * prefetch — so rendering the page must do nothing at all; the work happens
 * only on a deliberate POST, and only for the shop ADMIN_SHOP_DOMAIN names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const processV2Reminders = vi.fn(async () => 3);
const computeAndWriteTrending = vi.fn(async () => [{ slug: 'a' }]);
const runYouTubeBotSummaryOnce = vi.fn(async () => undefined);
const adminAuth = vi.fn(async () => ({ session: { shop: 'drstanfield.myshopify.com' } }));

vi.mock('../shopify.server', () => ({ authenticate: { admin: (r: Request) => adminAuth(r) } }));
vi.mock('../lib/reminder-v2-cron.server', () => ({ processV2Reminders: (d: string) => processV2Reminders(d) }));
vi.mock('../lib/trending-cron.server', () => ({ computeAndWriteTrending: () => computeAndWriteTrending() }));
vi.mock('../lib/youtube-bot-summary-cron.server', () => ({ runYouTubeBotSummaryOnce: () => runYouTubeBotSummaryOnce() }));

const reminders = await import('./app.reminders-v2-test');
const trending = await import('./app.trending-test');
const youtube = await import('./app.youtube-bot-summary-test');

const PAGES = [
  { name: 'reminders-v2-test', mod: reminders, sideEffect: processV2Reminders },
  { name: 'trending-test', mod: trending, sideEffect: computeAndWriteTrending },
  { name: 'youtube-bot-summary-test', mod: youtube, sideEffect: runYouTubeBotSummaryOnce },
];

const get = (name: string) => new Request(`https://health-tool-app.fly.dev/app/${name}`);
const post = (name: string) => new Request(`https://health-tool-app.fly.dev/app/${name}`, { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  adminAuth.mockResolvedValue({ session: { shop: 'drstanfield.myshopify.com' } });
  delete process.env.ADMIN_SHOP_DOMAIN;
});
afterEach(() => { delete process.env.ADMIN_SHOP_DOMAIN; });

describe.each(PAGES)('$name', ({ name, mod, sideEffect }) => {
  it('does nothing when the page is merely viewed', async () => {
    await expect(mod.loader({ request: get(name) } as never)).resolves.toBeNull();
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('runs exactly once on a POST', async () => {
    await mod.action({ request: post(name) } as never);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('403s another shop and runs nothing', async () => {
    process.env.ADMIN_SHOP_DOMAIN = 'drstanfield.myshopify.com';
    adminAuth.mockResolvedValue({ session: { shop: 'attacker.myshopify.com' } });
    const thrown = await mod.action({ request: post(name) } as never).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('reports the failure instead of throwing when the job itself throws', async () => {
    sideEffect.mockRejectedValueOnce(new Error('boom'));
    const result = await mod.action({ request: post(name) } as never);
    expect(JSON.stringify((result as { data: unknown }).data)).toContain('boom');
  });
});
