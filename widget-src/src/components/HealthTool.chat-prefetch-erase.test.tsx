// @vitest-environment jsdom
/**
 * US-11 AC2g: after an erase, the chat is never handed the list the page
 * fetched ahead of time for the erased record. HealthTool lists the
 * conversations once the four answers hold (US-62 AC13), so the floating chat
 * opens with them; the list is the record's. After Delete all my data and a new
 * onboarding, the floating chat must not open with the erased record's
 * conversation titles, and a list asked for before the erase that answers after
 * it must not be used either. The old list may stay in the page's memory,
 * unused, until the new one replaces it or the page reloads; these tests check
 * what the chat is handed.
 *
 * The whole widget renders over a real RoadmapStore on localStorage; only the
 * chat list (listConversations) and the floating chat's panel are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { localDay, rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import type { ChatListResult } from '../lib/chat-api';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
// The chat list, as the store holds it now: each call answers with what
// `list.answer` gives, or waits for the test to release it.
const list = vi.hoisted(() => ({
  calls: 0,
  answer: (): Promise<unknown> => Promise.resolve(null),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => { list.calls += 1; return list.answer(); },
  getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
// The floating chat's panel: the conversation titles it was handed to open with.
const floating = vi.hoisted(() => ({ opened: [] as Array<string[] | null> }));
vi.mock('./ChatSection', () => ({
  ChatSection: ({ prefetchedData }: { prefetchedData?: { conversations: Array<{ title: string }> } | null }) => {
    floating.opened.push(prefetchedData ? prefetchedData.conversations.map((c) => c.title) : null);
    return <div className="floating-chat-panel" />;
  },
}));
import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

const TODAY = localDay(new Date());
const conversations = (...titles: string[]): ChatListResult => ({
  conversations: titles.map((title, i) => ({ id: `c${i}`, title, createdAt: `${TODAY}T10:00:00Z`, updatedAt: `${TODAY}T10:00:00Z` })),
  isGuest: false,
});
const OLD = conversations('My LDL of 4.9 and my statin');
const NONE = conversations();

const stops: Array<() => void> = [];

beforeEach(async () => {
  list.calls = 0;
  list.answer = () => Promise.resolve(OLD);
  floating.opened = [];
  localStorage.clear(); sessionStorage.clear();
  // A narrow desktop (under 1200px): no chat column, so the floating chat is the chat.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/api/events')) return new Response('{"success":true}');
    throw new Error('Synthetic test: no network');
  }));
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => {});
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  // A synthetic returning user with all four answers: the chat is open to them.
  await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
  await addMeasurement('weight', 70, '2026-09-01');
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
const fab = () => document.querySelector<HTMLElement>('.chat-fab');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
}
const leave = (input: Element | null) => act(() => { (input as HTMLElement).blur(); });

async function erase(view: RenderResult) {
  fireEvent.click(deleteButton(view.container)); // in Settings (US-62 AC24)
  await waitFor(() => expect(fab()).toBeNull()); // the record is empty: the chat waits again
}
/** The onboarding's four answers again, on the erased record. */
async function onboardAgain(view: RenderResult) {
  await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
  type(q(view, '#heightCm'), '165');
  leave(q(view, '#heightCm'));
  type(q(view, '#weightKg'), '60');
  leave(q(view, '#weightKg'));
  fireEvent.click(await waitFor(() => view.getByRole('radio', { name: 'Female' })));
  fireEvent.change(await waitFor(() => { const m = q(view, '#birthMonth'); expect(m).toBeTruthy(); return m!; }), { target: { value: '5' } });
  type(await waitFor(() => { const y = q(view, '#birthYear'); expect(y).toBeTruthy(); return y; }), '1975');
  await waitFor(() => expect(fab()).toBeTruthy(), { timeout: 3000 });
}
const openFloatingChat = async () => {
  fireEvent.click(fab()!);
  await waitFor(() => expect(document.querySelector('.floating-chat-panel')).toBeTruthy());
  return floating.opened.at(-1);
};

