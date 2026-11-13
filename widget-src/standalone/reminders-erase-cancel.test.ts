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
  it('an erase that lands, and is shown, while the cancel request is out keeps no token or address', async () => {
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
    // "Delete all my data" runs to the end and the page shows the erased record.
    expect((await data.deleteUserData()).success).toBe(true);
    data.markEraseShown(data.getEraseIdentity());
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
