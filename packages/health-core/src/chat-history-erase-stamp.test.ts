/**
 * US-11 AC11: each chat-history conversation records the record's erase
 * identity its first question was asked under (`under`). Set once, kept by
 * every merge, migrate and reply, and read by nothing yet: listing, reading,
 * saving and tombstones behave as they did without it.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import {
  CHAT_HISTORY_SCHEMA_VERSION,
  mergeChatHistoryFiles,
  migrateChatHistoryFile,
  type ChatFileConversation,
  type ChatHistoryFile,
} from './chat-history';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';

let clock = Date.parse('2026-11-20T10:00:00.000Z');
const host = (store: MemoryAdapter) => ({
  store, deviceId: () => 'phone', clock: { now: () => (clock += 1) },
  timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
  clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {}, tier: 'cloud',
  mirror: { adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
}) as RecordHost;

/** Erase identities as `eraseIdentityOf` writes them: [epoch, erasedAt]. */
const FIRST = JSON.stringify([1, '2026-11-01T00:00:00.000Z']);
const SECOND = JSON.stringify([2, '2026-11-10T00:00:00.000Z']);

const stored = async (store: MemoryAdapter): Promise<ChatHistoryFile> => (await store.read('chat-history.json')).body as ChatHistoryFile;
const storedConv = async (store: MemoryAdapter, id: string) => (await stored(store)).conversations.find((c) => c.id === id);

describe('US-11 AC11: a conversation records the erase it was started under', () => {
  it('a new conversation carries the identity its question was asked under', async () => {
    const store = new MemoryAdapter();
    const s = await ChatSession.open(host(store));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q', assistantText: 'a', askedUnder: FIRST });
    expect((await storedConv(store, 'c1'))?.under).toBe(FIRST);
  });

  it('a reply never rewrites the stamp, even asked under a later erase', async () => {
    const store = new MemoryAdapter();
    const s = await ChatSession.open(host(store));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1', askedUnder: FIRST });
    await s.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q2', assistantText: 'a2', askedUnder: SECOND });
    const again = await ChatSession.open(host(store));
    await again.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q3', assistantText: 'a3', askedUnder: SECOND });
    expect((await storedConv(store, 'c1'))?.under).toBe(FIRST);
  });

  it('a reply into a conversation started without a stamp leaves it without one', async () => {
    const store = new MemoryAdapter();
    const s = await ChatSession.open(host(store));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1' });
    await s.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q2', assistantText: 'a2', askedUnder: SECOND });
    expect(await storedConv(store, 'c1')).not.toHaveProperty('under');
  });
});

