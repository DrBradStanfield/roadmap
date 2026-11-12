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

const T0 = '2026-11-12T00:00:00.000Z'; // the send's clock
const T1 = '2026-11-12T00:00:05.000Z'; // the reply's clock
const m1: Msg = { id: 'm1', role: 'user', content: 'old', createdAt: T0 };
const m2: Msg = { id: 'm2', role: 'assistant', content: 'loaded', createdAt: T0 };
const convA: Conv = { id: 'A', title: 'A' };
const convB: Conv = { id: 'B', title: 'B' };
const q: Msg = { id: 'temp-n1', role: 'user', content: 'hi', createdAt: T0 };
const ans: Msg = { id: 'r1', role: 'assistant', content: 'ans', createdAt: T1 };
const REFUSAL: ChatEditRefusal = { part: 'review', words: 'not read' };
const RES: SendResult = { conversationId: 'A', messageId: 'r1', content: 'ans' };
const RES_R: SendResult = { ...RES, editRefusals: [REFUSAL] };

/** The fixture every cell starts from: thread A open at opening 2, the list read 3 numbers in. */
const S: ChatState = {
  ...initialChatState({ erase: 'E0', moving: 'none' }),
  shown: { key: 'thread:A', id: 'A', opening: 2 }, messages: [m1], conversations: [convA, convB],
  seq: { key: 0, opening: 2, turn: 0, read: 3 },
};
const asked = { key: 'thread:A' as const, erase: 'E0' };
const SENDING: Turn = { phase: 'sending', turn: 1, nonce: 'n1', asked, convId: 'A', question: q, before: [m1] };
const PENDING = { thinking: 'th', sources: ['s1'], text: 'tx', status: '' };
const STREAMING: Turn = { ...SENDING, phase: 'streaming', pending: PENDING };
const ORPHANED: Turn = { phase: 'orphaned', turn: 1, asked, by: 'own' };
/** A send from a new chat while thread A is on screen: the reply would leave. */
const SENDING_NEW: Turn = { phase: 'sending', turn: 1, nonce: 'n1', asked: { key: 'new:0', erase: 'E0' }, convId: null, question: q, before: [] };

