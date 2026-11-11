/**
 * The chat-turn reducer, cell by cell (design page §3) and failure by failure
 * (§5). Each test names its row and column, and asserts the next state's fields
 * and the exact effect list.
 */
import { describe, expect, it } from 'vitest';
import type { ChatEditRefusal } from './chat-edit-refusals';
import {
  busy, initialChatState, isLocalSender, OFFLINE_ERROR, showsPending, transition,
  type ChatEvent, type ChatState, type Conv, type Effect, type List, type Load, type Msg, type SendResult, type Turn,
} from './chat-turn';

const m1: Msg = { id: 'm1', role: 'user', content: 'old' };
const m2: Msg = { id: 'm2', role: 'assistant', content: 'loaded' };
const convA: Conv = { id: 'A', title: 'A' };
const convB: Conv = { id: 'B', title: 'B' };
const q: Msg = { id: 'temp-1', role: 'user', content: 'hi' };
const ans: Msg = { id: 'r1', role: 'assistant', content: 'ans' };
const REFUSAL: ChatEditRefusal = { part: 'review', words: 'not read' };
const RES: SendResult = { conversationId: 'A', messageId: 'r1', content: 'ans' };
const RES_R: SendResult = { ...RES, editRefusals: [REFUSAL] };

/** The fixture every cell starts from: thread A open at opening 2, the list read 3 numbers in. */
const S: ChatState = {
  ...initialChatState({ guest: false, erase: 'E0', moving: 'none' }),
  shown: { key: 'thread:A', id: 'A', opening: 2 }, messages: [m1], conversations: [convA, convB],
  seq: { key: 0, opening: 2, turn: 0, read: 3 },
};
const asked = { key: 'thread:A' as const, opening: 2, erase: 'E0' };
const SENDING: Turn = { phase: 'sending', turn: 1, asked, convId: 'A', question: q, before: [m1] };
const PENDING = { thinking: 'th', sources: ['s1'], text: 'tx', status: '' };
const STREAMING: Turn = { ...SENDING, phase: 'streaming', pending: PENDING };
const ORPHANED: Turn = { phase: 'orphaned', turn: 1, asked, by: 'own' };
/** A send from a new chat while thread A is on screen: the reply would leave. */
const SENDING_NEW: Turn = { phase: 'sending', turn: 1, asked: { key: 'new:0', opening: 0, erase: 'E0' }, convId: null, question: q, before: [] };

function withTurn(s: ChatState, t: Turn): ChatState {
  const seq = { ...s.seq, turn: 1 };
  if (t.phase === 'orphaned') return { ...s, seq, turn: t, erase: { ...s.erase, shown: 'E1' } };
  if (t.phase === 'idle') return s;
  return { ...s, seq, turn: t, messages: [...t.before, t.question] };
}
const PHASES: Record<Turn['phase'], ChatState> = {
  idle: S, sending: withTurn(S, SENDING), streaming: withTurn(S, STREAMING), orphaned: withTurn(S, ORPHANED),
};
const SEND: ChatEvent = { type: 'send', text: ' hi ', online: true, othersBusy: false };
const SEND_FX: Effect[] = [
  { type: 'set-input', text: '' }, { type: 'edits-ask' }, { type: 'post-state' },
  { type: 'request', turn: 1, question: 'hi', convId: 'A', history: [m1] },
];
const ENDED: Effect[] = [{ type: 'post-state' }, { type: 'own-ended' }];
const step = (s: ChatState, ...events: ChatEvent[]) => events.reduce((acc, e) => transition(acc.state, e), { state: s, effects: [] as Effect[] });

