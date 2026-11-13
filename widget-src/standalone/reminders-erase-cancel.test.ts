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

// US-11 AC4c (lead S59b): an erase cancels every active reminders token it
// sees, from its first read of the opt-in until the swap. Another device's
// Turn on (its own row, token B) can be merged in while the erase waits on
// the Drive proof (W1) or on the chat erase (W2); that row was left live,
// still emailing a person whose record is erased.
const TOKEN_A = 'test-token-good';
const TOKEN_B = 'test-token-b';
const PROOF = 'test-proof-good';
const REMOTE = 'hr:remote-changed';

type Posted = { op: string; token?: string; idToken?: string };

async function eraseSetUp() {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  const { RoadmapStore } = await import('../src/storage/roadmap-store');
  const { GoogleDriveAdapter } = await import('../src/storage');
  const { ChatSession } = await import('@roadmap/health-core/chat-session');
  const { Sentry } = await import('../src/lib/sentry');
  const { trackProductEvent } = await import('../src/lib/server-api');
  // The page's own store, so the test can run its re-read as the poll would.
  let page!: import('../src/storage/roadmap-store').RoadmapStore;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: import('../src/storage/roadmap-store').RoadmapStore) {
    page = this;
    return () => {};
  });
  const cloud = new MemoryCloud();
  await data.initRoadmapStore(new MemoryAdapter(cloud));
  data.setPreEraseHook(reminders.cancelRemindersForErase); // as standalone/app.tsx registers it
  expect(data.setReminderOptIn({ status: 'active', token: TOKEN_A, email: ADDRESS, provider: 'google-drive' })).toBe(true);
  await data.flushRoadmapStore();

  const posts: Posted[] = [];
  const keepalive: boolean[] = [];
  const refuse = new Set<string>();
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posts.push(body);
    keepalive.push(init?.keepalive === true);
    return new Response('{}', { status: body.token && refuse.has(body.token) ? 500 : 200 });
  }));

  // The page's hr:remote-changed listeners, as added and removed.
  const listening = new Set<unknown>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    if (type === REMOTE) listening.add(fn);
    add(type, fn, opts);
  }) as typeof window.addEventListener);
  vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
    if (type === REMOTE) listening.delete(fn);
    remove(type, fn, opts);
  }) as typeof window.removeEventListener);

  /** Another device turns reminders on with its own row, and this page re-reads the cloud. */
  const otherDeviceTurnsOn = async (token = TOKEN_B) => {
    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(other.setReminderOptIn({ status: 'active', token, email: ADDRESS, provider: 'dropbox' })).toBe(true);
    await other.flush();
    return page.refreshFromRemote();
  };
  const proof = vi.spyOn(GoogleDriveAdapter.prototype, 'getReminderIdToken');
  proof.mockResolvedValue(PROOF);
  return { data, posts, keepalive, refuse, listening, otherDeviceTurnsOn, proof, ChatSession, Sentry, trackProductEvent };
}

