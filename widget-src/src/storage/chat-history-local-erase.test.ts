/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, type ChatHistoryFile } from '@roadmap/health-core';
import { ChatHistoryStore } from './chat-history-store';
import { LocalStorageAdapter, NAMED_FILE_PREFIX } from './local-storage-adapter';
import { RoadmapStore } from './roadmap-store';
import { initRoadmapStore, deleteUserData, flushRoadmapStore } from '../lib/roadmap-data';
import { getChatHistory, setChatHistoryFactory } from '../lib/chat-history-access';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const CHAT_KEY = NAMED_FILE_PREFIX + 'chat-history.json';
const OLD_TEXT = 'SYNTHETIC_PRIVATE_CHAT_BEFORE_ERASE';
const FRESH_TEXT = 'SYNTHETIC_NEW_CHAT_AFTER_ERASE';

async function exchange(store: ChatHistoryStore, id: string, text: string): Promise<void> {
  await store.recordExchange({ conversationId: id, isNew: true, userText: text, assistantText: 'Synthetic answer' });
}
function localFile(): ChatHistoryFile {
  return JSON.parse(localStorage.getItem(CHAT_KEY)!) as ChatHistoryFile;
}
function expectOldAbsent(store: ChatHistoryStore): void {
  expect(store.listConversations().map(c => c.id)).not.toContain('old');
  expect(store.getMessages('old')).toEqual([]);
  expect(localStorage.getItem(CHAT_KEY) ?? '').not.toContain(OLD_TEXT);
}