// ---------------------------------------------------------------------------
describe('§3 Turn table', () => {
  describe('send', () => {
    it('send × idle: accepted → sending, asked from shown and erase.shown', () => {
      const { state, effects } = transition(S, SEND);
      expect(state.turn).toEqual(SENDING);
      expect(state.seq.turn).toBe(1);
      expect(effects).toEqual(SEND_FX);
    });
    it('send × idle: an erase moving → same (Send is disabled, slice 4)', () => {
      const s = { ...S, erase: { shown: 'E0', moving: 'own' as const } };
      expect(transition(s, SEND)).toEqual({ state: s, effects: [] });
    });
    it.each([
      ['othersBusy', { ...SEND, othersBusy: true }],
      ['empty', { ...SEND, text: '   ' }],
      ['over 8000', { ...SEND, text: 'x'.repeat(8001) }],
    ])('send × idle: %s → same', (_, e) => {
      expect(transition(S, e)).toEqual({ state: S, effects: [] });
    });
    it('send × idle: exactly 8000 is accepted', () => {
      expect(transition(S, { ...SEND, text: 'x'.repeat(8000) }).state.turn.phase).toBe('sending');
    });
    it('send × idle: offline → same, error set', () => {
      const { state, effects } = transition(S, { ...SEND, online: false });
      expect(state).toEqual({ ...S, error: OFFLINE_ERROR });
      expect(effects).toEqual([]);
    });
    it.each(['sending', 'streaming', 'orphaned'] as const)('send × %s → same (busy, AC17c)', (p) => {
      expect(transition(PHASES[p], SEND)).toEqual({ state: PHASES[p], effects: [] });
    });
  });

  describe('delta', () => {
    it('delta × idle → same', () => {
      expect(transition(S, { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } })).toEqual({ state: S, effects: [] });
    });
    it('delta × sending → streaming, delta applied', () => {
      const { state, effects } = transition(PHASES.sending, { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } });
      expect(state.turn).toEqual({ ...SENDING, phase: 'streaming', pending: { thinking: '', sources: [], text: 'a', status: '' } });
      expect(effects).toEqual([]);
    });
    it('delta × streaming → streaming, text and thinking append, sources replace', () => {
      let s = transition(PHASES.streaming, { type: 'delta', turn: 1, delta: { type: 'text', text: '2' } }).state;
      s = transition(s, { type: 'delta', turn: 1, delta: { type: 'thinking', text: '+' } }).state;
      const { state, effects } = transition(s, { type: 'delta', turn: 1, delta: { type: 'sources', titles: ['s2'] } });
      expect(state.turn).toEqual({ ...STREAMING, pending: { thinking: 'th+', sources: ['s2'], text: 'tx2', status: '' } });
      expect(effects).toEqual([]);
    });
    it('delta × streaming: a status clears the text (AC38)', () => {
      const { state } = transition(PHASES.streaming, { type: 'delta', turn: 1, delta: { type: 'status', text: 'Reading' } });
      expect(state.turn).toEqual({ ...STREAMING, pending: { ...PENDING, text: '', status: 'Reading' } });
    });
    it('delta × orphaned → same (dropped)', () => {
      expect(transition(PHASES.orphaned, { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } })).toEqual({ state: PHASES.orphaned, effects: [] });
    });
    it.each(['sending', 'streaming', 'orphaned'] as const)('delta × %s with a stale turn number → same', (p) => {
      expect(transition(PHASES[p], { type: 'delta', turn: 0, delta: { type: 'text', text: 'a' } })).toEqual({ state: PHASES[p], effects: [] });
    });
  });

  describe('done', () => {
    it('done × idle → same', () => {
      expect(transition(S, { type: 'done', turn: 1, result: RES_R })).toEqual({ state: S, effects: [] });
    });
    it('done × sending, key same → landed: idle, take-edits(stayed), post-state, own-ended', () => {
      const { state, effects } = transition(PHASES.sending, { type: 'done', turn: 1, result: { ...RES_R, subscriptionCard: { plan: 'x' } } });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([
        { type: 'add-card', id: 'r1', card: { plan: 'x' } },
        { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED,
      ]);
    });
    it('done × sending, restarted (AC6a) → landed, edits-leave before take-edits', () => {
      const { state, effects } = transition(PHASES.sending, { type: 'done', turn: 1, result: { ...RES_R, conversationId: 'C' } });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'edits-leave' }, { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
    });
    it('done × sending, key differs → left: idle, take-edits(not stayed), post-state, own-ended', () => {
      const { state, effects } = transition(withTurn(S, SENDING_NEW), { type: 'done', turn: 1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × sending with no edits or refusals → no take-edits', () => {
      expect(transition(PHASES.sending, { type: 'done', turn: 1, result: RES }).effects).toEqual(ENDED);
    });
    it('done × streaming, key same → landed, keep-approach from the pending', () => {
      const { state, effects } = transition(PHASES.streaming, { type: 'done', turn: 1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([
        { type: 'keep-approach', id: 'r1', approach: { thinking: 'th', sources: ['s1'] } },
        { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED,
      ]);
    });
    it('done × streaming, a fallback keeps no approach', () => {
      expect(transition(PHASES.streaming, { type: 'done', turn: 1, result: { ...RES, isFallback: true } }).effects).toEqual(ENDED);
    });
    it('done × streaming, key differs → left', () => {
      const { state, effects } = transition(withTurn(S, { ...SENDING_NEW, phase: 'streaming', pending: PENDING }), { type: 'done', turn: 1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × orphaned{own}, key same → refused: take-edits(asked.erase, stayed) says "Not saved" (US-16 AC2e)', () => {
      const { state, effects } = transition(PHASES.orphaned, { type: 'done', turn: 1, result: RES_R });
      expect(state).toEqual({ ...PHASES.orphaned, turn: { phase: 'idle' } });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
    });
    it('done × orphaned{remote} → refused, not stayed: the notice speaks, the edits say nothing (R2)', () => {
      const s = withTurn(S, { ...ORPHANED, by: 'remote' });
      const { state, effects } = transition(s, { type: 'done', turn: 1, result: RES_R });
      expect(state).toEqual({ ...s, turn: { phase: 'idle' } });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × orphaned{own}, key differs → refused, not stayed', () => {
      const s = withTurn(S, { ...ORPHANED, asked: { ...asked, key: 'new:0' } });
      expect(transition(s, { type: 'done', turn: 1, result: RES_R }).effects)
        .toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it.each(['sending', 'streaming', 'orphaned'] as const)('done × %s with a stale turn number → same', (p) => {
      expect(transition(PHASES[p], { type: 'done', turn: 2, result: RES_R })).toEqual({ state: PHASES[p], effects: [] });
    });
    it('done × sending while an erase moves → the same cell (Fable): take-edits fires with asked.erase', () => {
      const s = { ...PHASES.sending, erase: { shown: 'E0', moving: 'own' as const } };
      const { state, effects } = transition(s, { type: 'done', turn: 1, result: RES_R });
      expect(state.messages).toEqual([m1, q, ans]);
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
    });
  });

  describe('failed', () => {
    const F: ChatEvent = { type: 'failed', turn: 1, message: 'boom', boxEmpty: true };
    it('failed × idle → same', () => {
      expect(transition(S, F)).toEqual({ state: S, effects: [] });
    });
    it.each(['sending', 'streaming'] as const)('failed × %s, key same → idle, the question back in an empty box', (p) => {
      const { state, effects } = transition(PHASES[p], F);
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'set-input', text: 'hi' }, ...ENDED]);
    });
    it('failed × sending, key same, box not empty → nothing put back (AC57)', () => {
      expect(transition(PHASES.sending, { ...F, boxEmpty: false }).effects).toEqual(ENDED);
    });
    it.each(['sending', 'streaming'] as const)('failed × %s, key differs → idle, post-state, own-ended', (p) => {
      const t: Turn = p === 'sending' ? SENDING_NEW : { ...SENDING_NEW, phase: 'streaming', pending: PENDING };
      const { state, effects } = transition(withTurn(S, t), F);
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual(ENDED);
    });
    it('failed × orphaned → idle, no question back, no error (Q2); other tabs unlock now (R4)', () => {
      const { state, effects } = transition(PHASES.orphaned, F);
      expect(state).toEqual({ ...PHASES.orphaned, turn: { phase: 'idle' } });
      expect(effects).toEqual(ENDED);
    });
    it.each(['sending', 'streaming', 'orphaned'] as const)('failed × %s with a stale turn number → same', (p) => {
      expect(transition(PHASES[p], { ...F, turn: 0 })).toEqual({ state: PHASES[p], effects: [] });
    });
  });

  // Events that leave the turn as it is; their effects come from the shown chat, list and load.
  const NEUTRAL: Array<[string, ChatEvent, Effect[]]> = [
    ['open-thread', { type: 'open-thread', id: 'B' }, [{ type: 'edits-leave' }, { type: 'read-turns', opening: 3, id: 'B' }]],
    ['new-chat', { type: 'new-chat' }, [{ type: 'edits-leave' }, { type: 'focus-input' }, { type: 'post-new' }]],
    ['mirror-state', { type: 'mirror-state', payload: { conversations: [convA], activeConversationId: 'A', messages: [m1], error: null } }, []],
    ['mirror-new', { type: 'mirror-new' }, [{ type: 'edits-leave' }]],
    ['thread-gone', { type: 'thread-gone', id: 'B', tell: false }, []],
    ['erase-state', { type: 'erase-state', moving: 'own' }, []],
    ['list-wanted', { type: 'list-wanted' }, [{ type: 'read-list', read: 4 }]],
    ['list-landed', { type: 'list-landed', read: 3, conversations: [convB] }, []],
    ['load-landed', { type: 'load-landed', opening: 2, id: 'A', turns: [m2] }, []],
    ['dismiss', { type: 'dismiss' }, []],
  ];
  describe.each(NEUTRAL)('%s', (_, e, fx) => {
    it.each(['idle', 'sending', 'streaming', 'orphaned'] as const)(`${_} × %s → turn same`, (p) => {
      const { state, effects } = transition(PHASES[p], e);
      expect(state.turn).toEqual(PHASES[p].turn);
      expect(effects).toEqual(fx);
    });
  });

  describe('erase-shown', () => {
    const ES: ChatEvent = { type: 'erase-shown', erase: 'E2', by: 'remote' };
    const FX: Effect[] = [{ type: 'clear-extras' }, { type: 'edits-leave' }];
    it('erase-shown × idle → same', () => {
      const { state, effects } = transition(S, ES);
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual(FX);
    });
    it.each(['sending', 'streaming'] as const)('erase-shown × %s → orphaned{by: event.by}, pending dropped', (p) => {
      const { state, effects } = transition(PHASES[p], ES);
      expect(state.turn).toEqual({ phase: 'orphaned', turn: 1, asked, by: 'remote' });
      expect(effects).toEqual(FX);
    });
    it('erase-shown × orphaned → same', () => {
      const { state, effects } = transition(PHASES.orphaned, ES);
      expect(state.turn).toEqual(ORPHANED);
      expect(effects).toEqual(FX);
    });
    it.each(['idle', 'sending', 'streaming', 'orphaned'] as const)('erase-shown × %s with the erase already shown → no move', (p) => {
      const s = PHASES[p];
      expect(transition(s, { type: 'erase-shown', erase: s.erase.shown, by: 'own' })).toEqual({ state: s, effects: [] });
    });
  });
});

// ---------------------------------------------------------------------------
type ListCol = 'unread' | 'waiting' | 'reading' | 'read';
type LoadCol = 'none' | 'loading';
const LISTS: Record<ListCol, List> = { unread: { phase: 'unread' }, waiting: { phase: 'waiting' }, reading: { phase: 'reading', read: 3 }, read: { phase: 'read' } };
const LOADS: Record<LoadCol, Load> = { none: { phase: 'none' }, loading: { phase: 'loading', opening: 2, id: 'A' } };
const LIST_COLS = Object.keys(LISTS) as ListCol[];
const LOAD_COLS = Object.keys(LOADS) as LoadCol[];
type Prep = (s: ChatState) => ChatState;
const id: Prep = (s) => s;
/** "same" in a column: the column's input as it went in. */
const SAME = 'same' as const;

function listCells(row: string, prep: Prep, e: ChatEvent, want: Record<ListCol, [List | typeof SAME, Effect[]]>) {
  it.each(LIST_COLS)(`${row} | List: %s`, (col) => {
    const s0 = prep({ ...S, list: LISTS[col] });
    const { state, effects } = transition(s0, e);
    const [list, fx] = want[col];
    expect(state.list).toEqual(list === SAME ? s0.list : list);
    expect(effects).toEqual(fx);
  });
}
function loadCells(row: string, prep: Prep, e: ChatEvent, want: Record<LoadCol, [Load | typeof SAME, Effect[]]>) {
  it.each(LOAD_COLS)(`${row} | Load: %s`, (col) => {
    const s0 = prep({ ...S, load: LOADS[col] });
    const { state, effects } = transition(s0, e);
    const [load, fx] = want[col];
    expect(state.load).toEqual(load === SAME ? s0.load : load);
    expect(effects).toEqual(fx);
  });
}
const all4 = (fx: Effect[]): Record<ListCol, [typeof SAME, Effect[]]> => ({ unread: [SAME, fx], waiting: [SAME, fx], reading: [SAME, fx], read: [SAME, fx] });
const both = (fx: Effect[]): Record<LoadCol, [typeof SAME, Effect[]]> => ({ none: [SAME, fx], loading: [SAME, fx] });
const NONE: Load = { phase: 'none' };
const reading = (read: number): List => ({ phase: 'reading', read });

describe('§3 Shown chat, list and load', () => {
  describe('send (accepted)', () => {
    it('send | shown: messages += question; notice none; error null', () => {
      const { state } = transition({ ...S, notice: 'remote-erase', error: 'old' }, SEND);
      expect(state).toMatchObject({ shown: S.shown, messages: [m1, q], conversations: S.conversations, notice: 'none', error: null });
    });
    listCells('send', id, SEND, all4(SEND_FX));
    loadCells('send', id, SEND, both(SEND_FX));
  });

  describe('delta', () => {
    const D: ChatEvent = { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } };
    const prep: Prep = (s) => withTurn(s, SENDING);
    it('delta | shown: no change', () => {
      const s0 = prep(S);
      expect(transition(s0, D).state).toMatchObject({ shown: s0.shown, messages: s0.messages, conversations: s0.conversations, notice: s0.notice, error: s0.error });
    });
    listCells('delta', prep, D, all4([]));
    loadCells('delta', prep, D, both([]));
  });

  describe('done', () => {
    const DONE: ChatEvent = { type: 'done', turn: 1, result: RES };
    it('done landed | shown: messages = before + question + answer', () => {
      const { state, effects } = transition(withTurn(S, SENDING), DONE);
      expect(state).toMatchObject({ shown: S.shown, messages: [m1, q, ans], conversations: [convA, convB], error: null });
      expect(effects).toEqual(ENDED);
    });
    it('done landed from a new chat | shown takes thread:cid, opening+1, first in the list', () => {
      const s0 = withTurn({ ...S, shown: { key: 'new:0', id: null, opening: 2 }, messages: [] }, SENDING_NEW);
      const { state, effects } = transition(s0, { type: 'done', turn: 1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: { key: 'thread:C', id: 'C', opening: 3 }, messages: [q, ans], conversations: [{ id: 'C', title: 'hi' }, convA, convB] });
      expect(state.seq.opening).toBe(3);
      expect(effects).toEqual(ENDED);
    });
    it('done landed restarted (AC6a) | question + answer only; the old thread leaves the list', () => {
      const { state } = transition(withTurn(S, SENDING), { type: 'done', turn: 1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: { key: 'thread:C', id: 'C', opening: 3 }, messages: [q, ans], conversations: [{ id: 'C', title: 'hi' }, convB] });
    });
    it('done left from a new chat | the list gains the thread; the shown chat is untouched', () => {
      const s0 = withTurn(S, SENDING_NEW);
      const { state } = transition(s0, { type: 'done', turn: 1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: S.shown, messages: s0.messages, conversations: [{ id: 'C', title: 'hi' }, convA, convB] });
    });
    it('done left from a saved thread | the list is unchanged', () => {
      const s0 = withTurn(S, { ...SENDING, asked: { ...asked, key: 'thread:B' }, convId: 'B' });
      const { state } = transition(s0, { type: 'done', turn: 1, result: { ...RES, conversationId: 'B' } });
      expect(state).toMatchObject({ shown: S.shown, messages: s0.messages, conversations: [convA, convB] });
    });
    it('done left | a thread deleted during the send stays gone (AC7a)', () => {
      const s0 = withTurn({ ...S, conversations: [convA] }, { ...SENDING, asked: { ...asked, key: 'thread:B' }, convId: 'B' });
      expect(transition(s0, { type: 'done', turn: 1, result: { ...RES, conversationId: 'B' } }).state.conversations).toEqual([convA]);
    });
    it('done refused | no change', () => {
      const s0 = withTurn(S, ORPHANED);
      expect(transition(s0, DONE).state).toEqual({ ...s0, turn: { phase: 'idle' } });
    });
    const sending: Prep = (s) => withTurn(s, SENDING);
    const left: Prep = (s) => withTurn(s, SENDING_NEW);
    const refused: Prep = (s) => withTurn(s, ORPHANED);
    listCells('done landed', sending, DONE, all4(ENDED));
    listCells('done left', left, DONE, all4(ENDED));
    listCells('done refused', refused, DONE, all4(ENDED));
    loadCells('done landed', sending, DONE, { none: [NONE, ENDED], loading: [NONE, ENDED] });
    loadCells('done left', left, DONE, both(ENDED));
    loadCells('done refused', refused, DONE, both(ENDED));
  });

  describe('failed', () => {
    const F: ChatEvent = { type: 'failed', turn: 1, message: 'boom', boxEmpty: false };
    it('failed key same | messages = before; error set', () => {
      expect(transition(withTurn(S, SENDING), F).state).toMatchObject({ shown: S.shown, messages: [m1], error: 'boom' });
    });
    it('failed key differs | error set, messages kept', () => {
      const s0 = withTurn(S, SENDING_NEW);
      expect(transition(s0, F).state).toMatchObject({ shown: S.shown, messages: s0.messages, error: 'boom' });
    });
    it('failed orphaned | no change', () => {
      const s0 = withTurn(S, ORPHANED);
      expect(transition(s0, F).state).toEqual({ ...s0, turn: { phase: 'idle' } });
    });
    listCells('failed', (s) => withTurn(s, SENDING), F, all4(ENDED));
    loadCells('failed', (s) => withTurn(s, SENDING), F, both(ENDED));
  });

  describe('open-thread', () => {
    const E: ChatEvent = { type: 'open-thread', id: 'B' };
    const FX: Effect[] = [{ type: 'edits-leave' }, { type: 'read-turns', opening: 3, id: 'B' }];
    it('open-thread | shown {thread:id, id, opening+1}; error null; notice none', () => {
      const { state } = transition({ ...S, error: 'x', notice: 'remote-erase' }, E);
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, messages: [m1], error: null, notice: 'none' });
    });
    listCells('open-thread', id, E, all4(FX));
    loadCells('open-thread', id, E, { none: [{ phase: 'loading', opening: 3, id: 'B' }, FX], loading: [{ phase: 'loading', opening: 3, id: 'B' }, FX] });
  });

  describe('new-chat', () => {
    const E: ChatEvent = { type: 'new-chat' };
    const FX: Effect[] = [{ type: 'edits-leave' }, { type: 'focus-input' }, { type: 'post-new' }];
    it('new-chat | shown {new:k+1, null, opening+1}; messages []; error null; notice none', () => {
      const { state } = transition({ ...S, error: 'x', notice: 'remote-erase' }, E);
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], conversations: [convA, convB], error: null, notice: 'none' });
    });
    listCells('new-chat', id, E, all4(FX));
    loadCells('new-chat', id, E, { none: [NONE, FX], loading: [NONE, FX] });
  });

  describe('mirror-state', () => {
    const payload = { conversations: [convB], activeConversationId: 'B', messages: [m2], error: 'theirs' };
    const NEW_ID: ChatEvent = { type: 'mirror-state', payload };
    const SAME_ID: ChatEvent = { type: 'mirror-state', payload: { ...payload, activeConversationId: 'A', erase: 'E0' } };
    const OTHER: ChatEvent = { type: 'mirror-state', payload: { ...payload, erase: 'E9' } };
    it('mirror-state, same erase, a new id | a new shown chat from the payload', () => {
      const { state } = transition(S, NEW_ID);
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, messages: [m2], conversations: [convB], error: 'theirs' });
    });
    it('mirror-state, same erase, a new null id | a new chat with its own key', () => {
      const { state } = transition(S, { type: 'mirror-state', payload: { ...payload, activeConversationId: null } });
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [m2], conversations: [convB], error: 'theirs' });
    });
    it('mirror-state, same erase, same id | the payload, the shown chat kept', () => {
      const { state, effects } = transition(S, SAME_ID);
      expect(state).toMatchObject({ shown: S.shown, messages: [m2], conversations: [convB], error: 'theirs' });
      expect(effects).toEqual([]);
    });
    it('mirror-state, other erase | no change', () => {
      expect(transition(S, OTHER)).toEqual({ state: S, effects: [] });
    });
    const FX: Effect[] = [{ type: 'remote-selected' }, { type: 'edits-leave' }];
    listCells('mirror-state same erase', id, NEW_ID, all4(FX));
    listCells('mirror-state other erase', id, OTHER, all4([]));
    loadCells('mirror-state same erase', id, NEW_ID, { none: [NONE, FX], loading: [NONE, FX] });
    loadCells('mirror-state same erase, same id', id, SAME_ID, { none: [NONE, []], loading: [NONE, []] });
    loadCells('mirror-state other erase', id, OTHER, both([]));
  });

  describe('mirror-new', () => {
    const E: ChatEvent = { type: 'mirror-new' };
    it('mirror-new | as new-chat, without focus-input or post-new', () => {
      const { state, effects } = transition({ ...S, error: 'x' }, E);
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], error: null, notice: 'none' });
      expect(effects).toEqual([{ type: 'edits-leave' }]);
    });
    listCells('mirror-new', id, E, all4([{ type: 'edits-leave' }]));
    loadCells('mirror-new', id, E, { none: [NONE, [{ type: 'edits-leave' }]], loading: [NONE, [{ type: 'edits-leave' }]] });
  });

  describe('thread-gone', () => {
    const SHOWN: ChatEvent = { type: 'thread-gone', id: 'A', tell: true };
    const OTHER: ChatEvent = { type: 'thread-gone', id: 'B', tell: false };
    const FX: Effect[] = [{ type: 'edits-leave' }, { type: 'post-deleted', id: 'A' }];
    it('thread-gone, the shown thread, tell | dropped; as mirror-new; post-deleted', () => {
      const { state, effects } = transition(S, SHOWN);
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], conversations: [convB] });
      expect(effects).toEqual(FX);
    });
    it('thread-gone, another thread, no tell | dropped from the list only', () => {
      const { state, effects } = transition(S, OTHER);
      expect(state).toEqual({ ...S, conversations: [convA] });
      expect(effects).toEqual([]);
    });
    listCells('thread-gone shown', id, SHOWN, all4(FX));
    loadCells('thread-gone shown', id, SHOWN, { none: [NONE, FX], loading: [NONE, FX] });
    loadCells('thread-gone other', id, OTHER, both([]));
  });

  describe('erase-state', () => {
    const OWN: ChatEvent = { type: 'erase-state', moving: 'own' };
    const NONE_E: ChatEvent = { type: 'erase-state', moving: 'none' };
    const moving = (m: 'own' | 'remote'): Prep => (s) => ({ ...s, erase: { ...s.erase, moving: m } });
    it('erase-state{none → own} | moving set, nothing else', () => {
      expect(transition(S, OWN)).toEqual({ state: { ...S, erase: { shown: 'E0', moving: 'own' } }, effects: [] });
    });
    it('erase-state{own → none} | moving none', () => {
      expect(transition(moving('own')(S), NONE_E).state.erase).toEqual({ shown: 'E0', moving: 'none' });
    });
    it('erase-state{own ↔ remote} | moving set', () => {
      expect(transition(moving('own')(S), { type: 'erase-state', moving: 'remote' }).state.erase).toEqual({ shown: 'E0', moving: 'remote' });
    });
    listCells('erase-state{none → own}', id, OWN, { unread: [SAME, []], waiting: [SAME, []], reading: [{ phase: 'waiting' }, []], read: [SAME, []] });
    listCells('erase-state{own → none}', moving('own'), NONE_E, { unread: [SAME, []], waiting: [reading(4), [{ type: 'read-list', read: 4 }]], reading: [SAME, []], read: [SAME, []] });
    listCells('erase-state{own ↔ remote}', moving('own'), { type: 'erase-state', moving: 'remote' }, all4([]));
    loadCells('erase-state{none → own}', id, OWN, both([]));
    loadCells('erase-state{own → none}', moving('own'), NONE_E, both([]));
    loadCells('erase-state{own ↔ remote}', moving('remote'), OWN, both([]));
  });

  describe('erase-shown', () => {
    const OWN: ChatEvent = { type: 'erase-shown', erase: 'E1', by: 'own' };
    const REMOTE: ChatEvent = { type: 'erase-shown', erase: 'E1', by: 'remote' };
    it('erase-shown{own} | erase.shown = e; same key, null id, opening+1; all cleared; notice none', () => {
      const { state, effects } = transition({ ...S, error: 'x', erase: { shown: 'E0', moving: 'own' } }, OWN);
      expect(state).toMatchObject({
        erase: { shown: 'E1', moving: 'own' }, shown: { key: 'thread:A', id: null, opening: 3 },
        messages: [], conversations: [], error: null, notice: 'none',
      });
      expect(effects).toEqual([{ type: 'clear-extras' }]);
    });
    it('erase-shown{remote} | notice remote-erase; edits-leave', () => {
      const { state, effects } = transition(S, REMOTE);
      expect(state).toMatchObject({ erase: { shown: 'E1', moving: 'none' }, notice: 'remote-erase', messages: [], conversations: [] });
      expect(effects).toEqual([{ type: 'clear-extras' }, { type: 'edits-leave' }]);
    });
    const RL: Effect[] = [{ type: 'clear-extras' }, { type: 'read-list', read: 4 }];
    listCells('erase-shown{own}', id, OWN, { unread: [SAME, [{ type: 'clear-extras' }]], waiting: [reading(4), RL], reading: [reading(4), RL], read: [reading(4), RL] });
    loadCells('erase-shown{own}', id, OWN, { none: [NONE, [{ type: 'clear-extras' }]], loading: [NONE, [{ type: 'clear-extras' }]] });
  });

  describe('list-wanted', () => {
    const E: ChatEvent = { type: 'list-wanted' };
    const own: Prep = (s) => ({ ...s, erase: { ...s.erase, moving: 'own' } });
    it('list-wanted | no change to the shown chat', () => {
      expect(transition(S, E).state).toMatchObject({ shown: S.shown, messages: S.messages, conversations: S.conversations });
    });
    listCells('list-wanted, moving none', id, E, { unread: [reading(4), [{ type: 'read-list', read: 4 }]], waiting: [SAME, []], reading: [SAME, []], read: [SAME, []] });
    listCells('list-wanted, moving own', own, E, { unread: [{ phase: 'waiting' }, []], waiting: [SAME, []], reading: [SAME, []], read: [SAME, []] });
    loadCells('list-wanted', (s) => ({ ...s, list: { phase: 'read' } }), E, both([]));
  });

  describe('list-landed', () => {
    const E: ChatEvent = { type: 'list-landed', read: 3, conversations: [convB] };
    it('list-landed r\' = r | conversations set', () => {
      const { state, effects } = transition({ ...S, list: reading(3) }, E);
      expect(state).toEqual({ ...S, list: { phase: 'read' }, conversations: [convB] });
      expect(effects).toEqual([]);
    });
    it('list-landed r\' = r, null | conversations kept, the list read', () => {
      expect(transition({ ...S, list: reading(3) }, { ...E, conversations: null }).state).toEqual({ ...S, list: { phase: 'read' } });
    });
    it('list-landed r\' ≠ r | dropped', () => {
      const s0 = { ...S, list: reading(3) };
      expect(transition(s0, { ...E, read: 2 })).toEqual({ state: s0, effects: [] });
    });
    it('list-landed, a guest with threads | opens the latest (Q7)', () => {
      const s0 = { ...S, guest: true, list: reading(3) };
      const { state, effects } = transition(s0, { ...E, conversations: [convB, convA] });
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, conversations: [convB, convA], list: { phase: 'read' } });
      expect(effects).toEqual([{ type: 'read-turns', opening: 3, id: 'B' }]);
    });
    it('list-landed, a guest with no threads | nothing opened', () => {
      const s0 = { ...S, guest: true, list: reading(3) };
      expect(transition(s0, { ...E, conversations: [] })).toEqual({ state: { ...s0, list: { phase: 'read' }, conversations: [] }, effects: [] });
    });
    listCells('list-landed', id, E, { unread: [SAME, []], waiting: [SAME, []], reading: [{ phase: 'read' }, []], read: [SAME, []] });
    listCells('list-landed stale', id, { ...E, read: 2 }, all4([]));
    const guest: Prep = (s) => ({ ...s, guest: true, list: reading(3) });
    const OPEN: Load = { phase: 'loading', opening: 3, id: 'B' };
    loadCells('list-landed, a guest opening the latest', guest, E, { none: [OPEN, [{ type: 'read-turns', opening: 3, id: 'B' }]], loading: [OPEN, [{ type: 'read-turns', opening: 3, id: 'B' }]] });
    loadCells('list-landed, not a guest', (s) => ({ ...s, list: reading(3) }), E, both([]));
  });

  describe('load-landed', () => {
    const E: ChatEvent = { type: 'load-landed', opening: 2, id: 'A', turns: [m2] };
    const loading: Prep = (s) => ({ ...s, load: LOADS.loading });
    it('load-landed o\' = o with turns | messages = turns; post-state', () => {
      const { state, effects } = transition(loading(S), E);
      expect(state).toEqual({ ...S, messages: [m2] });
      expect(effects).toEqual([{ type: 'post-state' }]);
    });
    it('load-landed o\' ≠ o with turns | dropped', () => {
      const s0 = loading(S);
      expect(transition(s0, { ...E, opening: 1 })).toEqual({ state: s0, effects: [] });
    });
    it('load-landed null turns, the shown thread, stale | dropped from the list; a new chat; its load ends (R8)', () => {
      const { state, effects } = transition(loading(S), { ...E, opening: 1, turns: null });
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], conversations: [convB], load: NONE });
      expect(effects).toEqual([{ type: 'edits-leave' }]);
    });
    it('load-landed null turns, another thread, stale | dropped from the list only', () => {
      const s0 = loading(S);
      expect(transition(s0, { ...E, id: 'B', opening: 1, turns: null })).toEqual({ state: { ...s0, conversations: [convA] }, effects: [] });
    });
    it('load-landed null turns, current, not the shown thread | dropped from the list; load none', () => {
      const s0 = { ...loading(S), shown: { key: 'thread:B' as const, id: 'B', opening: 2 } };
      expect(transition(s0, { ...E, turns: null })).toEqual({ state: { ...s0, conversations: [convB], load: NONE }, effects: [] });
    });
    listCells('load-landed current', loading, E, all4([{ type: 'post-state' }]));
    loadCells('load-landed', id, E, { none: [SAME, []], loading: [NONE, [{ type: 'post-state' }]] });
    loadCells('load-landed stale', id, { ...E, opening: 1 }, both([]));
    loadCells('load-landed null, shown', id, { ...E, opening: 1, turns: null }, { none: [NONE, [{ type: 'edits-leave' }]], loading: [NONE, [{ type: 'edits-leave' }]] });
  });

  describe('dismiss', () => {
    const E: ChatEvent = { type: 'dismiss' };
    it('dismiss | notice none', () => {
      expect(transition({ ...S, notice: 'remote-erase' }, E)).toEqual({ state: S, effects: [] });
    });
    listCells('dismiss', id, E, all4([]));
    loadCells('dismiss', id, E, both([]));
  });
});