describe('US-11 AC4c: an erase cancels every active reminders token it sees (lead S59b)', () => {
  beforeEach(() => vi.clearAllMocks()); // the Sentry and event mocks outlive resetModules
  afterEach(() => vi.restoreAllMocks());

  it('W1: token B, merged in while the erase waits on the Drive proof, is cancelled too', async () => {
    const t = await eraseSetUp();
    let adopted = false;
    t.proof.mockImplementation(async () => {
      adopted = await t.otherDeviceTurnsOn();
      return PROOF;
    });

    expect((await t.data.deleteUserData()).success).toBe(true);

    expect(adopted).toBe(true);
    expect(t.posts.filter((p) => p.op === 'cancel')).toEqual([
      { op: 'cancel', token: TOKEN_A, idToken: PROOF },
      { op: 'cancel', token: TOKEN_B },
    ]);
    expect(t.keepalive).toEqual([true, true]);
  });

  it('W2: token B, merged in while the erase waits on the chat erase, is cancelled too', async () => {
    const t = await eraseSetUp();
    let adopted = false;
    const eraseChat = t.ChatSession.prototype.eraseAll;
    vi.spyOn(t.ChatSession.prototype, 'eraseAll').mockImplementation(async function (this: import('@roadmap/health-core/chat-session').ChatSession) {
      adopted = await t.otherDeviceTurnsOn();
      return eraseChat.call(this);
    });

    expect((await t.data.deleteUserData()).success).toBe(true);

    expect(adopted).toBe(true);
    expect(t.posts.filter((p) => p.op === 'cancel')).toEqual([
      { op: 'cancel', token: TOKEN_A, idToken: PROOF },
      { op: 'cancel', token: TOKEN_B },
    ]);
  });

  it('a refused erase posts nothing, and its listener goes at the next re-read', async () => {
    const erase = await import('@roadmap/health-core/erase');
    const t = await eraseSetUp();
    vi.spyOn(erase, 'buildErasedFile').mockImplementation(() => { throw new Error('build failed'); });
    const before = t.data.getEraseIdentity();

    expect((await t.data.deleteUserData()).success).toBe(false);
    expect(t.data.getEraseIdentity()).toBe(before);
    expect(t.listening.size).toBe(1); // still watching: nothing has told it the erase was refused
    expect(await t.otherDeviceTurnsOn()).toBe(true);

    expect(t.posts).toEqual([]);
    expect(t.listening.size).toBe(0);
  });

  it('an erase that lands leaves no listener behind: the commit removes it', async () => {
    const t = await eraseSetUp();
    let during = 0;
    const eraseChat = t.ChatSession.prototype.eraseAll;
    vi.spyOn(t.ChatSession.prototype, 'eraseAll').mockImplementation(async function (this: import('@roadmap/health-core/chat-session').ChatSession) {
      during = t.listening.size;
      return eraseChat.call(this);
    });

    expect((await t.data.deleteUserData()).success).toBe(true);

    expect(during).toBe(1); // it watched while the erase ran
    expect(t.listening.size).toBe(0);
  });

  it('a prepare that throws leaves no listener behind, and posts nothing', async () => {
    const t = await eraseSetUp();
    // Thrown before any promise exists, so it escapes the lookup's own catch.
    t.proof.mockImplementation(() => { throw new Error('proof lookup broke'); });
    let during = -1;
    const eraseChat = t.ChatSession.prototype.eraseAll;
    vi.spyOn(t.ChatSession.prototype, 'eraseAll').mockImplementation(async function (this: import('@roadmap/health-core/chat-session').ChatSession) {
      during = t.listening.size;
      return eraseChat.call(this);
    });

    expect((await t.data.deleteUserData()).success).toBe(true);

    expect(during).toBe(0);
    expect(t.listening.size).toBe(0);
    expect(t.posts).toEqual([]);
  });

  it('no token or proof reaches the console, Sentry or a product event during the erase', async () => {
    const t = await eraseSetUp();
    t.proof.mockImplementation(async () => {
      await t.otherDeviceTurnsOn();
      return PROOF;
    });
    t.refuse.add(TOKEN_A).add(TOKEN_B); // both cancels fail, so both are reported
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));

    expect((await t.data.deleteUserData()).success).toBe(true);

    expect(t.posts.filter((p) => p.op === 'cancel')).toHaveLength(2);
    const said = JSON.stringify([
      ...consoleCalls.flatMap((spy) => spy.mock.calls),
      ...vi.mocked(t.Sentry.captureException).mock.calls,
      ...vi.mocked(t.trackProductEvent).mock.calls,
    ], (_key, value: unknown) => (value instanceof Error ? `${value.message} ${value.stack}` : value));
    for (const secret of [TOKEN_A, TOKEN_B, PROOF, ADDRESS]) expect(said).not.toContain(secret);
  });

  it('an extra token whose cancel fails is reported by its HTTP status alone', async () => {
    const t = await eraseSetUp();
    t.proof.mockImplementation(async () => {
      await t.otherDeviceTurnsOn();
      return PROOF;
    });
    t.refuse.add(TOKEN_B);

    expect((await t.data.deleteUserData()).success).toBe(true);

    const reports = vi.mocked(t.Sentry.captureException).mock.calls
      .filter(([, at]) => (at as { tags?: { op?: string } } | undefined)?.tags?.op === 'erase-cancel');
    expect(reports.map(([e]) => (e as Error).message)).toEqual(['Reminder row delete failed (500).']);
  });
});
