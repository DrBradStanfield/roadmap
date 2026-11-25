// @vitest-environment jsdom
/**
 * US-11 AC4c (lead H126): a device that turns reminders on settles its own
 * row after a later erase made elsewhere. The real data layer and store run
 * over an in-memory cloud; only the reminders server is stubbed. Synthetic
 * address and tokens, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { buildErasedFile } from '@roadmap/health-core/erase';
import { eraseLater } from '@roadmap/health-core/erase-identity';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { CLAIM_MS, MAX_OWN, ownEnrolmentTransition, type OwnEnrolment, type OwnEnrolmentEvent, type OwnEntry } from './reminders-own-enrolment';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const ADDRESS = 'synthetic-person@example.com';
const OTHER_ADDRESS = 'synthetic-other@example.com';
const TOKEN_B = 'test-token-b';
const TOKEN_C = 'test-token-c';
const KEY = 'hr_reminders_own_enrolment';
const REMOTE = 'hr:remote-changed';

type Posted = { op: string; token?: string; email?: string };
const stops: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory'); // a cloud page, its backend remembered
  vi.clearAllMocks();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('./providers');
  vi.resetModules();
});

/** The reminders server: optins answer `optins` in turn (the last repeats);
 *  a cancel answers `cancelStatus()`. */
function server(cancelStatus: () => number = () => 200, optins: { token?: string }[] = [{ token: TOKEN_B }]) {
  const posts: Posted[] = [];
  let optin = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posts.push(body);
    if (body.op === 'optin') {
      const reply = optins[Math.min(optin++, optins.length - 1)];
      return new Response(JSON.stringify({ ...reply, email: body.email ?? ADDRESS }), { status: 200 });
    }
    return new Response('{}', { status: body.op === 'cancel' ? cancelStatus() : 200 });
  }));
  return { posts, cancels: () => posts.filter((p) => p.op === 'cancel').map(({ op, token }) => ({ op, token })) };
}

/** Lets queued work run until `done` holds (at most about two seconds). */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
}

/** A page loads over `cloud`, wired as standalone/app.tsx wires it. `id`: the
 *  store id its cloud adapter reports; `fallback`: the load fell back to the
 *  device copy (US-09 AC13). */
async function loadPage(cloud: MemoryCloud, { id, fallback = false }: { id?: string; fallback?: boolean } = {}) {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  const own = await import('./reminders-own-enrolment');
  const { RoadmapStore } = await import('../src/storage/roadmap-store');
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
  let page!: import('../src/storage/roadmap-store').RoadmapStore;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: import('../src/storage/roadmap-store').RoadmapStore) {
    page = this;
    return () => {};
  });
  const adapter: StorageAdapter = fallback ? new LocalStorageAdapter() : new MemoryAdapter(cloud);
  if (id) Object.defineProperty(adapter, 'id', { value: id });
  await data.initRoadmapStore(adapter, fallback);
  data.setPreEraseHook(reminders.cancelRemindersForErase);
  const openTab = () => stops.push(own.startOwnEnrolment((token) => reminders.postCancel(token, null, true)));
  openTab();
  /** Another device writes straight to the cloud; this page has not re-read. */
  const otherDevice = () => RoadmapStore.create(new MemoryAdapter(cloud));
  return { data, reminders, openTab, otherDevice, reread: () => page.refreshFromRemote() };
}

/** The page closes; its localStorage stays. */
function closePage(): void {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.resetModules();
}

/** Another writer's erase with no reminders step: the erased file, written bare. */
function bareErase(cloud: MemoryCloud): void {
  const held = cloud.files.get(ROADMAP_FILE_NAME)!;
  const stored = JSON.parse(held.json) as RoadmapFile;
  const erased = buildErasedFile({ stored, own: stored, device: null, ctx: { deviceId: 'other-writer', now: new Date().toISOString() } });
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(erased), version: held.version + 1 });
}

/** The page turns reminders on; its token reaches the cloud file. */
async function enrol(page: Awaited<ReturnType<typeof loadPage>>, token = TOKEN_B, email = ADDRESS) {
  expect((await page.reminders.optInToReminders('dropbox', { email })).refreshed).toBe(false);
  expect(page.data.getReminderOptIn()).toMatchObject({ status: 'active', token });
}

function stored(): OwnEntry[] | null {
  return JSON.parse(localStorage.getItem(KEY) ?? 'null') as OwnEntry[] | null;
}
function storedValues(): string {
  return JSON.stringify(Object.keys(localStorage).map((key) => localStorage.getItem(key)));
}
/** localStorage refuses every write of the own-enrolment key. */
function refuseKeyWrites(): void {
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === KEY) throw new DOMException('refused', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
}

