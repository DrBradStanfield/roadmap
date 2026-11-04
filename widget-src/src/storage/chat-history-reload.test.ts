/**
 * US-11 AC2g: the page's one chat history is read again once the record's
 * erase identity moves, so another device's erase reaches it; until then it is
 * not read again. Two MemoryAdapters on one MemoryCloud are two devices.
 * Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { ChatHistoryStore } from './chat-history-store';
import { getChatHistory, openChatHistory, setChatHistoryFactory } from '../lib/chat-history-access';

const CHAT_FILE = 'chat-history.json';

async function savedConversation(cloud: MemoryCloud) {
  const store = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await store.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 4.9', assistantText: 'ok' });
  return store;
}
const otherDeviceErases = async (cloud: MemoryCloud) => (await ChatHistoryStore.create(new MemoryAdapter(cloud))).eraseAll();
const ids = (store: ChatHistoryStore | null) => store?.listConversations().map((c) => c.id) ?? null;

afterEach(() => {
  setChatHistoryFactory(null);
  vi.restoreAllMocks();
});

describe('ChatSession.reload (US-11 AC2g)', () => {
  it('another device\'s erase reaches a copy that still holds the conversation live', async () => {
    const cloud = new MemoryCloud();
    const store = await savedConversation(cloud);
    await otherDeviceErases(cloud);
    expect(ids(store)).toEqual(['c1']); // the copy alone does not see it
    await store.reload();
    expect(ids(store)).toEqual([]);
  });

  it('merges, so a delete this page could not save yet stays deleted', async () => {
    const cloud = new MemoryCloud();
    const store = await savedConversation(cloud);
    vi.spyOn(MemoryAdapter.prototype, 'write').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    await expect(store.deleteConversation('c1')).rejects.toThrow();
    expect((await new MemoryAdapter(cloud).read(CHAT_FILE)).body).toMatchObject({ conversations: [{ id: 'c1' }] });
    await store.reload();
    expect(ids(store)).toEqual([]);
  });
});

describe('the page\'s chat history follows the record\'s erase identity (US-11 AC2g)', () => {
  function register(cloud: MemoryCloud) {
    const identity = { now: 'erase-1' };
    setChatHistoryFactory(() => ChatHistoryStore.create(new MemoryAdapter(cloud)), () => identity.now);
    return identity;
  }
  const chatReads = () => vi.mocked(MemoryAdapter.prototype.read).mock.calls.filter(([f]) => f === CHAT_FILE).length;

  it('is read again once the erase identity moves, and only then', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    vi.spyOn(MemoryAdapter.prototype, 'read');
    expect(ids(await getChatHistory())).toEqual(['c1']);
    await otherDeviceErases(cloud);
    const readsBefore = chatReads();
    expect(ids(await getChatHistory())).toEqual(['c1']); // same erase: the cached copy, no read
    expect(chatReads()).toBe(readsBefore);
    identity.now = 'erase-2';
    const reread = await getChatHistory();
    expect(ids(reread)).toEqual([]);
    expect(chatReads()).toBe(readsBefore + 1);
    expect(await getChatHistory()).toBe(reread); // still the page's one instance
  });

  it('the erase\'s open is read again too when it is the first to ask after the identity moved', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    const first = await getChatHistory();
    expect(ids(first)).toEqual(['c1']);
    await otherDeviceErases(cloud);
    identity.now = 'erase-2';
    const opened = await openChatHistory();
    expect(opened).toBe(first);
    expect(ids(opened)).toEqual([]);
  });

  it('a re-read that fails serves no list; the erase\'s open tries again', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    expect(ids(await getChatHistory())).toEqual(['c1']);
    await otherDeviceErases(cloud);
    identity.now = 'erase-2';
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    expect(await getChatHistory()).toBeNull();
    expect(ids(await openChatHistory())).toEqual([]);
  });
});
