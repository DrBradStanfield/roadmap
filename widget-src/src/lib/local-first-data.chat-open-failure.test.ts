/**
 * US-11 AC2c: "Delete all my data" never says the chat history was deleted
 * when the history could not be opened.
 *
 * getChatHistory() resolves null when the chat file cannot be opened (a cloud
 * read that fails, a file from a newer schema, or a null cached from an
 * earlier failure this page). The erase ran `(await steps.chat?.())?.eraseAll()`
 * on that null, a no-op, then set chatErased, so the page said the history was
 * deleted, Sentry heard nothing, and every conversation stayed in the cloud.
 * Synthetic data, in-memory cloud, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { initRoadmapStore, flushRoadmapStore } from './roadmap-data';
import * as data from './roadmap-data';
import { getChatHistory, setChatHistoryFactory } from './chat-history-access';
import { Sentry } from './sentry';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./server-api', async importOriginal => ({
  ...await importOriginal<typeof import('./server-api')>(),
  trackProductEvent: vi.fn(),
}));

const CHAT_FILE = 'chat-history.json';
const live = (cloud: MemoryCloud) =>
  JSON.parse(cloud.files.get(CHAT_FILE)!.json).conversations.filter((c: { deleted?: boolean }) => !c.deleted);
const chatReported = () => expect(Sentry.captureException).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({ tags: expect.objectContaining({ area: 'chat-history' }) }),
);

/** Make reads of the chat file fail (or work again) on every MemoryAdapter. */
function chatReads(fail: () => boolean): void {
  const read = MemoryAdapter.prototype.read;
  vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementation(function (this: MemoryAdapter, fileName, signal) {
    if (fileName === CHAT_FILE && fail()) return Promise.reject(new Error('chat cloud unreachable'));
    return read.call(this, fileName, signal);
  });
}

describe('US-11 AC2c: an erase whose chat history could not be opened', () => {
  let cloud: MemoryCloud;
  beforeEach(async () => {
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Health CRUD must not use HTTP')));
    cloud = new MemoryCloud();
    await initRoadmapStore(new MemoryAdapter(cloud));
    // A conversation saved in an earlier page.
    const first = await getChatHistory();
    await first!.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 3.2', assistantText: 'ok' });
    // A fresh page: initRoadmapStore resets the chat-store cache.
    await initRoadmapStore(new MemoryAdapter(cloud));
  });
  afterEach(async () => {
    await flushRoadmapStore();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not claim the chat history was erased, and reports the failure', async () => {
    chatReads(() => true);
    const result = await data.deleteUserData();

    expect(result.success).toBe(true);
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).meta.eraseEpoch).toBe(1);
    expect(live(cloud)).toHaveLength(1);
    expect(result.chatErased).toBe(false);
    expect(result.chatUnread).toBe(true);
    chatReported();
  });

  it('reports only a fixed message, never the open error, which can quote the file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = MemoryAdapter.prototype.read;
    vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementation(function (this: MemoryAdapter, fileName, signal) {
      if (fileName === CHAT_FILE) return Promise.reject(new Error('Unexpected token in JSON near "metformin 500 mg"', { cause: new Error('metformin') }));
      return read.call(this, fileName, signal);
    });
    await data.deleteUserData();
    chatReported();
    const seen = JSON.stringify([
      vi.mocked(Sentry.captureException).mock.calls.map(([e]) => [String(e), String((e as Error)?.cause ?? '')]),
      warn.mock.calls.map(args => args.map(a => (a instanceof Error ? `${a.message} ${String(a.cause ?? '')}` : String(a)))),
    ]);
    expect(seen).not.toContain('metformin');
  });

  it('tries the open again when an earlier chat open this page failed, and erases', async () => {
    let down = true;
    chatReads(() => down);
    expect(await getChatHistory()).toBeNull(); // the blip, cached for the page
    down = false;

    const result = await data.deleteUserData();

    expect(result.success).toBe(true);
    expect(result.chatErased).toBe(true);
    expect(result.chatUnread).toBeUndefined();
    expect(live(cloud)).toHaveLength(0);
    // The erased store is the shared one, so a chat opened next sees the tombstones.
    expect((await getChatHistory())!.listConversations()).toHaveLength(0);
  });

  it('control: a store already open is the one erased', async () => {
    const open = await getChatHistory();
    const result = await data.deleteUserData();

    expect(result.chatErased).toBe(true);
    expect(result.chatUnread).toBeUndefined();
    expect(open!.listConversations()).toHaveLength(0);
    expect(await getChatHistory()).toBe(open);
    expect(live(cloud)).toHaveLength(0);
  });

  it('with no chat layer registered there is no history, and nothing is reported', async () => {
    setChatHistoryFactory(null);
    const result = await data.deleteUserData();

    expect(result.chatErased).toBe(true);
    expect(result.chatUnread).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ area: 'chat-history' }) }),
    );
  });
});
