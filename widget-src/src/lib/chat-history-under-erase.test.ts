/**
 * US-11 AC11: the page's chat history is opened under the record's erase
 * identity, so a page that reads a record erased on another device lists no
 * conversation from before that erase, and its next chat save tombstones them.
 * Synthetic data, in-memory cloud, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from '../storage/roadmap-store';
import { flushRoadmapStore, initRoadmapStore } from './roadmap-data';
import { getChatHistory } from './chat-history-access';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./server-api', async importOriginal => ({
  ...await importOriginal<typeof import('./server-api')>(),
  trackProductEvent: vi.fn(),
}));

const CHAT_FILE = 'chat-history.json';
const E = '2026-11-20T10:00:00.000Z';
const conv = (id: string, at: string) => ({
  id, title: `title ${id}`, createdAt: at, updatedAt: at,
  messages: [{ id: `u-${id}`, role: 'user', content: `question ${id}`, createdAt: at }],
});

function erased() {
  const file = createEmptyFile({ deviceId: 'other', now: E });
  return { ...file, meta: { ...file.meta, eraseEpoch: 1, erasedAt: E } };
}

describe('US-11 AC11: the web opens its chat history under the record\'s erase', () => {
  let cloud: MemoryCloud;
  beforeEach(async () => {
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Health CRUD must not use HTTP')));
    const keys = new Map([['health_roadmap_backend', 'memory']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => keys.get(k) ?? null,
      setItem: (k: string, v: string) => void keys.set(k, v),
      removeItem: (k: string) => void keys.delete(k),
      key: (i: number) => [...keys.keys()][i] ?? null,
      get length() { return keys.size; },
      clear: () => keys.clear(),
    });
    // Another device erased the record at E; the chat file still holds one
    // conversation from before it and one from after.
    cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(erased()), version: 1 });
    cloud.files.set(CHAT_FILE, { json: JSON.stringify({ schemaVersion: 1, conversations: [conv('old', '2026-11-20T09:00:00.000Z'), conv('new', '2026-11-20T11:00:00.000Z')] }), version: 1 });
    await initRoadmapStore(new MemoryAdapter(cloud));
  });
  afterEach(async () => {
    await flushRoadmapStore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists only the conversation from after the erase, and the next save tombstones the other', async () => {
    const store = (await getChatHistory())!;
    expect(store.listConversations().map((c) => c.id)).toEqual(['new']);
    await store.recordExchange({ conversationId: 'next', isNew: true, userText: 'hello', assistantText: 'ok' });
    const old = JSON.parse(cloud.files.get(CHAT_FILE)!.json).conversations.find((c: { id: string }) => c.id === 'old');
    expect(old).toMatchObject({ deleted: true, title: '', messages: [] });
  });
});
