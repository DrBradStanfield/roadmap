/**
 * US-15 AC76: the chat's "not saved" lines, engine side. The reducer marks a
 * reply on screen that the history file did not take, and tells the transport
 * when a reply with edits lands after its thread was left; the history file
 * stores that second marker on the reply, at schema version 1.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import { mergeChatHistoryFiles, migrateChatHistoryFile } from './chat-history';
import { answerId, initialChatState, repliesLeft, transition, type ChatState, type Msg, type Key, type SendResult } from './chat-turn';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';

const T0 = '2026-11-26T10:00:00.000Z';
const q: Msg = { id: 'temp-n1', role: 'user', content: 'hi', createdAt: T0 };
const ans: Msg = { id: 'r1', role: 'assistant', content: 'ans', createdAt: T0 };
const S: ChatState = { ...initialChatState({ erase: 'E0', moving: 'none' }), shown: { key: 'thread:A', id: 'A', opening: 1 }, messages: [q, ans] };
const RES: SendResult = { conversationId: 'A', messageId: 'r1', content: 'ans' };
const EDITS: SendResult = { ...RES, proposedEdits: [{ kind: 'field', field: 'weightKg', value: '80', unit: 'kg' }] as SendResult['proposedEdits'] };
const REFUSED: SendResult = { ...RES, editRefusals: [{ part: 'review', words: 'not read' }] };
const sending = (key: Key): ChatState => ({
  ...S, seq: { ...S.seq, turn: 1 },
  turn: { phase: 'sending', turn: 1, nonce: 'n1', asked: { key, erase: 'E0' }, convId: 'A', question: q, before: [] },
});

describe('US-15 AC76: reply-unsaved', () => {
  it('marks the reply on screen as not saved to the history, and tells the other tabs', () => {
    const { state, effects } = transition(S, { type: 'reply-unsaved', id: 'r1' });
    expect(state.messages).toEqual([q, { ...ans, notSaved: 'history' }]);
    expect(effects).toEqual([{ type: 'post-state' }]);
  });
  it('changes nothing for a reply not on screen, or for a question', () => {
    expect(transition(S, { type: 'reply-unsaved', id: 'gone' })).toEqual({ state: S, effects: [] });
    expect(transition(S, { type: 'reply-unsaved', id: 'temp-n1' })).toEqual({ state: S, effects: [] });
  });
  it('the landed reply takes the id the hook marks it by', () => {
    const landed = transition(sending('thread:A'), { type: 'done', turn: 1, now: T0, result: { ...RES, messageId: null } }).state;
    expect(landed.messages.at(-1)?.id).toBe(answerId({ ...RES, messageId: null }, 'n1'));
    expect(transition(landed, { type: 'reply-unsaved', id: 'assistant-n1' }).state.messages.at(-1)?.notSaved).toBe('history');
  });
});

describe('US-15 AC76: repliesLeft, the left branch of done read before it runs', () => {
  it.each([
    ['edits, thread left', sending('thread:B'), 1, EDITS, true],
    ['refused edits, thread left', sending('thread:B'), 1, REFUSED, true],
    ['no edits, thread left', sending('thread:B'), 1, RES, false],
    ['edits, thread still shown', sending('thread:A'), 1, EDITS, false],
    ['edits, another turn', sending('thread:B'), 2, EDITS, false],
    ['edits, no turn in flight', S, 1, EDITS, false],
  ] as const)('%s → %s', (_name, s, turn, r, want) => {
    expect(repliesLeft(s, turn, r)).toBe(want);
  });
  it('agrees with done: a left reply with edits takes edits not stayed', () => {
    const s = sending('thread:B');
    expect(repliesLeft(s, 1, EDITS)).toBe(true);
    expect(transition(s, { type: 'done', turn: 1, now: T0, result: EDITS }).effects).toContainEqual(expect.objectContaining({ type: 'take-edits', stayed: false }));
  });
});

describe('US-15 AC76: the stored marker', () => {
  const cloudHost = (store: MemoryAdapter) => ({
    store, deviceId: () => 'phone', clock: { now: () => Date.parse(T0) }, timers: { set: () => 0, clear: () => {} },
    remoteChanged: () => {}, failureCause: () => 'other', report: () => {}, clearOffFileData: () => {},
    clearedErase: () => null, noteCleared: () => {}, tier: 'cloud',
    mirror: { adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
  }) as unknown as RecordHost;

  it('is saved on the reply only, read back, and the file stays at version 1', async () => {
    const cloud = new MemoryCloud();
    const s = await ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1', notSaved: 'left' });
    const again = await ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
    expect(again.getMessages('c1').map((m) => [m.role, m.notSaved])).toEqual([['user', undefined], ['assistant', 'left']]);
    expect(((await new MemoryAdapter(cloud).read('chat-history.json')).body as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it('survives a read and a merge, as every turn is kept whole', () => {
    const ctx = { deviceId: 'd', now: T0 };
    const marked = { id: 'a-1', role: 'assistant', content: 'a1', createdAt: T0, notSaved: 'left' };
    const raw = { schemaVersion: 1, meta: { createdAt: T0, updatedAt: T0, lastDeviceId: 'd', lamport: 1 }, conversations: [{ id: 'c1', title: 't', createdAt: T0, updatedAt: T0, messages: [marked] }] };
    const file = migrateChatHistoryFile(raw, ctx);
    const merged = mergeChatHistoryFiles(file, migrateChatHistoryFile(structuredClone(raw), ctx), ctx);
    expect(merged.conversations[0].messages).toEqual([marked]);
    expect(merged.schemaVersion).toBe(1);
  });
});
