/**
 * US-11 · "Delete all my data" must reach chat-history.json.
 *
 * The record erase (RoadmapStore.deleteUserData) touches health-roadmap.json
 * only, and chat history is a SEPARATE file whose merge unions conversations by
 * id — writing it empty would be resurrected by any other device's copy. So the
 * erase tombstones every conversation instead: tombstones are monotonic, and a
 * blanked title carries a bumped updatedAt so the "newer side wins" rule can't
 * bring the old title back either.
 */
import { describe, it, expect } from 'vitest';
import { MemoryAdapter, MemoryCloud, mergeChatHistoryFiles, type ChatHistoryFile } from '@roadmap/health-core';
import { ChatHistoryStore } from './chat-history-store';

const CHAT_FILE = 'chat-history.json';

function readCloud(cloud: MemoryCloud): ChatHistoryFile {
  return JSON.parse(cloud.files.get(CHAT_FILE)!.json) as ChatHistoryFile;
}

async function seed(cloud: MemoryCloud): Promise<ChatHistoryStore> {
  const store = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await store.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 3.2', assistantText: 'ok' });
  await store.recordExchange({ conversationId: 'c2', isNew: true, userText: 'what about my blood pressure', assistantText: 'ok' });
  return store;
}

describe('ChatHistoryStore.eraseAll (US-11)', () => {
  it('tombstones every conversation, drops the messages and blanks the titles', async () => {
    const cloud = new MemoryCloud();
    const store = await seed(cloud);
    expect(store.listConversations()).toHaveLength(2);

    await store.eraseAll();

    expect(store.listConversations()).toEqual([]);
    const file = readCloud(cloud);
    expect(file.conversations).toHaveLength(2); // tombstones, not a blank file
    for (const conv of file.conversations) {
      expect(conv.deleted).toBe(true);
      expect(conv.messages).toEqual([]);
      // The title is the last place the user's own words survive in this file.
      expect(conv.title).toBe('');
    }
    // No message text of any kind is left in the persisted JSON.
    expect(cloud.files.get(CHAT_FILE)!.json).not.toMatch(/ldl|blood pressure/);
  });

  it('survives a merge with another device\'s pre-erase copy (tombstones + blank titles win)', async () => {
    const cloud = new MemoryCloud();
    const store = await seed(cloud);
    // Device B's copy, taken BEFORE the erase: full titles, full messages.
    const stale = readCloud(cloud);
    expect(stale.conversations.every((c) => c.deleted !== true)).toBe(true);

    await store.eraseAll();
    const erased = readCloud(cloud);

    const merged = mergeChatHistoryFiles(stale, erased, { deviceId: 'device-b', now: new Date().toISOString() });
    for (const conv of merged.conversations) {
      expect(conv.deleted).toBe(true);
      expect(conv.messages).toEqual([]);
      expect(conv.title).toBe('');
    }
  });

  it('refuses a later recordExchange on an erased conversation (no resurrection)', async () => {
    const cloud = new MemoryCloud();
    const store = await seed(cloud);
    await store.eraseAll();

    await store.recordExchange({ conversationId: 'c1', isNew: false, userText: 'still there?', assistantText: 'no' });

    expect(store.listConversations()).toEqual([]);
    expect(store.getMessages('c1')).toEqual([]);
    expect(cloud.files.get(CHAT_FILE)!.json).not.toMatch(/still there/);
  });

  it('writes nothing when there is no history to erase', async () => {
    const cloud = new MemoryCloud();
    const store = await ChatHistoryStore.create(new MemoryAdapter(cloud));
    await store.eraseAll();
    expect(cloud.files.has(CHAT_FILE)).toBe(false);
  });
});