// ---------------------------------------------------------------------------
describe('§1 initial state and the derived view', () => {
  it('initialChatState: new:0, idle, unread, none, the erase at mount', () => {
    expect(initialChatState({ guest: true, erase: 'E5', moving: 'remote' })).toEqual({
      guest: true, shown: { key: 'new:0', id: null, opening: 0 }, messages: [], conversations: [],
      turn: { phase: 'idle' }, list: { phase: 'unread' }, load: { phase: 'none' },
      erase: { shown: 'E5', moving: 'remote' }, notice: 'none', error: null, seq: { key: 0, opening: 0, turn: 0, read: 0 },
    });
  });
  it('isLocalSender, showsPending and busy', () => {
    expect([isLocalSender(S), showsPending(S), busy(S, false), busy(S, true)]).toEqual([false, null, false, true]);
    expect([isLocalSender(PHASES.sending), showsPending(PHASES.sending), busy(PHASES.sending, false)]).toEqual([true, null, true]);
    expect([isLocalSender(PHASES.streaming), showsPending(PHASES.streaming)]).toEqual([true, PENDING]);
    expect([isLocalSender(PHASES.orphaned), showsPending(PHASES.orphaned), busy(PHASES.orphaned, false)]).toEqual([false, null, true]);
    const moved = withTurn(S, { ...STREAMING, asked: { ...asked, key: 'new:0' } });
    expect([isLocalSender(moved), showsPending(moved), busy(moved, false)]).toEqual([false, null, true]);
  });
});

