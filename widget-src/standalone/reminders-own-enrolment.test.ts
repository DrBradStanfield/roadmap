// @vitest-environment jsdom
/**
 * US-11 AC4c (lead H126): a device that turns reminders on settles its own
 * row after a later erase made elsewhere. The real data layer and store run
 * over an in-memory cloud; only the reminders server is stubbed. Synthetic
 * address and tokens, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { buildErasedFile } from '@roadmap/health-core/erase';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { CLAIM_MS, ownEnrolmentTransition, type OwnEnrolment, type OwnEnrolmentEvent } from './reminders-own-enrolment';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const ADDRESS = 'synthetic-person@example.com';
const TOKEN_B = 'test-token-b';
const KEY = 'hr_reminders_own_enrolment';
const REMOTE = 'hr:remote-changed';

type Posted = { op: string; token?: string };
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
  vi.resetModules();
});

/** The reminders server: an optin answers TOKEN_B; a cancel answers `cancelStatus()`. */
function server(cancelStatus: () => number = () => 200) {
  const posts: Posted[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posts.push(body);
    if (body.op === 'optin') return new Response(JSON.stringify({ token: TOKEN_B, email: ADDRESS }), { status: 200 });
    return new Response('{}', { status: body.op === 'cancel' ? cancelStatus() : 200 });
  }));
  return { posts, cancels: () => posts.filter((p) => p.op === 'cancel') };
}

/** Lets queued work run until `done` holds (at most about two seconds). */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
}

/** Page B loads over `cloud`, wired as standalone/app.tsx wires it. */
async function loadPage(cloud: MemoryCloud) {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  const own = await import('./reminders-own-enrolment');
  const { RoadmapStore } = await import('../src/storage/roadmap-store');
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  let page!: import('../src/storage/roadmap-store').RoadmapStore;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: import('../src/storage/roadmap-store').RoadmapStore) {
    page = this;
    return () => {};
  });
  await data.initRoadmapStore(new MemoryAdapter(cloud));
  data.setPreEraseHook(reminders.cancelRemindersForErase);
  const openTab = () => stops.push(own.startOwnEnrolment((token) => reminders.postCancel(token, null, true)));
  openTab();
  /** Another device writes straight to the cloud; this page has not re-read. */
  const otherDevice = () => RoadmapStore.create(new MemoryAdapter(cloud));
  return { data, reminders, openTab, otherDevice, reread: () => page.refreshFromRemote() };
}

/** Another writer's erase with no reminders step: the erased file, written bare. */
function bareErase(cloud: MemoryCloud): void {
  const held = cloud.files.get(ROADMAP_FILE_NAME)!;
  const stored = JSON.parse(held.json) as RoadmapFile;
  const erased = buildErasedFile({ stored, own: stored, device: null, ctx: { deviceId: 'other-writer', now: new Date().toISOString() } });
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(erased), version: held.version + 1 });
}

/** Page B turns reminders on; its token reaches the cloud file. */
async function enrol(page: Awaited<ReturnType<typeof loadPage>>) {
  expect((await page.reminders.optInToReminders('dropbox', { email: ADDRESS })).refreshed).toBe(false);
  expect(page.data.getReminderOptIn()).toMatchObject({ status: 'active', token: TOKEN_B });
}

function storedValues(): string {
  return JSON.stringify(Object.keys(localStorage).map((key) => localStorage.getItem(key)));
}

describe('US-11 AC4c: a device that turns reminders on settles its own row after a later erase (lead H126)', () => {
  it('B\'s opt-in landed before another device\'s erase write: B cancels its row when it takes the erase in', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
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
    for (const stop of stops.splice(0)) stop();
    vi.resetModules(); // B closes; its localStorage stays
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
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ kind: 'kept', token: TOKEN_B });
  });

  it('a failed cancel keeps the token until a cancel lands, at the next merged-in change or the next load; then no token is in localStorage', async () => {
    let status = 503;
    const http = server(() => status);
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => http.cancels().length === 1 && JSON.parse(localStorage.getItem(KEY) ?? '{}').kind === 'kept');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ kind: 'kept', token: TOKEN_B });

    // The next merged-in change tries again, and fails again.
    window.dispatchEvent(new Event(REMOTE));
    await settle(() => http.cancels().length === 2 && JSON.parse(localStorage.getItem(KEY) ?? '{}').kind === 'kept');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ kind: 'kept', token: TOKEN_B });

    // The next load tries again, and lands.
    for (const stop of stops.splice(0)) stop();
    vi.resetModules();
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

  it('B\'s own erase commit removes the key: a later erase sends no second cancel', async () => {
    const http = server();
    const cloud = new MemoryCloud();
    const b = await loadPage(cloud);
    await enrol(b);
    expect((await b.data.deleteUserData()).success).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    bareErase(cloud);

    expect(await b.reread()).toBe(true);
    await settle(() => false);

    expect(http.cancels()).toEqual([{ op: 'cancel', token: TOKEN_B }]);
  });
});

