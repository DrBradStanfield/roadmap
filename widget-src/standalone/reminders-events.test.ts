// @vitest-environment jsdom
/**
 * US-17 AC19 (review R7): the Turn off usage signals go through the real
 * transport (server-api's trackProductEvent and its tab throttle) once per
 * qualifying action, a second Turn off in the same tab included. The real
 * data layer and store over an in-memory cloud; the reminders route answers
 * 200. Fake, low-entropy tokens and addresses only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';

vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./dropbox-config', () => ({ dropboxConfig: () => ({}) }));

const events: { eventName: string; metadata?: unknown }[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  events.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/events')) events.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('US-17 AC19: each Turn off reaches the event transport', () => {
  it('two Turn offs of two tokens each, in one tab: two reminder_cancel_many and two reminder_optout', async () => {
    const data = await import('../src/lib/roadmap-data');
    const { RoadmapStore } = await import('../src/storage/roadmap-store');
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    const { cancelReminders } = await import('./reminders');
    await data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
    const on = (...tokens: string[]) => expect(data.setReminderRows(
      tokens.map((token) => ({ status: 'active' as const, token, email: `${token}@example.test`, provider: 'dropbox' as const })),
      data.getShownErase(),
    )).toBe(true);

    on('test-token-a', 'test-token-b');
    await cancelReminders();
    on('test-token-c', 'test-token-d');
    await cancelReminders();

    const named = (name: string) => events.filter((e) => e.eventName === name);
    expect(named('reminder_cancel_many')).toEqual([
      { eventName: 'reminder_cancel_many', visitorId: expect.any(String), metadata: { provider: 'dropbox', count: 2 } },
      // Every token in the set gets a cancel, the two already off included (the route is idempotent).
      { eventName: 'reminder_cancel_many', visitorId: expect.any(String), metadata: { provider: 'dropbox', count: 4 } },
    ]);
    expect(named('reminder_optout')).toHaveLength(2);
  });
});
