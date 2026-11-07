/**
 * US-11 AC2g: the page's one chat history is read again once the record's
 * erase identity moves, so another device's erase reaches it; until then it is
 * not read again. Two MemoryAdapters on one MemoryCloud are two devices.
 * Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, type WriteResult } from '@roadmap/health-core';
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
    expect(chatReads()).toBe(1); // the open's own read only
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

  it('a store the erase\'s open opened is read again too once the identity moves', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    const opened = await openChatHistory(); // the first to open it this page
    expect(ids(opened)).toEqual(['c1']);
    await otherDeviceErases(cloud);
    identity.now = 'erase-2';
    const reread = await getChatHistory();
    expect(reread).toBe(opened);
    expect(ids(reread)).toEqual([]);
  });

  it('a re-read that fails serves no list; the erase\'s open tries again', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    const first = await getChatHistory();
    expect(ids(first)).toEqual(['c1']);
    await otherDeviceErases(cloud);
    identity.now = 'erase-2';
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    expect(await getChatHistory()).toBeNull();
    const opened = await openChatHistory();
    expect(opened).toBe(first); // the page's one session, read again
    expect(ids(opened)).toEqual([]);
  });

  it('when the erase\'s open cannot read the file again either, it rejects and opens no second session', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = { now: 'erase-1' };
    const factory = vi.fn(() => ChatHistoryStore.create(new MemoryAdapter(cloud)));
    setChatHistoryFactory(factory, () => identity.now);
    const first = await getChatHistory();
    identity.now = 'erase-2';
    const read = vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValue(new Error('Synthetic: the cloud did not answer'));
    await expect(openChatHistory()).rejects.toThrow('Synthetic');
    expect(factory).toHaveBeenCalledTimes(1);
    read.mockRestore();
    expect(await getChatHistory()).toBe(first); // read again once the cloud answers, still the same session
  });

  it('when both reads fail, the erase\'s open tombstones the page\'s copy and still rejects, so deleting the file by hand lasts', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    expect(ids(await getChatHistory())).toEqual(['c1']);
    identity.now = 'erase-2'; // another device erased the record; its chat step failed, so the file still holds c1 live
    const read = vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValue(new Error('Synthetic: the cloud did not answer'));
    await expect(openChatHistory()).rejects.toThrow('Synthetic'); // the alert says the file could not be read
    read.mockRestore();
    cloud.files.delete(CHAT_FILE); // the user deletes chat-history.json by hand, as the alert says
    const next = (await getChatHistory())!; // and chats again in the same tab
    expect(ids(next)).toEqual([]);
    await next.recordExchange({ conversationId: 'c2', isNew: true, userText: 'my bp is 128/82', assistantText: 'ok' });
    expect(await storedLive(cloud)).toEqual(['c2']);
  });

  it('when both reads fail but the erase\'s own save gets through, the open answers with the page\'s erased session', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    const page = await getChatHistory();
    identity.now = 'erase-2';
    vi.spyOn(MemoryAdapter.prototype, 'read')
      .mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'))
      .mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    expect(await openChatHistory()).toBe(page);
    expect(await storedLive(cloud)).toEqual([]);
  });

  it('a failed open is kept for the chat\'s callers, even once the identity moves; the erase\'s first open tries once', async () => {
    const cloud = new MemoryCloud();
    const identity = { now: 'erase-1' };
    const factory = vi.fn(() => ChatHistoryStore.create(new MemoryAdapter(cloud)));
    setChatHistoryFactory(factory, () => identity.now);
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    await expect(openChatHistory()).rejects.toThrow('Synthetic');
    expect(factory).toHaveBeenCalledTimes(1);
    identity.now = 'erase-2';
    expect(await getChatHistory()).toBeNull();
  });

  it('a re-read that fails is not kept: once the cloud answers, the next caller gets the merged copy and new exchanges are saved', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const identity = register(cloud);
    expect(ids(await getChatHistory())).toEqual(['c1']);
    await otherDeviceErases(cloud);
    identity.now = 'erase-2';
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    expect(await getChatHistory()).toBeNull(); // no list from before the erase
    const next = await getChatHistory(); // the cloud answers again: read again, no page reload
    expect(ids(next)).toEqual([]);
    await next!.recordExchange({ conversationId: 'c2', isNew: true, userText: 'my bp is 128/82', assistantText: 'ok' });
    const stored = (await new MemoryAdapter(cloud).read(CHAT_FILE)).body as { conversations: { id: string; deleted?: boolean }[] };
    expect(stored.conversations.filter((c) => !c.deleted).map((c) => c.id)).toEqual(['c2']);
    expect(await getChatHistory()).toBe(next); // read once; the same instance after that
  });
});

/** Drive-shaped: a write checks the version, then uploads. The upload after
 *  `holdNextUpload()` waits after its check until released. */