// ---------------------------------------------------------------------------
describe('§5 failure map', () => {
  const I = initialChatState({ guest: false, erase: 'E0', moving: 'none' });
  const send: ChatEvent = { type: 'send', text: 'hi', online: true, othersBusy: false };

  it('1311c R1: erased streamed text stays — erase-shown orphans the turn and its deltas drop', () => {
    const streaming = step(I, send, { type: 'delta', turn: 1, delta: { type: 'text', text: 'abc' } }).state;
    expect(showsPending(streaming)).toEqual({ thinking: '', sources: [], text: 'abc', status: '' });
    const erased = transition(streaming, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    expect([erased.turn.phase, showsPending(erased), erased.messages]).toEqual(['orphaned', null, []]);
    expect(transition(erased, { type: 'delta', turn: 1, delta: { type: 'text', text: 'd' } })).toEqual({ state: erased, effects: [] });
  });

  it('Adversary R1: a remote arrival whose read fails — erase-state none reads the list and unlocks Send', () => {
    let s = step(I, { type: 'erase-state', moving: 'remote' }, { type: 'list-wanted' }).state;
    expect(s.list).toEqual({ phase: 'waiting' });
    expect(transition(s, send)).toEqual({ state: s, effects: [] });
    const back = transition(s, { type: 'erase-state', moving: 'none' });
    expect(back.state.list).toEqual({ phase: 'reading', read: 1 });
    expect(back.effects).toEqual([{ type: 'read-list', read: 1 }]);
    s = transition(back.state, send).state;
    expect(s.turn.phase).toBe('sending');
  });

  it('1311c R2: a pre-erase list read restores titles — read 1 is dropped by number', () => {
    let s = step(I, { type: 'list-wanted' }, { type: 'erase-state', moving: 'own' }).state;
    expect(s.list).toEqual({ phase: 'waiting' });
    expect(transition(s, { type: 'list-landed', read: 1, conversations: [convA] })).toEqual({ state: s, effects: [] });
    s = transition(s, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    expect(s.list).toEqual({ phase: 'reading', read: 2 });
    expect(transition(s, { type: 'list-landed', read: 1, conversations: [convA] })).toEqual({ state: s, effects: [] });
    s = transition(s, { type: 'list-landed', read: 2, conversations: [] }).state;
    expect([s.list, s.conversations]).toEqual([{ phase: 'read' }, []]);
  });

  it('1311c R3: a late erased reply shows "Not saved" in a new chat — stayed is false there', () => {
    const orphaned = step(I, send, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    const inNew = step(orphaned, { type: 'new-chat' }, { type: 'done', turn: 1, result: RES_R });
    expect(inNew.effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    expect(inNew.state.messages).toEqual([]);
    // Control: under the chat that asked, an own erase says "Not saved" (US-16 AC2e).
    expect(transition(orphaned, { type: 'done', turn: 1, result: RES_R }).effects)
      .toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
  });

  it('1311d R1: a list retry loop while an erase is half done — no read until the erase shows', () => {
    const r = step(I, { type: 'erase-state', moving: 'own' }, { type: 'list-wanted' });
    expect([r.state.list, r.effects]).toEqual([{ phase: 'waiting' }, []]);
    expect(transition(r.state, { type: 'list-wanted' })).toEqual({ state: r.state, effects: [] });
    expect(transition(r.state, { type: 'list-landed', read: 0, conversations: [convA] })).toEqual({ state: r.state, effects: [] });
    const shown = transition(r.state, { type: 'erase-shown', erase: 'E1', by: 'own' });
    expect(shown.effects).toEqual([{ type: 'clear-extras' }, { type: 'read-list', read: 1 }]);
    expect(transition(shown.state, { type: 'erase-state', moving: 'none' }).effects).toEqual([]);
  });

  it('1311d R2: A, B, A — the older A load is dropped', () => {
    const s = step(I, { type: 'open-thread', id: 'A' }, { type: 'open-thread', id: 'B' }, { type: 'open-thread', id: 'A' }).state;
    expect(s.load).toEqual({ phase: 'loading', opening: 3, id: 'A' });
    expect(transition(s, { type: 'load-landed', opening: 1, id: 'A', turns: [m1] })).toEqual({ state: s, effects: [] });
    expect(transition(s, { type: 'load-landed', opening: 2, id: 'B', turns: [m1] })).toEqual({ state: s, effects: [] });
    const r = transition(s, { type: 'load-landed', opening: 3, id: 'A', turns: [m2] });
    expect([r.state.messages, r.state.load, r.effects]).toEqual([[m2], { phase: 'none' }, [{ type: 'post-state' }]]);
  });

  it('1306b R1: A\'s refusal shows under B — the reply that left takes edits not stayed', () => {
    const s = step(I, { type: 'open-thread', id: 'A' }, { type: 'load-landed', opening: 1, id: 'A', turns: [m1] }, send, { type: 'open-thread', id: 'B' }).state;
    const r = transition(s, { type: 'done', turn: 1, result: RES_R });
    expect(r.effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    expect([r.state.shown.id, r.state.messages]).toEqual(['B', s.messages]);
  });

  it('1306c R1: two new chats both have id null — their keys still differ', () => {
    const s = step(I, send, { type: 'new-chat' }).state;
    expect([s.shown.id, s.shown.key, s.turn.phase === 'sending' && s.turn.asked.key]).toEqual([null, 'new:1', 'new:0']);
    const r = transition(s, { type: 'done', turn: 1, result: { ...RES_R, conversationId: 'C' } });
    expect(r.state).toMatchObject({ shown: { key: 'new:1', id: null }, messages: [], conversations: [{ id: 'C', title: 'hi' }] });
    expect(r.effects[0]).toEqual({ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false });
  });

  it('Live 2026-11-12: "+ New Chat" just after a send shows no dots, and Send stays locked', () => {
    const s = step(I, send, { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } }, { type: 'new-chat' }).state;
    expect([isLocalSender(s), showsPending(s), busy(s, false)]).toEqual([false, null, true]);
    expect(transition(s, send)).toEqual({ state: s, effects: [] });
  });

  it('1306d R1: thread-new is seen only after the effect runs — mirror-new moves the key at once', () => {
    const s = step(I, send, { type: 'mirror-new' }).state;
    expect(s.shown.key).toBe('new:1');
    const r = transition(s, { type: 'done', turn: 1, result: RES_R });
    expect(r.state.messages).toEqual([]);
    expect(r.effects[0]).toEqual({ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false });
  });
});