describe('US-11 AC4c: a device that turns reminders on settles its own row after a later erase (lead H126)', () => {
  it('B\'s opt-in landed before another device\'s erase write: B cancels its row when it takes the erase in', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    expect(stored()).toEqual([{ kind: 'kept', token: TOKEN_B, lineage: 'memory', erase: expect.any(String) }]);
    const a = await b.otherDevice();
    expect((await a.deleteAllData()).success).toBe(true); // no teardown of B's row runs there
    expect(http.cancels()).toEqual([]);

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length > 0 && localStorage.getItem(KEY) === null);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('B closed before the erase arrived: the next load cancels', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    await enrol(await loadPage(cloud));
    closePage();
    bareErase(cloud);

    await loadPage(cloud);
    await settle(() => http.cancels().length > 0 && localStorage.getItem(KEY) === null);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('an erased file another writer wrote, with no reminders step, is settled by the web page that enrolled', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length > 0);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('the record still holds B\'s token active under the later erase: no cancel', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    const other = await b.otherDevice();
    expect((await other.deleteAllData()).success).toBe(true);
    expect(other.setReminderOptIn({ status: 'active', token: TOKEN_B, email: ADDRESS, provider: 'dropbox' }, other.eraseIdentity)).toBe(true);
    await other.flush();

    expect(await b.reread()).toBe(true);
    await settle(() => false);

    expect(b.data.getReminderOptIn()).toMatchObject({ status: 'active', token: TOKEN_B });
    expect(http.cancels()).toEqual([]);
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B }]);
  });

  it('a failed cancel keeps the token until a cancel lands, at the next merged-in change or the next load; then no token is in localStorage', async () => {
    let status = 503;
    const http = server(() => status);
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length === 1 && stored()?.[0]?.kind === 'kept');
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B }]);

    // The next merged-in change tries again, and fails again.
    window.dispatchEvent(new Event(REMOTE));
    await settle(() => http.cancels().length === 2 && stored()?.[0]?.kind === 'kept');
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B }]);

    // The next load tries again, and lands.
    closePage();
    status = 200;
    await loadPage(cloud);
    await settle(() => http.cancels().length === 3 && localStorage.getItem(KEY) === null);

    expect(http.cancels()).toEqual(Array(3).fill({ op: 'cancel', token: TOKEN_B }));
    expect(storedValues()).not.toContain(TOKEN_B);
  });

  it('two tabs hear one erase: one cancel', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    b.openTab(); // a second tab of the same browser, listening too
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => localStorage.getItem(KEY) === null);
    await settle(() => false);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('B\'s own Turn off removes the key: a later erase sends no second cancel', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    await b.reminders.cancelReminders();
    expect(localStorage.getItem(KEY)).toBeNull();
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => false);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('B\'s own erase commit whose cancel lands removes the key: a later erase sends no second cancel', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    expect((await b.data.deleteUserData()).success).toBe(true);
    await settle(() => localStorage.getItem(KEY) === null);
    expect(localStorage.getItem(KEY)).toBeNull();
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => false);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('R3: B\'s own erase commit whose cancel fails keeps the key, and the next merged-in change cancels', async () => {
    let status = 503;
    const http = server(() => status);
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    expect((await b.data.deleteUserData()).success).toBe(true);
    await settle(() => http.cancels().length === 1);
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B }]);

    status = 200;
    window.dispatchEvent(new Event(REMOTE));
    await settle(() => http.cancels().length === 2 && localStorage.getItem(KEY) === null);

    expect(http.cancels()).toEqual(Array(2).fill({ op: 'cancel', token: TOKEN_B }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('R5: an owed token survives a later enrolment of another address: it is cancelled later, and the new one is untouched', async () => {
    let status = 503;
    const http = server(() => status, [{ token: TOKEN_B }, { token: TOKEN_C }]);
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    expect((await b.data.deleteUserData()).success).toBe(true); // its cancel of B fails
    await settle(() => http.cancels().length === 1);
    b.data.markEraseShown(b.data.getEraseIdentity()); // the page shows the erased record
    await enrol(b, TOKEN_C, OTHER_ADDRESS);
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B }, { kind: 'kept', token: TOKEN_C }]);

    status = 200;
    window.dispatchEvent(new Event(REMOTE));
    await settle(() => http.cancels().length === 2 && stored()?.length === 1);

    expect(http.cancels()).toEqual(Array(2).fill({ op: 'cancel', token: TOKEN_B }));
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_C }]);
    expect(b.data.getReminderOptIn()).toMatchObject({ status: 'active', token: TOKEN_C });
  });

  it('R6: a store that refuses the claim\'s write still settles on an ok answer', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    refuseKeyWrites();
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length === 1 && localStorage.getItem(KEY) === null);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('R6: a store that refuses the enrolment\'s write enrols without a throw and keeps nothing (the stated limit)', async () => {
    server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    refuseKeyWrites();
    await enrol(b);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('R2: a refresh by address after the erase leaves the record\'s opt-in off, and B still cancels its token', async () => {
    const http = server(() => 200, [{ token: TOKEN_B }, {}]);
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    const other = await b.otherDevice();
    expect((await other.deleteAllData()).success).toBe(true);
    // Another device asks for reminders by address: the server refreshes the same row and returns no token.
    const refresh = await fetch('/reminders', { method: 'POST', body: JSON.stringify({ op: 'optin', provider: 'typed', email: ADDRESS }) });
    expect(await refresh.json()).not.toHaveProperty('token');
    expect(other.getReminderOptIn()?.status).not.toBe('active');

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length > 0 && localStorage.getItem(KEY) === null);

    expect(b.data.getReminderOptIn()?.status).not.toBe('active');
    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('R1: a record of another lineage at a later erase settles nothing', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    await enrol(await loadPage(cloud));
    closePage();
    // Another store's record, at a later erase.
    const elsewhere = new MemoryCloud();
    elsewhere.files = new Map(cloud.files);
    bareErase(elsewhere);
    localStorage.setItem('health_roadmap_backend', 'dropbox');

    await loadPage(elsewhere, { id: 'dropbox' });
    await settle(() => false);

    expect(http.cancels()).toEqual([]);
    expect(stored()).toMatchObject([{ kind: 'kept', token: TOKEN_B, lineage: 'memory' }]);
  });

  it('R4: a load that fell back to the device copy settles nothing; the next cloud read does', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    const enrolledAt = b.data.getEraseIdentity();
    closePage();
    bareErase(cloud);
    // The device copy holds the erased record; the cloud is unreachable this load.
    const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
    const device = new LocalStorageAdapter();
    await device.write(ROADMAP_FILE_NAME, JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as object, device.readSync(ROADMAP_FILE_NAME).version);
    vi.resetModules();

    const fallen = await loadPage(cloud, { fallback: true });
    expect(eraseLater(fallen.data.getEraseIdentity(), enrolledAt)).toBe(true); // the copy is at the later erase
    window.dispatchEvent(new Event(REMOTE));
    await settle(() => false);
    expect(http.cancels()).toEqual([]);

    closePage();
    await loadPage(cloud);
    await settle(() => http.cancels().length > 0 && localStorage.getItem(KEY) === null);
    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });

  it('R1: log-off removes the key', async () => {
    server();
    const b = await loadPage(new MemoryCloud());
    await enrol(b);
    vi.stubGlobal('location', { reload: vi.fn(), search: '', href: 'http://localhost/' });
    const connect = await import('./connect');
    await connect.logOff('github');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('R1: a cloud switch removes the key', async () => {
    server();
    const cloud = new MemoryCloud();
    const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
    vi.doMock('./providers', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./providers')>()),
      providerOf: () => ({ reminders: true, adapter: () => new MemoryAdapter(cloud) }),
    }));
    const b = await loadPage(cloud);
    await enrol(b);
    const connect = await import('./connect');
    await connect.prepareSwitch('github');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('US-11 AC4c: the own-enrolment transition table (lead H126)', () => {
  const E0 = JSON.stringify([0, null]);
  const E1 = JSON.stringify([1, '2026-11-25T00:00:00.000Z']);
  const L = 'memory';
  const rowB = { token: TOKEN_B, lineage: L, erase: E0 };
  const keptB: OwnEntry = { kind: 'kept', ...rowB };
  const keptC: OwnEntry = { kind: 'kept', token: TOKEN_C, lineage: L, erase: E1 };
  const cancellingB: OwnEntry = { kind: 'cancelling', ...rowB, attempt: 'a1', since: 1000 };
  const later = (over: Partial<Extract<OwnEnrolmentEvent, { type: 'settle' }>> = {}): OwnEnrolmentEvent => ({
    type: 'settle', lineage: L, record: E1, standing: { status: 'cancelled', token: '', email: '', provider: 'dropbox', updatedAt: '2026-11-25T00:00:00.000Z' }, running: false, now: 2000, attempt: 'a2', ...over,
  });
  const cancelB = (attempt: string) => ({ type: 'cancel', ...rowB, attempt });
  const tokens = (n: number, erase: string, lineage = L): OwnEntry[] => Array.from({ length: n }, (_, i) => ({ kind: 'kept', token: `test-token-${i}`, lineage, erase }));

  it.each<[string, OwnEnrolment, OwnEnrolmentEvent, OwnEnrolment, unknown[]]>([
    ['empty, enrolled: kept', [], { type: 'enrolled', ...rowB }, [keptB], []],
    ['kept, enrolled with another token: both kept, oldest first', [keptB], { type: 'enrolled', token: TOKEN_C, lineage: L, erase: E1 }, [keptB, keptC], []],
    ['cancelling, enrolled with another token: the owed one stays', [cancellingB], { type: 'enrolled', token: TOKEN_C, lineage: L, erase: E1 }, [cancellingB, keptC], []],
    ['kept, enrolled again with its token: one entry, the new erase', [keptB], { type: 'enrolled', ...rowB, erase: E1 }, [{ ...keptB, erase: E1 }], []],
    ['at the bound: an entry of another lineage goes first',
      [...tokens(1, E0, 'other'), keptB, ...tokens(MAX_OWN - 2, E1)], { type: 'enrolled', token: TOKEN_C, lineage: L, erase: E1 }, [keptB, ...tokens(MAX_OWN - 2, E1), keptC], []],
    ['at the bound: then the oldest that owes no cancel yet',
      [keptB, ...tokens(MAX_OWN - 1, E1)], { type: 'enrolled', token: TOKEN_C, lineage: L, erase: E1 }, [keptB, ...tokens(MAX_OWN - 1, E1).slice(1), keptC], []],
    ['at the bound, every entry owed: the oldest goes',
      tokens(MAX_OWN, E0), { type: 'enrolled', token: TOKEN_C, lineage: L, erase: E1 }, [...tokens(MAX_OWN, E0).slice(1), keptC], []],
    ['empty, settle at a later erase: empty, nothing sent', [], later(), [], []],
    ['kept, settle at the same erase: kept', [keptB], later({ record: E0 }), [keptB], []],
    ['kept, settle at a later erase: cancelling, one cancel', [keptB], later(), [{ ...keptB, kind: 'cancelling', attempt: 'a2.0', since: 2000 }], [cancelB('a2.0')]],
    ['two kept, one owed: only it is cancelled', [keptB, keptC], later({ standing: undefined }), [{ ...keptB, kind: 'cancelling', attempt: 'a2.0', since: 2000 }, keptC], [cancelB('a2.0')]],
    ['kept, settle at a later erase that holds the token active: kept', [keptB], later({ standing: { status: 'active', token: TOKEN_B, email: ADDRESS, provider: 'dropbox', updatedAt: '2026-11-25T00:00:00.000Z' } }), [keptB], []],
    ['kept, settle while this tab\'s erase runs: kept', [keptB], later({ running: true }), [keptB], []],
    ['kept, settle at an unreadable record erase: kept', [keptB], later({ record: '' }), [keptB], []],
    ['kept, settle before the record was read from its store: kept', [keptB], later({ lineage: null }), [keptB], []],
    ['kept, settle on a record of another lineage: kept', [keptB], later({ lineage: 'dropbox' }), [keptB], []],
    ['cancelling, settle inside the claim: cancelling, nothing sent', [cancellingB], later({ now: 1000 + CLAIM_MS - 1 }), [cancellingB], []],
    ['cancelling, settle after the claim: taken again, one cancel', [cancellingB], later({ now: 1000 + CLAIM_MS }), [{ ...keptB, kind: 'cancelling', attempt: 'a2.0', since: 1000 + CLAIM_MS }], [cancelB('a2.0')]],
    ['cancelling, its answer landed: removed', [cancellingB], { type: 'answered', attempt: 'a1', sent: rowB, landed: true }, [], []],
    ['kept (its claim never stored), an ok answer for its row: removed', [keptB], { type: 'answered', attempt: 'a1', sent: rowB, landed: true }, [], []],
    ['kept, an ok answer for its token under an older erase: unchanged', [{ ...keptB, erase: E1 }], { type: 'answered', attempt: 'a1', sent: rowB, landed: true }, [{ ...keptB, erase: E1 }], []],
    ['two kept, an ok answer for one: only it removed', [keptB, keptC], { type: 'answered', attempt: 'a1', sent: rowB, landed: true }, [keptC], []],
    ['cancelling, its answer failed: kept, for the next load or change', [cancellingB], { type: 'answered', attempt: 'a1', sent: rowB, landed: false }, [keptB], []],
    ['cancelling, another attempt\'s failed answer: unchanged', [cancellingB], { type: 'answered', attempt: 'a0', sent: rowB, landed: false }, [cancellingB], []],
    ['kept, this device\'s own cancel landed: removed', [keptB], { type: 'landed', token: TOKEN_B }, [], []],
    ['cancelling, this device\'s own cancel landed: removed', [cancellingB], { type: 'landed', token: TOKEN_B }, [], []],
    ['kept, another token\'s cancel landed: kept', [keptB], { type: 'landed', token: TOKEN_C }, [keptB], []],
  ])('%s', (_name, state, event, next, effects) => {
    expect(ownEnrolmentTransition(state, event)).toEqual({ state: next, effects });
  });
});