function withTurn(s: ChatState, t: Turn): ChatState {
  const seq = { ...s.seq, turn: 1 };
  if (t.phase === 'orphaned') return { ...s, seq, turn: t, erase: { ...s.erase, shown: 'E1' } };
  if (t.phase === 'idle') return s;
  return { ...s, seq, turn: t, messages: [...t.before, t.question] };
}
const PHASES: Record<Turn['phase'], ChatState> = {
  idle: S, sending: withTurn(S, SENDING), streaming: withTurn(S, STREAMING), orphaned: withTurn(S, ORPHANED),
};
const SEND: ChatEvent = { type: 'send', text: ' hi ', online: true, othersBusy: false, now: T0, nonce: 'n1' };
const SEND_FX: Effect[] = [
  { type: 'set-input', text: '' }, { type: 'edits-ask' }, { type: 'post-state' },
  { type: 'request', turn: 1, question: 'hi', convId: 'A', history: [m1] },
];
const ENDED: Effect[] = [{ type: 'own-ended' }, { type: 'post-state' }];
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
      expect(transition(S, { type: 'done', turn: 1, now: T1, result: RES_R })).toEqual({ state: S, effects: [] });
    });
    it('done × sending, key same → landed: idle, take-edits(stayed) with the refusals as parsed, own-ended, post-state (US-67 AC2)', () => {
      const { state, effects } = transition(PHASES.sending, { type: 'done', turn: 1, now: T1, result: { ...RES_R, subscriptionCard: { plan: 'x' } } });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([
        { type: 'add-card', id: 'r1', card: { plan: 'x' } },
        { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED,
      ]);
    });
    it('done × sending, restarted (AC6a) → landed, edits-leave before take-edits', () => {
      const { state, effects } = transition(PHASES.sending, { type: 'done', turn: 1, now: T1, result: { ...RES_R, conversationId: 'C' } });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'edits-leave' }, { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
    });
    it('done × sending, key differs → left: idle, take-edits(not stayed), own-ended, post-state (US-15 AC7a, US-67 AC2)', () => {
      const { state, effects } = transition(withTurn(S, SENDING_NEW), { type: 'done', turn: 1, now: T1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × sending with no edits or refusals → no take-edits', () => {
      expect(transition(PHASES.sending, { type: 'done', turn: 1, now: T1, result: RES }).effects).toEqual(ENDED);
    });
    it('done × streaming, key same → landed, keep-approach from the pending', () => {
      const { state, effects } = transition(PHASES.streaming, { type: 'done', turn: 1, now: T1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([
        { type: 'keep-approach', id: 'r1', approach: { thinking: 'th', sources: ['s1'] } },
        { type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED,
      ]);
    });
    it('done × streaming, a fallback keeps no approach', () => {
      expect(transition(PHASES.streaming, { type: 'done', turn: 1, now: T1, result: { ...RES, isFallback: true } }).effects).toEqual(ENDED);
    });
    it('done × streaming, key differs → left (US-15 AC7a)', () => {
      const { state, effects } = transition(withTurn(S, { ...SENDING_NEW, phase: 'streaming', pending: PENDING }), { type: 'done', turn: 1, now: T1, result: RES_R });
      expect(state.turn).toEqual({ phase: 'idle' });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × orphaned{own}, key same → refused: take-edits(asked.erase, stayed) says "Not saved" (US-16 AC2e)', () => {
      const { state, effects } = transition(PHASES.orphaned, { type: 'done', turn: 1, now: T1, result: RES_R });
      expect(state).toEqual({ ...PHASES.orphaned, turn: { phase: 'idle' } });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
    });
    it('done × orphaned{remote} → refused, not stayed: the notice speaks, the edits say nothing (R2)', () => {
      const s = withTurn(S, { ...ORPHANED, by: 'remote' });
      const { state, effects } = transition(s, { type: 'done', turn: 1, now: T1, result: RES_R });
      expect(state).toEqual({ ...s, turn: { phase: 'idle' } });
      expect(effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it('done × orphaned{own}, key differs → refused, not stayed', () => {
      const s = withTurn(S, { ...ORPHANED, asked: { ...asked, key: 'new:0' } });
      expect(transition(s, { type: 'done', turn: 1, now: T1, result: RES_R }).effects)
        .toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    });
    it.each(['sending', 'streaming', 'orphaned'] as const)('done × %s with a stale turn number → same', (p) => {
      expect(transition(PHASES[p], { type: 'done', turn: 2, now: T1, result: RES_R })).toEqual({ state: PHASES[p], effects: [] });
    });
    it('done × sending while an erase moves → the same cell (Fable): take-edits fires with asked.erase', () => {
      const s = { ...PHASES.sending, erase: { shown: 'E0', moving: 'own' as const } };
      const { state, effects } = transition(s, { type: 'done', turn: 1, now: T1, result: RES_R });
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
    it.each(['sending', 'streaming'] as const)('failed × %s, key differs → idle, own-ended, post-state', (p) => {
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
    ['list-wanted', { type: 'list-wanted', guest: false }, [{ type: 'read-list', read: 4 }]],
    ['list-landed', { type: 'list-landed', read: 3, conversations: [convB] }, []],
    ['load-landed', { type: 'load-landed', opening: 2, id: 'A', turns: [m2] }, []],
    ['load-failed', { type: 'load-failed', opening: 2, id: 'A' }, []],
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
type LoadCol = 'none' | 'loading' | 'failed';
const LISTS: Record<ListCol, List> = { unread: { phase: 'unread' }, waiting: { phase: 'waiting', autoOpen: false }, reading: { phase: 'reading', read: 3, autoOpen: false }, read: { phase: 'read' } };
const LOADS: Record<LoadCol, Load> = { none: { phase: 'none' }, loading: { phase: 'loading', opening: 2, id: 'A' }, failed: { phase: 'failed', opening: 2, id: 'A' } };
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
const both = (fx: Effect[]): Record<LoadCol, [typeof SAME, Effect[]]> => ({ none: [SAME, fx], loading: [SAME, fx], failed: [SAME, fx] });
const NONE: Load = { phase: 'none' };
const reading = (read: number, autoOpen = false): List => ({ phase: 'reading', read, autoOpen });

describe('§3 Shown chat, list and load', () => {
  describe('send (accepted)', () => {
    it('send | shown: messages += question; notice none; error null', () => {
      const { state } = transition({ ...S, notice: 'remote-erase', error: 'old' }, SEND);
      expect(state).toMatchObject({ shown: S.shown, messages: [m1, q], conversations: S.conversations, notice: 'none', error: null });
    });
    listCells('send', id, SEND, all4(SEND_FX));
    loadCells('send', id, SEND, { none: [SAME, SEND_FX], loading: [SAME, []], failed: [SAME, []] });
    it.each(['loading', 'failed'] as const)('send × Load %s | refused: the same state, no effects (US-15 AC7a, N2)', (col) => {
      const s0 = { ...S, load: LOADS[col] };
      expect(transition(s0, SEND)).toEqual({ state: s0, effects: [] });
      expect(busy(s0, false)).toBe(true);
    });
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
    const DONE: ChatEvent = { type: 'done', turn: 1, now: T1, result: RES };
    it('done landed | shown: messages = before + question + answer', () => {
      const { state, effects } = transition(withTurn(S, SENDING), DONE);
      expect(state).toMatchObject({ shown: S.shown, messages: [m1, q, ans], conversations: [convA, convB], error: null });
      expect(effects).toEqual(ENDED);
    });
    it('done landed from a new chat | shown takes thread:cid, opening+1, first in the list', () => {
      const s0 = withTurn({ ...S, shown: { key: 'new:0', id: null, opening: 2 }, messages: [] }, SENDING_NEW);
      const { state, effects } = transition(s0, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: { key: 'thread:C', id: 'C', opening: 3 }, messages: [q, ans], conversations: [{ id: 'C', title: 'hi' }, convA, convB] });
      expect(state.seq.opening).toBe(3);
      expect(effects).toEqual(ENDED);
    });
    it('done landed restarted (AC6a) | question + answer only; the old thread leaves the list', () => {
      const { state } = transition(withTurn(S, SENDING), { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: { key: 'thread:C', id: 'C', opening: 3 }, messages: [q, ans], conversations: [{ id: 'C', title: 'hi' }, convB] });
    });
    it('done left from a new chat | the list gains the thread; the shown chat is untouched (US-15 AC7a)', () => {
      const s0 = withTurn(S, SENDING_NEW);
      const { state } = transition(s0, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C' } });
      expect(state).toMatchObject({ shown: S.shown, messages: s0.messages, conversations: [{ id: 'C', title: 'hi' }, convA, convB] });
    });
    it('done left from a saved thread | the list is unchanged', () => {
      const s0 = withTurn(S, { ...SENDING, asked: { ...asked, key: 'thread:B' }, convId: 'B' });
      const { state } = transition(s0, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'B' } });
      expect(state).toMatchObject({ shown: S.shown, messages: s0.messages, conversations: [convA, convB] });
    });
    it('done left | a thread deleted during the send stays gone (AC7a)', () => {
      const s0 = withTurn({ ...S, conversations: [convA] }, { ...SENDING, asked: { ...asked, key: 'thread:B' }, convId: 'B' });
      expect(transition(s0, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'B' } }).state.conversations).toEqual([convA]);
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
    loadCells('done landed', sending, DONE, { none: [NONE, ENDED], loading: [NONE, ENDED], failed: [NONE, ENDED] });
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
    it('open-thread | shown {thread:id, id, opening+1}; messages [] while it loads; error null; notice none', () => {
      const { state } = transition({ ...S, error: 'x', notice: 'remote-erase' }, E);
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, messages: [], error: null, notice: 'none' });
    });
    listCells('open-thread', id, E, all4(FX));
    loadCells('open-thread', id, E, { none: [{ phase: 'loading', opening: 3, id: 'B' }, FX], loading: [{ phase: 'loading', opening: 3, id: 'B' }, FX], failed: [{ phase: 'loading', opening: 3, id: 'B' }, FX] });
  });

  describe('new-chat', () => {
    const E: ChatEvent = { type: 'new-chat' };
    const FX: Effect[] = [{ type: 'edits-leave' }, { type: 'focus-input' }, { type: 'post-new' }];
    it('new-chat | shown {new:k+1, null, opening+1}; messages []; error null; notice none', () => {
      const { state } = transition({ ...S, error: 'x', notice: 'remote-erase' }, E);
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], conversations: [convA, convB], error: null, notice: 'none' });
    });
    listCells('new-chat', id, E, all4(FX));
    loadCells('new-chat', id, E, { none: [NONE, FX], loading: [NONE, FX], failed: [NONE, FX] });
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
    loadCells('mirror-state same erase', id, NEW_ID, { none: [NONE, FX], loading: [NONE, FX], failed: [NONE, FX] });
    loadCells('mirror-state same erase, same id', id, SAME_ID, { none: [NONE, []], loading: [NONE, []], failed: [NONE, []] });
    loadCells('mirror-state other erase', id, OTHER, both([]));
    // Adversary R1, Codex R2: a post from a tab whose thread is not read carries no turns to trust.
    const UNREAD: ChatEvent = { type: 'mirror-state', payload: { ...payload, loaded: false } };
    const UNREAD_SAME: ChatEvent = { type: 'mirror-state', payload: { ...payload, activeConversationId: 'A', loaded: false } };
    const READ_OUT = (opening: number): Effect[] => [...FX, { type: 'read-turns', opening, id: 'B' }];
    it('mirror-state, loaded false, a new id | the thread opened here: no turns taken, read here, Send locked', () => {
      const { state, effects } = transition(S, UNREAD);
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, messages: [], conversations: [convB], error: 'theirs', load: { phase: 'loading', opening: 3, id: 'B' } });
      expect(effects).toEqual(READ_OUT(3));
      expect(busy(state, false)).toBe(true);
    });
    it('mirror-state, loaded false, same id | this tab\'s own turns and load kept; the list and error taken', () => {
      for (const load of [NONE, LOADS.loading, LOADS.failed]) {
        const { state, effects } = transition({ ...S, load }, UNREAD_SAME);
        expect(state).toMatchObject({ shown: S.shown, messages: [m1], conversations: [convB], error: 'theirs', load });
        expect(effects).toEqual([]);
      }
    });
    it('mirror-state, loaded true | as an older bundle\'s post (no field): the payload\'s turns', () => {
      const loaded = transition(S, { type: 'mirror-state', payload: { ...payload, loaded: true } });
      expect(loaded).toEqual(transition(S, NEW_ID));
      expect(loaded.state).toMatchObject({ messages: [m2], load: NONE });
    });
    it('mirror-state, loaded false, then a send | refused until the thread is read here, then sent with its own turns', () => {
      const opened = transition(S, UNREAD).state;
      expect(transition(opened, SEND).effects).toEqual([]);
      const read = transition(opened, { type: 'load-landed', opening: 3, id: 'B', turns: [m1, m2] }).state;
      expect(transition(read, SEND).effects).toContainEqual({ type: 'request', turn: 1, question: 'hi', convId: 'B', history: [m1, m2] });
    });
    const B3: Load = { phase: 'loading', opening: 3, id: 'B' };
    loadCells('mirror-state loaded false, a new id', id, UNREAD, { none: [B3, READ_OUT(3)], loading: [B3, READ_OUT(3)], failed: [B3, READ_OUT(3)] });
  });

  describe('mirror-new', () => {
    const E: ChatEvent = { type: 'mirror-new' };
    it('mirror-new | as new-chat, without focus-input or post-new', () => {
      const { state, effects } = transition({ ...S, error: 'x' }, E);
      expect(state).toMatchObject({ shown: { key: 'new:1', id: null, opening: 3 }, messages: [], error: null, notice: 'none' });
      expect(effects).toEqual([{ type: 'edits-leave' }]);
    });
    listCells('mirror-new', id, E, all4([{ type: 'edits-leave' }]));
    loadCells('mirror-new', id, E, { none: [NONE, [{ type: 'edits-leave' }]], loading: [NONE, [{ type: 'edits-leave' }]], failed: [NONE, [{ type: 'edits-leave' }]] });
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
    loadCells('thread-gone shown', id, SHOWN, { none: [NONE, FX], loading: [NONE, FX], failed: [NONE, FX] });
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
    listCells('erase-state{none → own}', id, OWN, { unread: [SAME, []], waiting: [SAME, []], reading: [{ phase: 'waiting', autoOpen: false }, []], read: [SAME, []] });
    listCells('erase-state{own → none}', moving('own'), NONE_E, { unread: [SAME, []], waiting: [reading(4), [{ type: 'read-list', read: 4 }]], reading: [SAME, []], read: [SAME, []] });
    const REMOTE_E: ChatEvent = { type: 'erase-state', moving: 'remote' };
    listCells('erase-state{none → remote}', id, REMOTE_E, { unread: [SAME, []], waiting: [SAME, []], reading: [{ phase: 'waiting', autoOpen: false }, []], read: [SAME, []] });
    listCells('erase-state{remote → none}', moving('remote'), NONE_E, { unread: [SAME, []], waiting: [reading(4), [{ type: 'read-list', read: 4 }]], reading: [SAME, []], read: [SAME, []] });
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
    loadCells('erase-shown{own}', id, OWN, { none: [NONE, [{ type: 'clear-extras' }]], loading: [NONE, [{ type: 'clear-extras' }]], failed: [NONE, [{ type: 'clear-extras' }]] });
    const RFX: Effect[] = [{ type: 'clear-extras' }, { type: 'edits-leave' }];
    const RRL: Effect[] = [...RFX, { type: 'read-list', read: 4 }];
    listCells('erase-shown{remote}', id, REMOTE, { unread: [SAME, RFX], waiting: [reading(4), RRL], reading: [reading(4), RRL], read: [reading(4), RRL] });
    loadCells('erase-shown{remote}', id, REMOTE, { none: [NONE, RFX], loading: [NONE, RFX], failed: [NONE, RFX] });
  });

  describe('list-wanted', () => {
    const E: ChatEvent = { type: 'list-wanted', guest: false };
    const own: Prep = (s) => ({ ...s, erase: { ...s.erase, moving: 'own' } });
    it('list-wanted | no change to the shown chat', () => {
      expect(transition(S, E).state).toMatchObject({ shown: S.shown, messages: S.messages, conversations: S.conversations });
    });
    listCells('list-wanted, moving none', id, E, { unread: [reading(4), [{ type: 'read-list', read: 4 }]], waiting: [SAME, []], reading: [SAME, []], read: [SAME, []] });
    listCells('list-wanted, moving own', own, E, { unread: [{ phase: 'waiting', autoOpen: false }, []], waiting: [SAME, []], reading: [SAME, []], read: [SAME, []] });
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
    it('list-landed, a guest\'s first read with threads | opens the latest (Q7, US-15 AC7a)', () => {
      const s0 = { ...S, list: reading(3, true) };
      const { state, effects } = transition(s0, { ...E, conversations: [convB, convA] });
      expect(state).toMatchObject({ shown: { key: 'thread:B', id: 'B', opening: 3 }, conversations: [convB, convA], list: { phase: 'read' } });
      expect(effects).toEqual([{ type: 'read-turns', opening: 3, id: 'B' }]);
    });
    it('list-landed, a guest\'s first read with no threads | nothing opened', () => {
      const s0 = { ...S, list: reading(3, true) };
      expect(transition(s0, { ...E, conversations: [] })).toEqual({ state: { ...s0, list: { phase: 'read' }, conversations: [] }, effects: [] });
    });
    listCells('list-landed', id, E, { unread: [SAME, []], waiting: [SAME, []], reading: [{ phase: 'read' }, []], read: [SAME, []] });
    listCells('list-landed stale', id, { ...E, read: 2 }, all4([]));
    const guest: Prep = (s) => ({ ...s, list: reading(3, true) });
    const OPEN: Load = { phase: 'loading', opening: 3, id: 'B' };
    loadCells('list-landed, a guest opening the latest', guest, E, { none: [OPEN, [{ type: 'read-turns', opening: 3, id: 'B' }]], loading: [OPEN, [{ type: 'read-turns', opening: 3, id: 'B' }]], failed: [OPEN, [{ type: 'read-turns', opening: 3, id: 'B' }]] });
    loadCells('list-landed, no auto-open', (s) => ({ ...s, list: reading(3) }), E, both([]));

    // Codex on PR 1349: a guest who moved before the first read was even wanted.
    const INIT = initialChatState({ erase: 'E0', moving: 'none' });
    const GUEST: ChatEvent = { type: 'list-wanted', guest: true };
    it('send, then a guest\'s list-wanted, then list-landed | the asked chat stays; the reply shows (US-15 AC7a, Q7)', () => {
      const asked = step(INIT, SEND, GUEST);
      const landed = transition(asked.state, { type: 'list-landed', read: 1, conversations: [convA] });
      expect(landed.state.shown).toEqual(INIT.shown);
      expect(landed.effects.some((f) => f.type === 'read-turns')).toBe(false);
      const done = transition(landed.state, { type: 'done', turn: 1, now: T1, result: RES });
      expect(done.state.shown).toMatchObject({ key: 'thread:A', id: 'A' }); // landed: the new chat becomes its thread
      expect(done.state.messages.map((m) => m.content)).toEqual(['hi', 'ans']);
    });
    it('open-thread, then a guest\'s list-wanted, then list-landed | the opened thread stays (US-15 AC7a, Q7)', () => {
      const opened = step(INIT, { type: 'open-thread', id: 'A' }, GUEST);
      const landed = transition(opened.state, { type: 'list-landed', read: 1, conversations: [convB, convA] });
      expect(landed.state.shown).toMatchObject({ key: 'thread:A', id: 'A' });
      expect(landed.effects).toEqual([]);
    });
    it('open-thread while moving, then a guest\'s list-wanted | waiting, no auto-open (US-15 AC7a, Q7)', () => {
      const moving = initialChatState({ erase: 'E0', moving: 'own' });
      expect(step(moving, { type: 'open-thread', id: 'A' }, GUEST).state.list).toEqual({ phase: 'waiting', autoOpen: false });
    });
    it('a guest\'s list-wanted from the untouched first chat | auto-opens on landing (Q7)', () => {
      expect(transition(INIT, GUEST).state.list).toEqual({ phase: 'reading', read: 1, autoOpen: true });
    });
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
    it('load-landed null turns, current, the shown thread | dropped from the list; a new chat; load none (AC6a)', () => {
      const { state, effects } = transition(loading(S), { ...E, turns: null });
      expect(state).toEqual({
        ...S, seq: { ...S.seq, key: 1, opening: 3 }, shown: { key: 'new:1', id: null, opening: 3 },
        messages: [], conversations: [convB], load: NONE,
      });
      expect(effects).toEqual([{ type: 'edits-leave' }]);
    });
    loadCells('load-landed null, shown, current', id, { ...E, turns: null }, { none: [NONE, [{ type: 'edits-leave' }]], loading: [NONE, [{ type: 'edits-leave' }]], failed: [NONE, [{ type: 'edits-leave' }]] });
    listCells('load-landed current', loading, E, all4([{ type: 'post-state' }]));
    loadCells('load-landed', id, E, { none: [SAME, []], loading: [NONE, [{ type: 'post-state' }]], failed: [SAME, []] });
    loadCells('load-landed stale', id, { ...E, opening: 1 }, both([]));
    loadCells('load-landed null, shown', id, { ...E, opening: 1, turns: null }, { none: [NONE, [{ type: 'edits-leave' }]], loading: [NONE, [{ type: 'edits-leave' }]], failed: [NONE, [{ type: 'edits-leave' }]] });
  });

  // N2 (Fable 2026-11-12): a load that failed is not an empty thread; Send stays locked until the person leaves or tries again.
  describe('load-failed', () => {
    const E: ChatEvent = { type: 'load-failed', opening: 2, id: 'A' };
    const FAILED: Load = { phase: 'failed', opening: 2, id: 'A' };
    const loading: Prep = (s) => ({ ...s, load: LOADS.loading, messages: [] });
    it('load-failed current | failed; the shown chat, its turns and the list unchanged; no effects', () => {
      const s0 = loading(S);
      expect(transition(s0, E)).toEqual({ state: { ...s0, load: FAILED }, effects: [] });
      expect(busy({ ...s0, load: FAILED }, false)).toBe(true);
    });
    it.each([['an older opening', { ...E, opening: 1 }], ['another thread', { ...E, id: 'B' }]] as const)('load-failed for %s | dropped', (_, e) => {
      const s0 = loading(S);
      expect(transition(s0, e)).toEqual({ state: s0, effects: [] });
    });
    listCells('load-failed current', loading, E, all4([]));
    loadCells('load-failed', id, E, { none: [SAME, []], loading: [FAILED, []], failed: [SAME, []] });
    loadCells('load-failed stale', id, { ...E, opening: 1 }, both([]));
    it('Try again: open-thread of the same id | loading at a new opening, read-turns', () => {
      const { state, effects } = transition({ ...S, load: FAILED }, { type: 'open-thread', id: 'A' });
      expect(state.load).toEqual({ phase: 'loading', opening: 3, id: 'A' });
      expect(effects).toEqual([{ type: 'edits-leave' }, { type: 'read-turns', opening: 3, id: 'A' }]);
    });
    it('a landing that comes after the load failed (a 20 s timeout, then the read) | dropped', () => {
      const s0 = { ...S, load: FAILED };
      expect(transition(s0, { type: 'load-landed', opening: 2, id: 'A', turns: [m2] })).toEqual({ state: s0, effects: [] });
    });
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
    expect(initialChatState({ erase: 'E5', moving: 'remote' })).toEqual({
      shown: { key: 'new:0', id: null, opening: 0 }, messages: [], conversations: [],
      turn: { phase: 'idle' }, list: { phase: 'unread' }, load: { phase: 'none' },
      erase: { shown: 'E5', moving: 'remote' }, notice: 'none', error: null, seq: { key: 0, opening: 0, turn: 0, read: 0 },
    });
  });
  it('initialChatState with a prefetched thread: that thread shown at opening 0, its turns, the list read', () => {
    const s = initialChatState({ erase: 'E0', moving: 'none', conversations: [convA], opened: { id: 'A', messages: [m1] } });
    expect(s).toMatchObject({ shown: { key: 'thread:A', id: 'A', opening: 0 }, messages: [m1], conversations: [convA], list: { phase: 'read' } });
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
  const I = initialChatState({ erase: 'E0', moving: 'none' });
  const send: ChatEvent = { type: 'send', text: 'hi', online: true, othersBusy: false, now: T0, nonce: 'n1' };

  it('1311c R1: erased streamed text stays — erase-shown orphans the turn and its deltas drop', () => {
    const streaming = step(I, send, { type: 'delta', turn: 1, delta: { type: 'text', text: 'abc' } }).state;
    expect(showsPending(streaming)).toEqual({ thinking: '', sources: [], text: 'abc', status: '' });
    const erased = transition(streaming, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    expect([erased.turn.phase, showsPending(erased), erased.messages]).toEqual(['orphaned', null, []]);
    expect(transition(erased, { type: 'delta', turn: 1, delta: { type: 'text', text: 'd' } })).toEqual({ state: erased, effects: [] });
  });

  it('Adversary R1: a remote arrival whose read fails — erase-state none reads the list and unlocks Send', () => {
    let s = step(I, { type: 'erase-state', moving: 'remote' }, { type: 'list-wanted', guest: false }).state;
    expect(s.list).toEqual({ phase: 'waiting', autoOpen: false });
    expect(transition(s, send)).toEqual({ state: s, effects: [] });
    const back = transition(s, { type: 'erase-state', moving: 'none' });
    expect(back.state.list).toEqual({ phase: 'reading', read: 1, autoOpen: false });
    expect(back.effects).toEqual([{ type: 'read-list', read: 1 }]);
    s = transition(back.state, send).state;
    expect(s.turn.phase).toBe('sending');
  });

  it('1311c R2: a pre-erase list read restores titles — read 1 is dropped by number', () => {
    let s = step(I, { type: 'list-wanted', guest: false }, { type: 'erase-state', moving: 'own' }).state;
    expect(s.list).toEqual({ phase: 'waiting', autoOpen: false });
    expect(transition(s, { type: 'list-landed', read: 1, conversations: [convA] })).toEqual({ state: s, effects: [] });
    s = transition(s, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    expect(s.list).toEqual({ phase: 'reading', read: 2, autoOpen: false });
    expect(transition(s, { type: 'list-landed', read: 1, conversations: [convA] })).toEqual({ state: s, effects: [] });
    s = transition(s, { type: 'list-landed', read: 2, conversations: [] }).state;
    expect([s.list, s.conversations]).toEqual([{ phase: 'read' }, []]);
  });

  it('1311c R3: a late erased reply shows "Not saved" in a new chat — stayed is false there', () => {
    const orphaned = step(I, send, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    const inNew = step(orphaned, { type: 'new-chat' }, { type: 'done', turn: 1, now: T1, result: RES_R });
    expect(inNew.effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    expect(inNew.state.messages).toEqual([]);
    // Control: under the chat that asked, an own erase says "Not saved" (US-16 AC2e).
    expect(transition(orphaned, { type: 'done', turn: 1, now: T1, result: RES_R }).effects)
      .toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: true }, ...ENDED]);
  });

  it('1311d R1: a list retry loop while an erase is half done — no read until the erase shows', () => {
    const r = step(I, { type: 'erase-state', moving: 'own' }, { type: 'list-wanted', guest: false });
    expect([r.state.list, r.effects]).toEqual([{ phase: 'waiting', autoOpen: false }, []]);
    expect(transition(r.state, { type: 'list-wanted', guest: false })).toEqual({ state: r.state, effects: [] });
    expect(transition(r.state, { type: 'list-landed', read: 0, conversations: [convA] })).toEqual({ state: r.state, effects: [] });
    const shown = transition(r.state, { type: 'erase-shown', erase: 'E1', by: 'own' });
    expect(shown.effects).toEqual([{ type: 'clear-extras' }, { type: 'read-list', read: 1 }]);
    expect(transition(shown.state, { type: 'erase-state', moving: 'none' }).effects).toEqual([]);
  });

  it('1311d R2: A, B, A — the older A load is dropped (US-15 AC7a)', () => {
    const s = step(I, { type: 'open-thread', id: 'A' }, { type: 'open-thread', id: 'B' }, { type: 'open-thread', id: 'A' }).state;
    expect(s.load).toEqual({ phase: 'loading', opening: 3, id: 'A' });
    expect(transition(s, { type: 'load-landed', opening: 1, id: 'A', turns: [m1] })).toEqual({ state: s, effects: [] });
    expect(transition(s, { type: 'load-landed', opening: 2, id: 'B', turns: [m1] })).toEqual({ state: s, effects: [] });
    const r = transition(s, { type: 'load-landed', opening: 3, id: 'A', turns: [m2] });
    expect([r.state.messages, r.state.load, r.effects]).toEqual([[m2], { phase: 'none' }, [{ type: 'post-state' }]]);
  });

  it('1306b R1: A\'s refusal shows under B — the reply that left takes edits not stayed (US-15 AC7a, US-67 AC2)', () => {
    const s = step(I, { type: 'open-thread', id: 'A' }, { type: 'load-landed', opening: 1, id: 'A', turns: [m1] }, send, { type: 'open-thread', id: 'B' }).state;
    const r = transition(s, { type: 'done', turn: 1, now: T1, result: RES_R });
    expect(r.effects).toEqual([{ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false }, ...ENDED]);
    expect([r.state.shown.id, r.state.messages]).toEqual(['B', s.messages]);
  });

  it('1306c R1: two new chats both have id null — their keys still differ', () => {
    const s = step(I, send, { type: 'new-chat' }).state;
    expect([s.shown.id, s.shown.key, s.turn.phase === 'sending' && s.turn.asked.key]).toEqual([null, 'new:1', 'new:0']);
    const r = transition(s, { type: 'done', turn: 1, now: T1, result: { ...RES_R, conversationId: 'C' } });
    expect(r.state).toMatchObject({ shown: { key: 'new:1', id: null }, messages: [], conversations: [{ id: 'C', title: 'hi' }] });
    expect(r.effects[0]).toEqual({ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false });
  });

  it('Live 2026-11-12: "+ New Chat" just after a send shows no dots, and Send stays locked (US-15 AC7a, amended Q8)', () => {
    const s = step(I, send, { type: 'delta', turn: 1, delta: { type: 'text', text: 'a' } }, { type: 'new-chat' }).state;
    expect([isLocalSender(s), showsPending(s), busy(s, false)]).toEqual([false, null, true]);
    expect(transition(s, send)).toEqual({ state: s, effects: [] });
  });

  it('1306d R1: thread-new is seen only after the effect runs — mirror-new moves the key at once', () => {
    const s = step(I, send, { type: 'mirror-new' }).state;
    expect(s.shown.key).toBe('new:1');
    const r = transition(s, { type: 'done', turn: 1, now: T1, result: RES_R });
    expect(r.state.messages).toEqual([]);
    expect(r.effects[0]).toEqual({ type: 'take-edits', edits: [], refusals: [REFUSAL], erase: 'E0', stayed: false });
  });
});

// ---------------------------------------------------------------------------
describe('PR 1349 review round', () => {
  const I = initialChatState({ erase: 'E0', moving: 'none' });
  const send: ChatEvent = { type: 'send', text: 'hi', online: true, othersBusy: false, now: T0, nonce: 'n1' };
  const guestWants: ChatEvent = { type: 'list-wanted', guest: true };

  it('A: the hook\'s clock stamps the question at send and the answer at done (chat-api\'s resend dedup reads createdAt)', () => {
    const sent = transition(I, send).state;
    expect(sent.messages).toEqual([{ id: 'temp-n1', role: 'user', content: 'hi', createdAt: T0 }]);
    const landed = transition(sent, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C' } }).state;
    expect(landed.messages.map((m) => m.createdAt)).toEqual([T0, T1]);
  });

  it('B: ids come from the send\'s nonce, so a tab that mirrored another tab\'s turn 1 mints no duplicate id', () => {
    const theirs: Msg[] = [{ id: 'temp-1', role: 'user', content: 'a', createdAt: T0 }, { id: 'assistant-1', role: 'assistant', content: 'b', createdAt: T0 }];
    const mirrored = transition(I, { type: 'mirror-state', payload: { conversations: [], activeConversationId: null, messages: theirs, error: null } }).state;
    const sent = transition(mirrored, { ...send, nonce: 'tabB-1' });
    expect(sent.state.turn).toMatchObject({ phase: 'sending', turn: 1, nonce: 'tabB-1' });
    const landed = transition(sent.state, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C', messageId: null } }).state;
    const ids = landed.messages.map((m) => m.id);
    expect(ids).toEqual(['temp-1', 'assistant-1', 'temp-tabB-1', 'assistant-tabB-1']);
  });

  it('C (Codex): list-wanted, New chat, send, then the list lands — the guest is not moved to the latest thread, and the reply lands (US-15 AC7a)', () => {
    const s = step(I, guestWants, { type: 'new-chat' }, send).state;
    const landed = transition(s, { type: 'list-landed', read: 1, conversations: [convA] });
    expect(landed.effects).toEqual([]);
    expect(landed.state).toMatchObject({ shown: { key: 'new:1', id: null }, list: { phase: 'read' }, conversations: [convA], load: NONE });
    const done = transition(landed.state, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'C' } });
    expect(done.state).toMatchObject({ shown: { key: 'thread:C', id: 'C' }, messages: [q, ans] });
    expect(done.effects).toEqual(ENDED); // landed, not left
  });

  it.each<[string, ChatEvent]>([
    ['open-thread', { type: 'open-thread', id: 'B' }],
    ['send', send],
    ['mirror-new', { type: 'mirror-new' }],
    ['mirror-state with a new chat', { type: 'mirror-state', payload: { conversations: [], activeConversationId: 'B', messages: [], error: null } }],
  ])('C: %s while a guest\'s first read is out — the landing opens nothing (US-15 AC7a)', (_, e) => {
    const s = step(I, guestWants, e).state;
    const landed = transition(s, { type: 'list-landed', read: 1, conversations: [convA] });
    expect(landed.effects).toEqual([]);
    expect(landed.state.shown).toEqual(s.shown);
  });

  it('C: erase-shown, reading{r+1}, send, landing — a read after an erase never opens (US-15 AC7a)', () => {
    let s = transition(I, guestWants).state;
    expect(s.list).toEqual({ phase: 'reading', read: 1, autoOpen: true });
    s = transition(s, { type: 'erase-shown', erase: 'E1', by: 'own' }).state;
    expect(s.list).toEqual({ phase: 'reading', read: 2, autoOpen: false });
    s = transition(s, send).state;
    const landed = transition(s, { type: 'list-landed', read: 2, conversations: [convA] });
    expect(landed.effects).toEqual([]);
    expect(landed.state.shown).toEqual(s.shown);
  });

  it('C: a guest\'s first read deferred by an erase that failed still opens the latest (Q7)', () => {
    const s = step(I, { type: 'erase-state', moving: 'own' }, guestWants).state;
    expect(s.list).toEqual({ phase: 'waiting', autoOpen: true });
    const back = transition(s, { type: 'erase-state', moving: 'none' });
    expect(back.state.list).toEqual({ phase: 'reading', read: 1, autoOpen: true });
    const landed = transition(back.state, { type: 'list-landed', read: 1, conversations: [convA, convB] });
    expect(landed.effects).toEqual([{ type: 'read-turns', opening: 1, id: 'A' }]);
  });

  it('C: a signed-in first read opens nothing', () => {
    const s = transition(I, { type: 'list-wanted', guest: false }).state;
    expect(transition(s, { type: 'list-landed', read: 1, conversations: [convA] }).effects).toEqual([]);
  });

  it('D (Codex): open B, send, load B, done — the send waits for B\'s turns and carries them (US-15 AC7a)', () => {
    let s = transition(S, { type: 'open-thread', id: 'B' }).state;
    expect([s.messages, busy(s, false)]).toEqual([[], true]);
    expect(transition(s, send)).toEqual({ state: s, effects: [] });
    s = transition(s, { type: 'load-landed', opening: 3, id: 'B', turns: [m2] }).state;
    expect(busy(s, false)).toBe(false);
    const sent = transition(s, send);
    expect(sent.effects).toContainEqual({ type: 'request', turn: 1, question: 'hi', convId: 'B', history: [m2] });
    const done = transition(sent.state, { type: 'done', turn: 1, now: T1, result: { ...RES, conversationId: 'B' } });
    expect(done.state.messages).toEqual([m2, q, ans]);
  });

  it('H: a prefetched list mounts read; a guest\'s list-wanted then reads and opens nothing', () => {
    const p = initialChatState({ erase: 'E0', moving: 'none', conversations: [convA] });
    expect([p.list, p.conversations]).toEqual([{ phase: 'read' }, [convA]]);
    expect(transition(p, guestWants)).toEqual({ state: p, effects: [] });
  });
});