describe('US-11 AC4c: the own-enrolment transition table (lead H126)', () => {
  const E0 = JSON.stringify([0, null]);
  const E1 = JSON.stringify([1, '2026-11-25T00:00:00.000Z']);
  const none: OwnEnrolment = { kind: 'none' };
  const kept: OwnEnrolment = { kind: 'kept', token: TOKEN_B, erase: E0 };
  const cancelling: OwnEnrolment = { kind: 'cancelling', token: TOKEN_B, erase: E0, attempt: 'a1', since: 1000 };
  const later = (over: Partial<Extract<OwnEnrolmentEvent, { type: 'settle' }>> = {}): OwnEnrolmentEvent => ({
    type: 'settle', record: E1, standing: { status: 'cancelled', token: '', email: '', provider: 'dropbox', updatedAt: '2026-11-25T00:00:00.000Z' }, running: false, now: 2000, attempt: 'a2', ...over,
  });
  const cancelA2 = [{ type: 'cancel', token: TOKEN_B, attempt: 'a2' }];

  it.each<[string, OwnEnrolment, OwnEnrolmentEvent, OwnEnrolment, unknown[]]>([
    ['none, enrolled: kept', none, { type: 'enrolled', token: TOKEN_B, erase: E0 }, kept, []],
    ['kept, enrolled with another token: the new one kept', kept, { type: 'enrolled', token: 'test-token-c', erase: E1 }, { kind: 'kept', token: 'test-token-c', erase: E1 }, []],
    ['none, settle at a later erase: none, nothing sent', none, later(), none, []],
    ['kept, settle at the same erase: kept', kept, later({ record: E0 }), kept, []],
    ['kept, settle at a later erase: cancelling, one cancel', kept, later(), { kind: 'cancelling', token: TOKEN_B, erase: E0, attempt: 'a2', since: 2000 }, cancelA2],
    ['kept, settle at a later erase that holds the token active: kept', kept, later({ standing: { status: 'active', token: TOKEN_B, email: ADDRESS, provider: 'dropbox', updatedAt: '2026-11-25T00:00:00.000Z' } }), kept, []],
    ['kept, settle while this tab\'s erase runs: kept', kept, later({ running: true }), kept, []],
    ['kept, settle at an unreadable record erase: kept', kept, later({ record: '' }), kept, []],
    ['cancelling, settle inside the claim: cancelling, nothing sent', cancelling, later({ now: 1000 + CLAIM_MS - 1 }), cancelling, []],
    ['cancelling, settle after the claim: taken again, one cancel', cancelling, later({ now: 1000 + CLAIM_MS }), { kind: 'cancelling', token: TOKEN_B, erase: E0, attempt: 'a2', since: 1000 + CLAIM_MS }, cancelA2],
    ['cancelling, its answer landed: none', cancelling, { type: 'answered', attempt: 'a1', landed: true }, none, []],
    ['cancelling, its answer failed: kept, for the next load or change', cancelling, { type: 'answered', attempt: 'a1', landed: false }, kept, []],
    ['cancelling, another attempt\'s answer: unchanged', cancelling, { type: 'answered', attempt: 'a0', landed: true }, cancelling, []],
    ['kept, an answer: unchanged', kept, { type: 'answered', attempt: 'a1', landed: true }, kept, []],
    ['kept, its own Turn off: none', kept, { type: 'turned-off', token: TOKEN_B }, none, []],
    ['kept, a Turn off of another token: kept', kept, { type: 'turned-off', token: 'test-token-c' }, kept, []],
    ['cancelling, its own Turn off: none', cancelling, { type: 'turned-off', token: TOKEN_B }, none, []],
    ['kept, this tab\'s erase commit cancels it: none', kept, { type: 'erased-here', tokens: ['test-token-a', TOKEN_B] }, none, []],
    ['kept, this tab\'s erase commit cancels others: kept', kept, { type: 'erased-here', tokens: ['test-token-a'] }, kept, []],
  ])('%s', (_name, state, event, next, effects) => {
    expect(ownEnrolmentTransition(state, event)).toEqual({ state: next, effects });
  });
});
