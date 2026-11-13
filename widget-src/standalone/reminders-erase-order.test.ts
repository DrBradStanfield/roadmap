// @vitest-environment jsdom
/**
 * US-11 AC4c (lead S59): the reminders cancel follows a record write that
 * stands; a refused erase cancels nothing. The real data layer and store run
 * here over an in-memory cloud; only the reminders server is stubbed, as a
 * set of live tokens. Synthetic address, token and proof, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const ADDRESS = 'synthetic-person@example.com';
const TOKEN = 'test-token-good';
const PROOF = 'test-proof-good';
const SWITCH_KEY = 'hr_reminders_switch_cancelled';

/** A cloud whose writes can be refused outright (a revoked grant: nothing stored). */
class FailingCloud extends MemoryAdapter {
  failWrites = false;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    if (this.failWrites) throw new StorageError('Dropbox write failed (403)', undefined, undefined, 403);
    return super.write(...args);
  }
}

type Posted = { op: string; token?: string; idToken?: string };

/** The reminders server: a cancel removes the row, an update to a missing row is a 404. */
function stubServer(cloud: FailingCloud) {
  const live = new Set([TOKEN]);
  const posts: Posted[] = [];
  const epochAtCancel: number[] = [];
  const keepalive: boolean[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posts.push(body);
    if (body.op === 'cancel') {
      const file = JSON.parse(cloud.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
      epochAtCancel.push(file.meta.eraseEpoch ?? 0);
      keepalive.push(init?.keepalive === true);
      live.delete(body.token!);
      return new Response('{}', { status: 200 });
    }
    if (body.op === 'update') return new Response('{}', { status: live.has(body.token!) ? 200 : 404 });
    return new Response('{}', { status: 200 });
  }));
  return { posts, cancels: () => posts.filter((p) => p.op === 'cancel'), epochAtCancel, keepalive };
}

async function setUp(provider: 'dropbox' | 'google-drive' = 'dropbox') {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  const { Sentry } = await import('../src/lib/sentry');
  const cloud = new FailingCloud();
  await data.initRoadmapStore(cloud);
  data.setPreEraseHook(reminders.cancelRemindersForErase); // as standalone/app.tsx registers it
  expect(data.setReminderOptIn({ status: 'active', token: TOKEN, email: ADDRESS, provider })).toBe(true);
  await data.flushRoadmapStore();
  localStorage.setItem(SWITCH_KEY, 'old-switch-token');
  return { data, reminders, cloud, Sentry };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // a cloud page, its backend remembered
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('US-11 AC4c: the reminders cancel follows a record write that stands (lead S59)', () => {
  it('(a) an erase put back (cloud 403, this browser full) cancels nothing, and a later push keeps reminders on', async () => {
    const { data, reminders, cloud } = await setUp();
    const server = stubServer(cloud);
    const before = data.getEraseIdentity();
    cloud.failWrites = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect((await data.deleteUserData()).success).toBe(false);
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(data.getEraseIdentity()).toBe(before); // put back (S57)
    expect(server.cancels()).toEqual([]);
    expect(localStorage.getItem(SWITCH_KEY)).toBe('old-switch-token');

    cloud.failWrites = false;
    await reminders.pushReminderSchedule('dropbox');
    expect(server.posts.at(-1)?.op).toBe('update');
    expect(data.getReminderOptIn()?.status).toBe('active');
  });

  it('(b) an erase that lands: the cancel leaves only once the cloud holds the erased record, with the proof, keepalive', async () => {
    const { data, cloud, reminders } = await setUp('google-drive');
    const { GoogleDriveAdapter } = await import('../src/storage');
    vi.spyOn(GoogleDriveAdapter.prototype, 'getReminderIdToken').mockResolvedValue(PROOF);
    const server = stubServer(cloud);

    expect((await data.deleteUserData()).success).toBe(true);

    expect(server.cancels()).toEqual([{ op: 'cancel', token: TOKEN, idToken: PROOF }]);
    expect(server.epochAtCancel).toEqual([1]);
    expect(server.keepalive).toEqual([true]);
    expect(localStorage.getItem(SWITCH_KEY)).toBeNull();
    void reminders;
  });

  it('(c) an erase held in this browser (cloud 403): one cancel now, none at the retry that lands', async () => {
    const { data, cloud } = await setUp();
    const server = stubServer(cloud);
    const before = data.getEraseIdentity();
    cloud.failWrites = true;

    expect((await data.deleteUserData()).success).toBe(false);
    expect(data.getEraseIdentity()).not.toBe(before); // the erased copy stands, held
    expect(server.cancels()).toHaveLength(1);

    cloud.failWrites = false;
    await data.flushRoadmapStore();
    expect(server.cancels()).toHaveLength(1);
    expect(localStorage.getItem(SWITCH_KEY)).toBeNull();
  });

  it('(d) a prepare that fails (no proof in hand) posts nothing, but the erase that stands still clears the switch key', async () => {
    const { data, cloud } = await setUp('google-drive');
    const { GoogleDriveAdapter } = await import('../src/storage');
    vi.spyOn(GoogleDriveAdapter.prototype, 'getReminderIdToken').mockImplementation(() => { throw new Error('proof lookup broke'); });
    const server = stubServer(cloud);

    expect((await data.deleteUserData()).success).toBe(true);

    expect(server.posts).toEqual([]);
    expect(localStorage.getItem(SWITCH_KEY)).toBeNull();
  });

  it.each([
    ['a prepare that succeeds', false],
    ['a prepare that fails', true],
  ] as const)('(e) %s: nothing it read reaches the console or Sentry', async (_case, fails) => {
    const { data, cloud, Sentry } = await setUp('google-drive');
    const { GoogleDriveAdapter } = await import('../src/storage');
    const proof = vi.spyOn(GoogleDriveAdapter.prototype, 'getReminderIdToken');
    if (fails) proof.mockImplementation(() => { throw new Error(`proof lookup broke ${PROOF} ${TOKEN}`); });
    else proof.mockResolvedValue(PROOF);
    stubServer(cloud);
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));

    expect((await data.deleteUserData()).success).toBe(true);

    const said = JSON.stringify([
      ...consoleCalls.flatMap((spy) => spy.mock.calls),
      ...vi.mocked(Sentry.captureException).mock.calls,
    ], (_key, value: unknown) => (value instanceof Error ? `${value.message} ${value.stack}` : value));
    for (const secret of [TOKEN, PROOF, ADDRESS, 'proof lookup broke']) expect(said).not.toContain(secret);
  });
});