class CheckThenUpload extends MemoryAdapter {
  private gate: Promise<void> | null = null;
  release = (): void => undefined;
  holdNextUpload(): void {
    this.gate = new Promise((resolve) => { this.release = resolve; });
  }
  async write(fileName: string, body: object, expected: string | null): Promise<WriteResult> {
    const entry = this.cloud.files.get(fileName);
    if (expected !== (entry ? String(entry.version) : null)) return super.write(fileName, body, expected); // the check fails
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    const version = (this.cloud.files.get(fileName)?.version ?? 0) + 1;
    this.cloud.files.set(fileName, { json: JSON.stringify(body), version });
    return { version: String(version) };
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const storedLive = async (cloud: MemoryCloud) => ((await new MemoryAdapter(cloud).read(CHAT_FILE)).body as { conversations: { id: string; deleted?: boolean }[] })
  .conversations.filter((c) => !c.deleted).map((c) => c.id);

describe('a failed re-read never replaces the page\'s open session (US-11 AC2g)', () => {
  it('the erase runs on the session whose upload is held, so that upload stays on its save queue', async () => {
    const cloud = new MemoryCloud();
    const adapter = new CheckThenUpload(cloud);
    const identity = { now: 'erase-1' };
    const factory = vi.fn(() => ChatHistoryStore.create(adapter));
    setChatHistoryFactory(factory, () => identity.now);
    const page = (await getChatHistory())!;
    await page.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 4.9', assistantText: 'ok' });
    // A caller holding the session (chat-api's recordExchange) saves an
    // exchange; its upload has passed its version check and is held.
    adapter.holdNextUpload();
    const held = page.recordExchange({ conversationId: 'c2', isNew: true, userText: 'and my statin', assistantText: 'ok' });
    await settle();
    identity.now = 'erase-2'; // another device erased the record
    vi.spyOn(adapter, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    // Delete all my data: the erase's open, whose re-read fails once.
    const erase = (await openChatHistory())!;
    expect(erase).toBe(page);
    expect(factory).toHaveBeenCalledTimes(1);
    const erasing = erase.eraseAll();
    await settle();
    adapter.release();
    await Promise.all([held, erasing]);
    expect(ids(page)).toEqual([]);
    // The page's next save keeps both erased conversations erased.
    const next = (await getChatHistory())!;
    expect(next).toBe(page);
    await next.recordExchange({ conversationId: 'c3', isNew: true, userText: 'my bp is 128/82', assistantText: 'ok' });
    expect(await storedLive(cloud)).toEqual(['c3']);
  });
});

describe('the page opens one session, whoever asks first (US-11 AC2g)', () => {
  it('the erase\'s first open and a chat list asked for in the next microtask share one session, so a held upload cannot restore the erase', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud); // saved in an earlier page; nothing is open on this one
    const adapter = new CheckThenUpload(cloud);
    const factory = vi.fn(() => ChatHistoryStore.create(adapter));
    setChatHistoryFactory(factory, () => 'erase-1');
    const opening = openChatHistory(); // Delete all my data, the first to ask
    await Promise.resolve();
    const page = (await getChatHistory())!; // the chat list, in the next microtask
    adapter.holdNextUpload();
    const held = page.recordExchange({ conversationId: 'c2', isNew: true, userText: 'and my statin', assistantText: 'ok' });
    await settle();
    const erase = (await opening)!;
    expect(erase).toBe(page);
    expect(factory).toHaveBeenCalledTimes(1);
    const erasing = erase.eraseAll();
    await settle();
    adapter.release();
    await Promise.all([held, erasing]);
    expect(ids(page)).toEqual([]);
    const next = (await getChatHistory())!;
    expect(next).toBe(page);
    await next.recordExchange({ conversationId: 'c3', isNew: true, userText: 'my bp is 128/82', assistantText: 'ok' });
    expect(await storedLive(cloud)).toEqual(['c3']);
  });

  it('whichever microtask the chat list asks in, the page opens one session', async () => {
    for (let ticks = 0; ticks < 4; ticks++) {
      const factory = vi.fn(() => ChatHistoryStore.create(new MemoryAdapter(new MemoryCloud())));
      setChatHistoryFactory(factory);
      const opening = openChatHistory();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      const listed = await getChatHistory();
      expect(await opening).toBe(listed);
      expect(factory).toHaveBeenCalledTimes(1);
    }
  });

  it('two erase opens after a failed first open open one session between them', async () => {
    const cloud = new MemoryCloud();
    await savedConversation(cloud);
    const factory = vi.fn(() => ChatHistoryStore.create(new MemoryAdapter(cloud)));
    setChatHistoryFactory(factory, () => 'erase-1');
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('Synthetic: the cloud did not answer'));
    expect(await getChatHistory()).toBeNull(); // the first open failed
    const [a, b] = await Promise.all([openChatHistory(), openChatHistory()]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(2); // the failed open, and one more
    expect(await getChatHistory()).toBe(a);
  });
});