beforeEach(() => {
  localStorage.clear();
  // No live listeners, polling, or network: two independent real stores share
  // only jsdom localStorage, just as two tabs share one local provider.
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No HTTP allowed')));
});
afterEach(async () => {
  await flushRoadmapStore();
  setChatHistoryFactory(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('US-11 local erase: a stale chat tab must not restore erased history', () => {
  it('real deleteUserData removes local chat keys; an ordinary stale-tab write keeps only fresh chat', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const erasingTab = (await getChatHistory())!;
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    expect(staleTab.getMessages('old')[0].content).toBe(OLD_TEXT);

    expect(await deleteUserData()).toEqual({ success: true, chatErased: true });
    // Full local erasure, NOT retaining identifiers/timestamps as tombstones.
    expect(localStorage.getItem(CHAT_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_KEY + '_rev')).toBeNull();

    // No erase call, reload, or synthetic merge on B: just its ordinary API.
    await exchange(staleTab, 'fresh', FRESH_TEXT);
    expectOldAbsent(staleTab);
    expect(localFile().conversations.filter(c => !c.deleted).map(c => c.id)).toEqual(['fresh']);
    const reopened = await ChatHistoryStore.create(new LocalStorageAdapter());
    expectOldAbsent(reopened);
    expect(reopened.getMessages('fresh').map(m => m.content)).toContain(FRESH_TEXT);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the erasing tab also starts fresh after its chat keys were removed', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const chat = (await getChatHistory())!;
    await exchange(chat, 'old', OLD_TEXT);
    expect((await deleteUserData()).success).toBe(true);
    await exchange(chat, 'fresh', FRESH_TEXT);
    expect(localFile().conversations.map(c => c.id)).toEqual(['fresh']);
    expectOldAbsent(chat);
  });

  it('a stale local store drops its displayed copy when read after delete-all', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const erasingTab = (await getChatHistory())!;
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    await deleteUserData();
    expectOldAbsent(staleTab);
    expect(localStorage.getItem(CHAT_KEY)).toBeNull(); // reading never recreates a file
  });

  it('preserves another tab\'s fresh post-erase history when a stale tab resumes', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const erasingTab = (await getChatHistory())!;
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    await deleteUserData();
    const freshTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    await exchange(freshTab, 'fresh-a', FRESH_TEXT);
    await exchange(staleTab, 'fresh-b', 'SYNTHETIC_OTHER_NEW_CHAT');
    expectOldAbsent(staleTab);
    expect(staleTab.listConversations().map(c => c.id).sort()).toEqual(['fresh-a', 'fresh-b']);
  });

  it('keeps an erased chat fenced after a later device disconnect removes the roadmap', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const erasingTab = (await getChatHistory())!;
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    expect((await deleteUserData()).success).toBe(true);
    await new LocalStorageAdapter().disconnect();
    expect(localStorage.getItem('health_roadmap_file_v2')).toBeNull();
    await exchange(staleTab, 'fresh', FRESH_TEXT);
    expectOldAbsent(staleTab);
    expect(staleTab.getMessages('fresh').map(m => m.content)).toContain(FRESH_TEXT);
  });

  it('corrupt roadmap JSON cannot break chat or bypass an already completed erase', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const erasingTab = (await getChatHistory())!;
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    expect((await deleteUserData()).success).toBe(true);
    const erasedRoadmap = localStorage.getItem('health_roadmap_file_v2')!;
    try {
      localStorage.setItem('health_roadmap_file_v2', '{synthetic-corrupt-roadmap');
      expectOldAbsent(staleTab);
      await exchange(staleTab, 'fresh', FRESH_TEXT);
      expectOldAbsent(staleTab);
      expect(localStorage.getItem('health_roadmap_file_v2')).toBe('{synthetic-corrupt-roadmap');
      const reopened = await ChatHistoryStore.create(new LocalStorageAdapter());
      expectOldAbsent(reopened);
      expect(reopened.getMessages('fresh').map(m => m.content)).toContain(FRESH_TEXT);
    } finally {
      localStorage.setItem('health_roadmap_file_v2', erasedRoadmap);
    }
  });

  it('unrelated roadmap corruption does not interrupt healthy chat or overwrite the roadmap', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const chat = (await getChatHistory())!;
    await exchange(chat, 'old', OLD_TEXT);
    const original = localStorage.getItem('health_roadmap_file_v2')!;
    localStorage.setItem('health_roadmap_file_v2', '{synthetic-corrupt-roadmap');
    expect(chat.getMessages('old')[0].content).toBe(OLD_TEXT);
    await exchange(chat, 'fresh', FRESH_TEXT);
    expect(chat.listConversations().map(c => c.id).sort()).toEqual(['fresh', 'old']);
    expect(localStorage.getItem('health_roadmap_file_v2')).toBe('{synthetic-corrupt-roadmap');
    localStorage.setItem('health_roadmap_file_v2', original);
    expect(chat.getMessages('fresh').map(m => m.content)).toContain(FRESH_TEXT);
  });

  it('reports incomplete cleanup when the content-free erase fence cannot be stored', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    const chat = (await getChatHistory())!;
    await exchange(chat, 'old', OLD_TEXT);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'health_roadmap_local_erase_generation') throw new Error('synthetic quota failure');
      original.call(this, key, value);
    });
    const result = await deleteUserData();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Could not complete on-device history cleanup.');
    expect(localStorage.getItem(CHAT_KEY)).toBeNull();
  });

  it('control: without an erase, normal local writes still union both tabs\' conversations', async () => {
    const first = await ChatHistoryStore.create(new LocalStorageAdapter());
    await exchange(first, 'old', OLD_TEXT);
    const second = await ChatHistoryStore.create(new LocalStorageAdapter());
    await exchange(first, 'fresh', FRESH_TEXT);
    await exchange(second, 'other', 'SYNTHETIC_OTHER_CHAT');
    expect(second.listConversations().map(c => c.id).sort()).toEqual(['fresh', 'old', 'other']);
  });

  it('control: retained local tombstones already block a stale store without the named-file cleanup', async () => {
    const erasingTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new LocalStorageAdapter());
    await erasingTab.eraseAll(); // deliberately NOT the full deleteUserData path
    expect(localFile().conversations[0]).toMatchObject({ id: 'old', deleted: true, title: '', messages: [] });
    await exchange(staleTab, 'fresh', FRESH_TEXT);
    expectOldAbsent(staleTab);
    expect(staleTab.getMessages('fresh').map(m => m.content)).toContain(FRESH_TEXT);
  });

  it('control: a cloud store still merges tombstones and preserves fresh post-erase chat', async () => {
    const cloud = new MemoryCloud();
    const erasingTab = await ChatHistoryStore.create(new MemoryAdapter(cloud));
    await exchange(erasingTab, 'old', OLD_TEXT);
    const staleTab = await ChatHistoryStore.create(new MemoryAdapter(cloud));
    await erasingTab.eraseAll();
    await exchange(staleTab, 'fresh', FRESH_TEXT);
    const file = cloud.files.get('chat-history.json')!.json;
    expect(file).not.toContain(OLD_TEXT);
    expect(file).toContain(FRESH_TEXT);
    expect(staleTab.getMessages('old')).toEqual([]);
    expect(staleTab.listConversations().map(c => c.id)).toEqual(['fresh']);
  });
});
