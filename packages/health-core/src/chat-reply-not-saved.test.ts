/**
 * US-15 AC76: the chat's "not saved" lines, engine side. The reducer marks a
 * reply on screen that the history file did not take, and tells the transport
 * when a reply with edits lands after its thread was left; the history file
 * stores that second marker on the reply, at schema version 1.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import { mergeChatHistoryFiles, migrateChatHistoryFile } from './chat-history';
import { answerId, initialChatState, repliesLeft, shownMessages, transition, type ChatEvent, type ChatState, type Msg, type Key, type SendResult } from './chat-turn';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';

const T0 = '2026-11-26T10:00:00.000Z';
const q: Msg = { id: 'temp-n1', role: 'user', content: 'hi', createdAt: T0 };
const ans: Msg = { id: 'r1', role: 'assistant', content: 'ans', createdAt: T0 };
const S: ChatState = { ...initialChatState({ erase: 'E0', moving: 'none' }), shown: { key: 'thread:A', id: 'A', opening: 1 }, messages: [q, ans] };
const RES: SendResult = { conversationId: 'A', messageId: 'r1', content: 'ans' };
const EDITS: SendResult = { ...RES, proposedEdits: [{ kind: 'field', field: 'weightKg', displayValue: 80, unitSystem: 'si', date: null }] };
const REFUSED: SendResult = { ...RES, editRefusals: [{ part: 'review', words: 'not read' }] };
const sending = (key: Key): ChatState => ({
  ...S, seq: { ...S.seq, turn: 1 },
  turn: { phase: 'sending', turn: 1, nonce: 'n1', asked: { key, erase: 'E0' }, convId: 'A', question: q, before: [] },
});

const view = (s: ChatState) => shownMessages(s.messages, s.unsaved).map((m) => [m.id, m.notSaved]);
const unsaved = (id: string, session: number | null): ChatEvent => ({ type: 'reply-unsaved', id, session });

describe('US-15 AC76: reply-unsaved and history-saved', () => {
  it('marks the reply on screen by id; the turns themselves are not changed', () => {
    const { state, effects } = transition(S, unsaved('r1', 3));
    expect(state.messages).toEqual(S.messages);
    expect(state.unsaved).toEqual({ r1: 3 });
    expect(view(state)).toEqual([['temp-n1', undefined], ['r1', 'history']]);
    expect(effects).toEqual([]);
  });
  it('changes nothing for a reply not on screen, or for a question', () => {
    expect(transition(S, unsaved('gone', 3))).toEqual({ state: S, effects: [] });
    expect(transition(S, unsaved('temp-n1', 3))).toEqual({ state: S, effects: [] });
  });
  it('the landed reply takes the id the hook marks it by', () => {
    const landed = transition(sending('thread:A'), { type: 'done', turn: 1, now: T0, result: { ...RES, messageId: null } }).state;
    expect(landed.messages.at(-1)?.id).toBe(answerId({ ...RES, messageId: null }, 'n1'));
    expect(view(transition(landed, unsaved('assistant-n1', 3)).state).at(-1)).toEqual(['assistant-n1', 'history']);
  });
  it('a reply stored "left" keeps its own line, never "history"', () => {
    const left: ChatState = { ...S, messages: [q, { ...ans, notSaved: 'left' }] };
    expect(view(transition(left, unsaved('r1', null)).state)).toEqual([['temp-n1', undefined], ['r1', 'left']]);
  });
  it('A\'s save fails after B was sent: B landing (or failing) keeps A\'s mark', () => {
    const asked = transition(S, { type: 'send', text: 'B', online: true, othersBusy: false, now: T0, nonce: 'n2' }).state;
    const marked = transition(asked, unsaved('r1', 3)).state; // A's failure lands while B is out
    const landed = transition(marked, { type: 'done', turn: 1, now: T0, result: { ...RES, messageId: 'r2' } }).state;
    expect(view(landed)).toEqual([['temp-n1', undefined], ['r1', 'history'], ['temp-n2', undefined], ['r2', undefined]]);
    const failed = transition(marked, { type: 'failed', turn: 1, message: 'x', boxEmpty: false }).state;
    expect(view(failed)).toEqual([['temp-n1', undefined], ['r1', 'history']]);
  });
  it('a later save of the same session clears its marks (it wrote those turns); another session\'s and an unopened one\'s stay', () => {
    const marked = [unsaved('r1', 3)].reduce((acc, e) => transition(acc, e).state, { ...S, messages: [q, ans, { ...ans, id: 'r2' }, { ...ans, id: 'r3' }] });
    const all = transition(transition(marked, unsaved('r2', 4)).state, unsaved('r3', null)).state;
    const saved = transition(all, { type: 'history-saved', session: 3 }).state;
    expect(saved.unsaved).toEqual({ r2: 4, r3: null });
  });
  it('a failed list is read again once a save or a thread read gets through, and History lists it', () => {
    const failed: ChatState = { ...S, list: { phase: 'failed' } };
    expect(transition(failed, { type: 'history-saved', session: 3 }).effects).toEqual([{ type: 'read-list', read: 1 }]);
    const loading: ChatState = { ...failed, load: { phase: 'loading', opening: 1, id: 'A' } };
    expect(transition(loading, { type: 'load-landed', opening: 1, id: 'A', turns: [q] }).effects).toEqual([{ type: 'post-state' }, { type: 'read-list', read: 1 }]);
    expect(transition({ ...S, list: { phase: 'read' } }, { type: 'history-saved', session: 3 }).effects).toEqual([]);
  });
  it('an erase shown clears every mark', () => {
    expect(transition(transition(S, unsaved('r1', 3)).state, { type: 'erase-shown', erase: 'E1', by: 'own' }).state.unsaved).toEqual({});
  });
});

describe('US-15 AC76: repliesLeft, the left branch of done read before it runs', () => {
  it.each([
    ['edits, thread left', sending('thread:B'), 1, EDITS, true],
    ['refused edits only, thread left: nothing applicable was lost', sending('thread:B'), 1, REFUSED, false],
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

  it('recordExchange answers written only when the file written holds the turn', async () => {
    const s = await ChatSession.open(cloudHost(new MemoryAdapter(new MemoryCloud())));
    expect(await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1' })).toBe('written');
  });

  it('a conversation tombstoned by a delete whose own save failed: the reply is not written, and says so', async () => {
    class FailingOnce extends MemoryAdapter {
      fail = false;
      override async write(...args: Parameters<MemoryAdapter['write']>) {
        if (this.fail) { this.fail = false; throw new Error('synthetic write refused'); }
        return super.write(...args);
      }
    }
    const store = new FailingOnce(new MemoryCloud());
    const s = await ChatSession.open(cloudHost(store));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1' });
    store.fail = true;
    await expect(s.deleteConversation('c1')).rejects.toThrow();
    expect(await s.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q2', assistantText: 'a2' })).toBe('not-written');
    const stored = await ChatSession.open(cloudHost(new MemoryAdapter(store.cloud)));
    expect(stored.getMessages('c1').map((m) => m.content)).toEqual(['q1', 'a1']); // the second turn is nowhere
  });

  it('a page that may not write this device answers closed, and writes nothing', async () => {
    const device = { readSync: () => ({ body: null, version: null }), writeSync: () => { throw new Error('never'); } };
    const host = { ...cloudHost(new MemoryAdapter()), tier: 'device', sync: device, clearNamedFiles: () => {}, eraseFence: () => null, deviceFilesOpen: () => false } as unknown as RecordHost;
    const s = await ChatSession.open(host);
    expect(await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1' })).toBe('closed');
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

  it('a stored marker other than "left" is not read; the turn and its other fields are', () => {
    const ctx = { deviceId: 'd', now: T0 };
    const turnWith = (notSaved: unknown) => ({ id: 'a-1', role: 'assistant', content: 'a1', createdAt: T0, future: 1, notSaved });
    for (const word of ['history', 'LEFT', 1, null, { x: 1 }]) {
      const raw = { schemaVersion: 1, conversations: [{ id: 'c1', title: 't', createdAt: T0, updatedAt: T0, messages: [turnWith(word)] }] };
      expect(migrateChatHistoryFile(raw, ctx).conversations[0].messages).toEqual([{ id: 'a-1', role: 'assistant', content: 'a1', createdAt: T0, future: 1 }]);
    }
  });
});
