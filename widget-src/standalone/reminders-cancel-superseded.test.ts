// @vitest-environment jsdom
/**
 * US-17 AC17: a Turn off acts only on the opt-in it read. An opt-in written
 * while its cancel request is out (another device turned reminders on, and
 * this page merged it in) stands: the late cancel writes nothing over it and
 * counts no opt-out. The real data layer and store run here over an
 * in-memory cloud; only the reminders server is stubbed. Synthetic address
 * and tokens, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { ERASE_IN_PROGRESS, RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const ADDRESS = 'synthetic-person@example.com';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('US-17 AC17: a Turn off acts only on the opt-in it read', () => {
  it('an opt-in written while the cancel request is out stays active, with no opt-out counted', async () => {
    const data = await import('../src/lib/roadmap-data');
    const { cancelReminders } = await import('./reminders');
    const { trackProductEvent } = await import('../src/lib/server-api');
    const cloud = new MemoryCloud();
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    expect(data.setReminderOptIn({ status: 'active', token: 'test-token-old', email: ADDRESS, provider: 'dropbox' })).toBe(true);
    await data.flushRoadmapStore();

    let release!: () => void;
    const answered = new Promise<void>((r) => { release = r; });
    let sent!: () => void;
    const cancelSent = new Promise<void>((r) => { sent = r; });
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).op === 'cancel') { sent(); await answered; }
      return new Response('{}', { status: 200 });
    }));

    const turningOff = cancelReminders();
    await cancelSent;
    // Another device's Turn on, merged in while the cancel is out.
    expect(data.setReminderOptIn({ status: 'active', token: 'test-token-new', email: ADDRESS, provider: 'dropbox' })).toBe(true);
    release();
    await turningOff;
    await data.flushRoadmapStore();

    const optIn = data.getReminderOptIn();
    expect(optIn?.status).toBe('active');
    expect(optIn?.token).toBe('test-token-new');
    const stored = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(stored.reminderOptIn?.status).toBe('active');
    expect(stored.reminderOptIn?.token).toBe('test-token-new');
    expect(trackProductEvent).not.toHaveBeenCalledWith('reminder_optout', expect.anything());
  });
  // F2 (PR 1735 review): the record is at another erase than the page shows
  // (an erase landed, the page has not marked it shown) and holds an active
  // opt-in written at that erase; no erase is running. The refused write is
  // not "being deleted": it says the record changed, and nothing is counted.
  it('a write refused at another erase, none running, says the record changed, and the switch stays on', async () => {
    const data = await import('../src/lib/roadmap-data');
    const { cancelReminders } = await import('./reminders');
    const { trackProductEvent } = await import('../src/lib/server-api');
    const cloud = new MemoryCloud();
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    const before = data.getEraseIdentity();
    expect((await data.deleteUserData()).success).toBe(true);
    expect(data.getEraseIdentity()).not.toBe(before);
    expect(data.getShownErase()).toBe(before);
    expect(data.setReminderOptIn({ status: 'active', token: 'test-token-new', email: ADDRESS, provider: 'dropbox' }, data.getEraseIdentity())).toBe(true);
    await data.flushRoadmapStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await expect(cancelReminders()).rejects.toThrow(RECORD_CHANGED_SINCE_ASKED);

    // Refused before the POST: the row is not cancelled under a switch that stays on (US-11 AC4b, F1).
    expect(fetch).not.toHaveBeenCalled();
    expect(data.getReminderOptIn()?.status).toBe('active');
    expect(data.getReminderOptIn()?.token).toBe('test-token-new');
    expect(trackProductEvent).not.toHaveBeenCalledWith('reminder_optout', expect.anything());
  });
  // F1 (lead S59b): a Turn off asked while this tab's own erase runs is
  // refused before its POST. Before, it cancelled the row, then was refused,
  // so the switch stayed on over a row the server no longer had.
  it("a Turn off during this tab's own erase says the data is being deleted, and posts nothing", async () => {
    const data = await import('../src/lib/roadmap-data');
    const { cancelReminders } = await import('./reminders');
    const { ChatSession } = await import('@roadmap/health-core/chat-session');
    const cloud = new MemoryCloud();
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    expect(data.setReminderOptIn({ status: 'active', token: 'test-token-old', email: ADDRESS, provider: 'dropbox' })).toBe(true);
    await data.flushRoadmapStore();
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    let turnOff: Promise<unknown> = Promise.resolve();
    let postsAtRefusal = -1;
    const eraseChat = ChatSession.prototype.eraseAll;
    const spy = vi.spyOn(ChatSession.prototype, 'eraseAll').mockImplementation(async function (this: import('@roadmap/health-core/chat-session').ChatSession) {
      // The erase runs: Turn off is asked now, under the erase the page shows.
      turnOff = cancelReminders().catch((e: Error) => { postsAtRefusal = f.mock.calls.length; return e.message; });
      await turnOff;
      return eraseChat.call(this);
    });

    expect((await data.deleteUserData()).success).toBe(true);

    expect(await turnOff).toBe(ERASE_IN_PROGRESS);
    expect(postsAtRefusal).toBe(0);
    spy.mockRestore();
  });
});