describe('US-11 AC2g: after an erase, the chat is never handed the list fetched ahead of time for the erased record', () => {
  it('control: before any erase, the floating chat opens with the list fetched ahead of time', async () => {
    render(<HealthTool />);
    await waitFor(() => expect(fab()).toBeTruthy());
    await settle();
    expect(await openFloatingChat()).toEqual(['My LDL of 4.9 and my statin']);
  });

  it('after an erase and a new onboarding, the floating chat does not open with the erased conversations', async () => {
    const view = render(<HealthTool />);
    await waitFor(() => expect(fab()).toBeTruthy());
    await settle();
    expect(list.calls).toBe(1);
    list.answer = () => Promise.resolve(NONE); // the erase emptied the chat history
    await erase(view);
    await settle();
    expect(list.calls).toBe(1); // the chat waits for the four answers again, its list too
    await onboardAgain(view);
    await settle();
    const opened = await openFloatingChat();
    expect(opened ?? []).not.toContain('My LDL of 4.9 and my statin');
    // The new record's list was asked for: the chat opens with it, as it did before the erase.
    expect(list.calls).toBe(2);
    expect(opened).toEqual([]);
  });

  it('a list asked for before the erase that answers after it is not used', async () => {
    let release: (r: ChatListResult) => void = () => {};
    list.answer = () => new Promise((r) => { release = r; });
    const view = render(<HealthTool />);
    await waitFor(() => expect(fab()).toBeTruthy());
    expect(list.calls).toBe(1); // asked, not answered yet
    await erase(view);
    await act(async () => { release(OLD); }); // the old record's list lands after the erase
    list.answer = () => Promise.resolve(NONE);
    await onboardAgain(view);
    await settle();
    const opened = await openFloatingChat();
    expect(opened ?? []).not.toContain('My LDL of 4.9 and my statin');
  });

  it('the new record\'s list cannot be read: the floating chat still does not open with the erased one', async () => {
    const view = render(<HealthTool />);
    await waitFor(() => expect(fab()).toBeTruthy());
    await settle();
    list.answer = () => Promise.resolve(null); // a cloud list that failed to load
    await erase(view);
    await onboardAgain(view);
    await settle();
    expect(list.calls).toBe(2);
    expect(await openFloatingChat()).toBeNull(); // the chat lists the conversations itself
  });

  it('another device erases and starts again with all four answers: the chat opens with the new record\'s list', async () => {
    render(<HealthTool />);
    await waitFor(() => expect(fab()).toBeTruthy());
    await settle();
    expect(list.calls).toBe(1);
    list.answer = () => Promise.resolve(NONE);
    // Another device erases the record, as its deleteUserData writes it, and
    // answers the four questions there before this page re-reads it.
    const adapter = new LocalStorageAdapter();
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const now = new Date(Date.now() + 1000).toISOString();
    const prior = migrateFile(body, { deviceId: 'other-device', now });
    const restarted = migrateFile(null, { deviceId: 'other-device', now });
    const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
    restarted.schemaVersion = CURRENT_SCHEMA_VERSION;
    restarted.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
    restarted.meta.eraseEpoch = epoch;
    restarted.meta.erasedAt = now;
    restarted.profile = { ...restarted.profile, heightCm: 165, sex: 'female', birthYear: 1975, birthMonth: 5 };
    const weight = prior.measurements.find((m) => m.metricType === 'weight')!;
    restarted.measurements = [{ ...weight, id: 'other-device-weight', value: 60, recordedAt: `${TODAY}T09:00:00.000Z`, createdAt: now }];
    await adapter.write(ROADMAP_FILE_NAME, restarted, version);
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    await waitFor(() => expect(list.calls).toBe(2), { timeout: 3000 });
    await settle();
    expect(fab()).toBeTruthy();
    expect(await openFloatingChat()).toEqual([]);
  });
});
