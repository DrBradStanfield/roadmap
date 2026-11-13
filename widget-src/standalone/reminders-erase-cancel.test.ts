// @vitest-environment jsdom
/**
 * US-11 AC4b: a Turn off whose cancel request is still out when "Delete all my
 * data" runs writes nothing into the erased record. The real data layer and
 * store run here over an in-memory cloud; only the reminders server is stubbed.
 * Synthetic address and token, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const ADDRESS = 'synthetic-person@example.com';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // a cloud page, its backend remembered
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('US-11 AC4b: a Turn off in flight during an erase leaves the erased record without the old opt-in', () => {
  // 'shown': the page has caught up with the erase before the cancel answers.
  // Before the fix the write took the shown erase as it landed, the new one,
  // so it was accepted; it now carries the erase shown when Turn off was asked.
  // 'not yet shown': the erase has landed but the page still shows the old
  // one. This passed before the fix too: the store compares the stamp (the
  // old shown erase, passed or defaulted) with the copy's real erase, which
  // has moved. Pinned so work on the store's default stamp (H18-H24) cannot
  // undo it silently.
  it.each([['shown', true], ['not yet shown', false]] as const)('an erase that lands, %s, while the cancel request is out keeps no token or address', async (_case, shown) => {
    const data = await import('../src/lib/roadmap-data');
    const { cancelReminders } = await import('./reminders');
    const cloud = new MemoryCloud();
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    expect(data.setReminderOptIn({ status: 'active', token: 'test-token-good', email: ADDRESS, provider: 'dropbox' })).toBe(true);
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
    // "Delete all my data" runs to the end, and the page may show the erased record.
    const before = data.getEraseIdentity();
    expect((await data.deleteUserData()).success).toBe(true);
    expect(data.getEraseIdentity()).not.toBe(before);
    if (shown) data.markEraseShown(data.getEraseIdentity());
    expect(data.getShownErase() === before).toBe(!shown);
    release();
    await turningOff;
    await data.flushRoadmapStore();

    // Reminders read off (US-11 AC4), with no address or token left.
    const optIn = data.getReminderOptIn();
    expect(optIn?.status).toBe('cancelled');
    expect(optIn?.email ?? '').toBe('');
    expect(optIn?.token ?? '').toBe('');
    const stored = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(JSON.stringify(stored)).not.toContain(ADDRESS);
    expect(JSON.stringify(stored)).not.toContain('test-token-good');
  });
});
