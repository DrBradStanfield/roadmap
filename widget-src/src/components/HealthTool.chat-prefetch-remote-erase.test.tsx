// @vitest-environment jsdom
/**
 * US-11 AC2g, the remote case: another device erases the record and its chat
 * history in the shared cloud. This page keeps one chat history for its life
 * (chat-history-access.ts), and that copy still holds the erased conversation
 * live, so the list fetched for the new record came from it. The chat file is
 * now read again once the record's erase identity moves, before the list is
 * used; when that read fails, the old list is kept out.
 *
 * No stand-in for the chat list: the real chat-api over a real ChatSession on
 * a shared in-memory cloud (two MemoryAdapters on one MemoryCloud are two
 * devices). Only the floating chat's panel is a stand-in, recording the titles
 * it was handed. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { localDay, rowRootIds } from '@roadmap/health-core/merge';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { ChatHistoryStore } from '../storage/chat-history-store';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { listConversations } from '../lib/chat-api';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
const floating = vi.hoisted(() => ({ opened: [] as Array<string[] | null> }));
vi.mock('./ChatSection', () => ({
  ChatSection: ({ prefetchedData }: { prefetchedData?: { conversations: Array<{ title: string }> } | null }) => {
    floating.opened.push(prefetchedData ? prefetchedData.conversations.map((c) => c.title) : null);
    return <div className="floating-chat-panel" />;
  },
}));
import { HealthTool } from './HealthTool';

const CHAT_FILE = 'chat-history.json';
const TODAY = localDay(new Date());
const OLD_TITLE = 'My LDL of 4.9 and my statin';
const stops: Array<() => void> = [];
let cloud: MemoryCloud;

beforeEach(async () => {
  floating.opened = [];
  localStorage.clear(); sessionStorage.clear();
  // A narrow desktop (under 1200px): the floating chat is the chat.
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
  vi.spyOn(RoadmapStore, 'create');
  cloud = new MemoryCloud();
  // One saved conversation in the user's cloud chat file.
  const chat = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await chat.recordExchange({ conversationId: 'c-old', isNew: true, userText: OLD_TITLE, assistantText: 'Synthetic answer.' });
  await initRoadmapStore(new MemoryAdapter(cloud));
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

const fab = () => document.querySelector<HTMLElement>('.chat-fab');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const thisPagesStore = (): Promise<RoadmapStore> => {
  const created = vi.mocked(RoadmapStore.create).mock.results;
  return created[created.length - 1].value;
};
const openFloatingChat = async () => {
  fireEvent.click(fab()!);
  await waitFor(() => expect(document.querySelector('.floating-chat-panel')).toBeTruthy());
  return floating.opened.at(-1);
};
const titles = async () => (await listConversations())?.conversations.map((c) => c.title) ?? null;

/** Another device erases: its chat erase tombstones the conversation, then
 *  the record erase, as its deleteUserData writes them; it answers the four
 *  questions there before this page re-reads the cloud. */
async function otherDeviceErasesAndStartsAgain() {
  const chat = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await chat.eraseAll();
  const adapter = new MemoryAdapter(cloud);
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
}

async function pageWithChatListed() {
  render(<HealthTool />);
  await waitFor(() => expect(fab()).toBeTruthy());
  await settle();
  // The page's chat history is open and holds the conversation live.
  expect(await titles()).toEqual([OLD_TITLE]);
}

describe('US-11 AC2g: after another device erases the record and its chat, this page\'s chat is not handed the erased list', () => {
  it('control: with no erase, the floating chat opens with the saved conversation', async () => {
    await pageWithChatListed();
    expect(await openFloatingChat()).toEqual([OLD_TITLE]);
  });

  it('the chat file is read again after the erase: the floating chat opens with the new record\'s (empty) list', async () => {
    await pageWithChatListed();
    await otherDeviceErasesAndStartsAgain();
    await act(async () => { await (await thisPagesStore()).refreshFromRemote(); });
    await settle();
    await settle();
    expect(fab()).toBeTruthy();
    const opened = await openFloatingChat();
    expect(opened).toEqual([]);
    // The chat's own list (what it shows when it lists the conversations itself) agrees.
    expect(await titles()).toEqual([]);
  });

  it('the chat file cannot be read after the erase: the erased list is kept out', async () => {
    await pageWithChatListed();
    await otherDeviceErasesAndStartsAgain();
    const read = MemoryAdapter.prototype.read;
    vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementation(function (this: MemoryAdapter, fileName, signal) {
      if (fileName === CHAT_FILE) return Promise.reject(new Error('Synthetic: the cloud did not answer'));
      return read.call(this, fileName, signal);
    });
    await act(async () => { await (await thisPagesStore()).refreshFromRemote(); });
    await settle();
    await settle();
    expect(fab()).toBeTruthy();
    const opened = await openFloatingChat();
    expect(opened ?? []).not.toContain(OLD_TITLE);
    expect((await titles()) ?? []).not.toContain(OLD_TITLE);
    // The chat file was asked for after the erase, and it is the read that failed.
    expect(vi.mocked(MemoryAdapter.prototype.read).mock.calls.some(([f]) => f === CHAT_FILE)).toBe(true);
  });
});