const conv = (id: string, updatedAt: string, extra: Partial<ChatFileConversation> = {}): ChatFileConversation => ({
  id, title: 'Chat', createdAt: '2026-11-01T00:00:00.000Z', updatedAt, messages: [], ...extra,
});
const file = (conversations: ChatFileConversation[]): ChatHistoryFile => ({
  schemaVersion: CHAT_HISTORY_SCHEMA_VERSION,
  meta: { createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', lastDeviceId: 'd', lamport: 1 },
  conversations,
});
const CTX = { deviceId: 'dev', now: '2026-11-20T00:00:00.000Z' };
const merged = (a: ChatFileConversation, b: ChatFileConversation) => mergeChatHistoryFiles(file([a]), file([b]), CTX).conversations[0];

describe('US-11 AC11: the merge keeps the stamp', () => {
  // The newer side (by updatedAt) holds the later erase or none, so its
  // "newer side wins" spread alone would get the stamp wrong.
  const OLD = '2026-11-02T00:00:00.000Z';
  const NEW = '2026-11-03T00:00:00.000Z';
  const table: Array<[string, ChatFileConversation, ChatFileConversation, string | undefined]> = [
    ['neither stamped', conv('c', OLD), conv('c', NEW), undefined],
    ['only the older side stamped', conv('c', OLD, { under: FIRST }), conv('c', NEW), FIRST],
    ['only the newer side stamped', conv('c', OLD), conv('c', NEW, { under: SECOND }), SECOND],
    ['both stamped, equal', conv('c', OLD, { under: FIRST }), conv('c', NEW, { under: FIRST }), FIRST],
    ['both stamped, different: the earlier erase', conv('c', OLD, { under: FIRST }), conv('c', NEW, { under: SECOND }), FIRST],
    ['a tombstone keeps its stamp', conv('c', OLD, { under: FIRST }), conv('c', NEW, { deleted: true, title: '' }), FIRST],
    ['an unreadable stamp is the earlier one', conv('c', OLD, { under: 'garbled' }), conv('c', NEW, { under: FIRST }), 'garbled'],
  ];

  it.each(table)('%s', (_name, a, b, under) => {
    const ab = merged(a, b);
    expect(ab.under).toBe(under);
    expect(merged(b, a)).toEqual(ab); // commutative
    expect(merged(ab, ab)).toEqual(ab); // idempotent
    expect(merged(ab, a)).toEqual(ab);
    expect(merged(ab, b)).toEqual(ab);
    if (under === undefined) expect(ab).not.toHaveProperty('under');
  });

  it('two stamps that tie on the erase order merge the same both ways', () => {
    const a = conv('c', OLD, { under: 'garbled-1' });
    const b = conv('c', NEW, { under: 'garbled-2' });
    expect(merged(a, b)).toEqual(merged(b, a));
  });
});

describe('US-11 AC11: the stamp survives a client that only spreads the conversation', () => {
  it('through migrate, a reply with no stamp of its own, and a merge with an unstamped copy', async () => {
    const raw = file([conv('c1', '2026-11-02T00:00:00.000Z', { title: 'q', under: FIRST, messages: [
      { id: 'u-1', role: 'user', content: 'q', createdAt: '2026-11-02T00:00:00.000Z' },
    ] })]);
    expect(migrateChatHistoryFile(structuredClone(raw), CTX).conversations[0].under).toBe(FIRST);

    const cloud = new MemoryCloud();
    const store = new MemoryAdapter(cloud);
    await store.write('chat-history.json', raw, null);
    const s = await ChatSession.open(host(store));
    // The iPhone engine and an older build pass no stamp.
    await s.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q2', assistantText: 'a2' });
    expect((await storedConv(store, 'c1'))?.under).toBe(FIRST);

    const other = file([conv('c1', '2026-11-30T00:00:00.000Z', { title: 'q' })]);
    expect(mergeChatHistoryFiles(other, await stored(store), CTX).conversations[0].under).toBe(FIRST);
  });

  it('migrate drops a stamp that is not a string', () => {
    const raw = file([conv('c1', '2026-11-02T00:00:00.000Z')]);
    (raw.conversations[0] as unknown as Record<string, unknown>).under = 42;
    expect(migrateChatHistoryFile(raw, CTX).conversations[0]).not.toHaveProperty('under');
  });
});

describe('US-11 AC11: no reader uses the stamp yet', () => {
  it('lists, reads and tombstones a stamped conversation exactly as an unstamped one', async () => {
    const store = new MemoryAdapter();
    const s = await ChatSession.open(host(store));
    await s.recordExchange({ conversationId: 'plain', isNew: true, userText: 'q', assistantText: 'a' });
    await s.recordExchange({ conversationId: 'early', isNew: true, userText: 'q', assistantText: 'a', askedUnder: FIRST });
    await s.recordExchange({ conversationId: 'late', isNew: true, userText: 'q', assistantText: 'a', askedUnder: SECOND });
    const again = await ChatSession.open(host(store));
    expect(again.listConversations().map((c) => c.id)).toEqual(['late', 'early', 'plain']);
    for (const id of ['plain', 'early', 'late']) expect(again.getMessages(id).map((m) => m.content)).toEqual(['q', 'a']);

    await again.deleteConversation('early');
    expect(again.listConversations().map((c) => c.id)).toEqual(['late', 'plain']);
    expect(await storedConv(store, 'early')).toEqual(expect.objectContaining({ deleted: true, title: '', messages: [], under: FIRST }));

    await again.eraseAll();
    expect(again.listConversations()).toEqual([]);
    const after = (await stored(store)).conversations.filter((c) => !c.id.startsWith('erase:'));
    expect(after.map((c) => [c.id, c.deleted, c.under])).toEqual([['early', true, FIRST], ['late', true, SECOND], ['plain', true, undefined]]);
  });
});
