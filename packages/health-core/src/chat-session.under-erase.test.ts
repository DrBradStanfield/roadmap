/**
 * The chat read rule under a record erase (US-11 AC11, lead S59a): a session
 * opened under erase E neither lists nor saves into a conversation last
 * updated before E's erasedAt, and its next write tombstones them.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';

const E = '2026-11-20T10:00:00.000Z';
const BEFORE = '2026-11-20T09:00:00.000Z';
const AFTER = '2026-11-20T11:00:00.000Z';
const underE = (at: string | null = E, epoch = 1) => () => JSON.stringify([epoch, at]);

let clock = Date.parse('2026-11-26T10:00:00.000Z');
const cloudHost = (cloud: MemoryCloud) => ({
  store: new MemoryAdapter(cloud), deviceId: () => 'laptop', clock: { now: () => (clock += 1) },
  timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
  clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {}, tier: 'cloud',
  mirror: { adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
}) as RecordHost;

const conv = (id: string, updatedAt: string) => ({
  id, title: `title ${id}`, createdAt: updatedAt, updatedAt,
  messages: [{ id: `u-${id}`, role: 'user', content: `question ${id}`, createdAt: updatedAt }],
});
function seeded(...convs: Array<ReturnType<typeof conv>>): MemoryCloud {
  const cloud = new MemoryCloud();
  cloud.files.set('chat-history.json', { json: JSON.stringify({ schemaVersion: 1, conversations: convs }), version: 1 });
  return cloud;
}
type Stored = { conversations: Array<{ id: string; deleted?: boolean; title: string; messages: unknown[] }> };
const stored = (cloud: MemoryCloud) => JSON.parse(cloud.files.get('chat-history.json')!.json) as Stored;
const listed = (s: ChatSession) => s.listConversations().map((c) => c.id);
const reply = (s: ChatSession, id: string, isNew = false) =>
  s.recordExchange({ conversationId: id, isNew, userText: `more ${id}`, assistantText: 'ok' });

describe('US-11 AC11: a chat session under a record erase holds back what came before it', () => {
  const rows: Array<{ name: string; updatedAt: string; underErase?: () => string; shown: boolean }> = [
    { name: 'updated before the erase: hidden', updatedAt: BEFORE, underErase: underE(), shown: false },
    { name: 'updated after the erase: listed', updatedAt: AFTER, underErase: underE(), shown: true },
    { name: 'updated at the erase time itself: listed (only "before" is held)', updatedAt: E, underErase: underE(), shown: true },
    { name: 'a record never erased ([0, null]): listed', updatedAt: BEFORE, underErase: underE(null, 0), shown: true },
    { name: 'no erase identity passed: listed', updatedAt: BEFORE, shown: true },
    { name: 'an unreadable erase identity: listed', updatedAt: BEFORE, underErase: () => 'not json', shown: true },
    { name: 'an unreadable updatedAt under an erase: hidden', updatedAt: 'garbled', underErase: underE(), shown: false },
  ];
  it.each(rows)('$name', async ({ updatedAt, underErase, shown }) => {
    const s = await ChatSession.open(cloudHost(seeded(conv('c1', updatedAt))), underErase);
    expect(listed(s)).toEqual(shown ? ['c1'] : []);
    expect(s.getMessages('c1')).toHaveLength(shown ? 1 : 0);
  });

  it('saves no reply into a held conversation', async () => {
    const cloud = seeded(conv('old', BEFORE));
    const s = await ChatSession.open(cloudHost(cloud), underE());
    await reply(s, 'old');
    const old = stored(cloud).conversations.find((c) => c.id === 'old')!;
    expect(old.messages).toHaveLength(1);
    expect(listed(s)).toEqual([]);
  });

  it('a reload under a newer erase hides what came before that one too', async () => {
    let identity = JSON.stringify([1, '2026-11-20T08:00:00.000Z']);
    const s = await ChatSession.open(cloudHost(seeded(conv('mid', BEFORE), conv('new', AFTER))), () => identity);
    expect(listed(s)).toEqual(['new', 'mid']);
    identity = JSON.stringify([2, E]);
    await s.reload();
    expect(listed(s)).toEqual(['new']);
    expect(s.getMessages('mid')).toEqual([]);
  });

  it('its next write tombstones every held conversation and keeps the later ones', async () => {
    const cloud = seeded(conv('old1', BEFORE), conv('old2', '2026-11-19T00:00:00.000Z'), conv('new', AFTER));
    const s = await ChatSession.open(cloudHost(cloud), underE());
    await reply(s, 'fresh', true);
    const byId = new Map(stored(cloud).conversations.map((c) => [c.id, c]));
    for (const id of ['old1', 'old2']) expect(byId.get(id)).toMatchObject({ deleted: true, title: '', messages: [] });
    expect(byId.get('new')!.deleted).toBeUndefined();
    expect(byId.get('fresh')!.deleted).toBeUndefined();
    expect(listed(s).sort()).toEqual(['fresh', 'new']);
  });

  it('a reply written under the erase by a clock that trails it is stamped at the erase, and stays', async () => {
    const ahead = '2026-12-01T00:00:00.000Z'; // the eraser's clock, or its erasedAt floor, ahead of this one
    const cloud = seeded();
    const s = await ChatSession.open(cloudHost(cloud), underE(ahead));
    await reply(s, 'fresh', true);
    await reply(s, 'fresh');
    expect(listed(s)).toEqual(['fresh']);
    expect(stored(cloud).conversations).toMatchObject([{ id: 'fresh', createdAt: ahead, updatedAt: ahead }]);
    expect(s.getMessages('fresh')).toHaveLength(4);
  });

  it('the tombstones stay:a session with no erase, and a stale copy saving into one, never bring it back', async () => {
    const cloud = seeded(conv('old', BEFORE));
    const stale = await ChatSession.open(cloudHost(cloud)); // read before the tombstone, no rule
    expect(listed(stale)).toEqual(['old']);
    await reply(await ChatSession.open(cloudHost(cloud), underE()), 'fresh', true);
    await reply(stale, 'old');
    expect(stored(cloud).conversations.find((c) => c.id === 'old')).toMatchObject({ deleted: true, messages: [] });
    expect(listed(await ChatSession.open(cloudHost(cloud)))).toEqual(['fresh']);
  });
});
