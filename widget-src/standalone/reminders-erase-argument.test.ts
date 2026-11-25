// @vitest-environment jsdom
/**
 * US-16 AC2a (leads H18b, H18c): the reminders writers that run on their own,
 * with no press, write under the erase the page showed when they read the
 * opt-in. An erase that lands while their request is out, with the same
 * opt-in written again under it, refuses the late write: the record is
 * unchanged. Without the erase it lands. The real data layer and store run
 * over an in-memory cloud; only the reminders server and the cloud's account
 * lookup are stubbed. Synthetic address and tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/build-flags', async (real) => ({ ...(await real<object>()), SHOPIFY_SURFACE: true }));
const lookup = vi.hoisted(() => ({ during: async () => {} }));
vi.mock('../src/storage', async (real) => ({
  ...(await real<object>()),
  GitHubAdapter: class { async accountEmail() { await lookup.during(); return ADDRESS; } },
}));

const ADDRESS = 'synthetic-person@example.com';
const OPT_IN: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'> = { status: 'active', token: 'test-token-one', email: ADDRESS, provider: 'dropbox' };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  lookup.during = async () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The data layer open on a record holding OPT_IN, and `eraseMeanwhile`: an erase, the same opt-in written again
 *  under it and the page showing it, then the whole record as text. */
async function opened() {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  await data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
  data.markEraseShown(data.getEraseIdentity());
  expect(data.setReminderOptIn(OPT_IN, data.getShownErase())).toBe(true);
  const eraseMeanwhile = async () => {
    expect((await data.deleteUserData()).success).toBe(true);
    data.markEraseShown(data.getEraseIdentity());
    expect(data.setReminderOptIn(OPT_IN, data.getShownErase())).toBe(true);
    await data.flushRoadmapStore(); // the save stamps the record's clock: settled before the snapshot
    return JSON.stringify(data.recordFileSync());
  };
  return { data, reminders, eraseMeanwhile };
}

describe('H18b: the opt-in provider sync after a cloud switch to the same address', () => {
  it('an erase while the account lookup is out: the sync writes nothing', async () => {
    const { data, reminders, eraseMeanwhile } = await opened();
    let before = '';
    lookup.during = async () => { before = await eraseMeanwhile(); };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await reminders.autoEnrolReminders('github');
    expect(JSON.stringify(data.recordFileSync())).toBe(before);
    expect(data.getReminderOptIn()?.provider).toBe('dropbox');
  });

  it('control: with no erase, the opt-in takes the new provider', async () => {
    const { data, reminders } = await opened();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await reminders.autoEnrolReminders('github');
    expect(data.getReminderOptIn()?.provider).toBe('github');
  });
});

describe('H18c: the schedule push whose 404 turns a stale opt-in off', () => {
  it('an erase while the push is out: the 404 writes nothing', async () => {
    const { data, reminders, eraseMeanwhile } = await opened();
    let before = '';
    let pushed = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!pushed && JSON.parse(String(init?.body)).op === 'update') { pushed = true; before = await eraseMeanwhile(); }
      return new Response('{}', { status: 404 });
    }));
    await reminders.pushReminderSchedule('dropbox');
    expect(pushed).toBe(true);
    expect(JSON.stringify(data.recordFileSync())).toBe(before);
    expect(data.getReminderOptIn()?.status).toBe('active');
  });

  it('control: with no erase, the 404 turns the opt-in off', async () => {
    const { data, reminders } = await opened();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await reminders.pushReminderSchedule('dropbox');
    expect(data.getReminderOptIn()?.status).toBe('cancelled');
  });
});
