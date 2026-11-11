/**
 * The chat-turn reducer over random event sequences (design page §7 item 1).
 * A seeded PRNG (mulberry32), no dependency: ~500 sequences of 1-40 events,
 * landings sometimes current and sometimes stale. Five invariants after every
 * step; a failure prints the seed and the sequence.
 */
import { describe, expect, it } from 'vitest';
import {
  initialChatState, isLocalSender, showsPending, transition,
  type ChatEvent, type ChatState, type Conv, type Effect, type Msg,
} from './chat-turn';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['A', 'B', 'C'];
const ERASES = ['E0', 'E1', 'E2'];
const msg = (id: string): Msg => ({ id, role: 'assistant', content: id });
const convs = (ids: string[]): Conv[] => ids.map((id) => ({ id, title: id }));

/** One event, weighted, with landings carrying the current number about half the time. */
function genEvent(r: () => number, s: ChatState): ChatEvent {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const turnNo = s.turn.phase !== 'idle' && coin(0.7) ? s.turn.turn : Math.floor(r() * (s.seq.turn + 2));
  const kinds: Array<[number, () => ChatEvent]> = [
    [10, () => ({ type: 'send', text: pick(['hi', 'hi', 'hi', '', '  ', 'x'.repeat(8001)]), online: coin(0.9), othersBusy: coin(0.1) })],
    [10, () => ({ type: 'delta', turn: turnNo, delta: coin(0.2) ? { type: 'sources', titles: ['s'] } : { type: pick(['text', 'thinking', 'status'] as const), text: 't' } })],
    [8, () => ({ type: 'done', turn: turnNo, result: {
      conversationId: pick(IDS), messageId: coin(0.5) ? 'r' : null, content: 'a', isFallback: coin(0.1),
      editRefusals: coin(0.5) ? [{ part: 'review', words: 'w' }] : undefined, subscriptionCard: coin(0.2) ? { c: 1 } : undefined,
    } })],
    [4, () => ({ type: 'failed', turn: turnNo, message: 'f', boxEmpty: coin(0.5) })],
    [6, () => ({ type: 'open-thread', id: pick(IDS) })],
    [4, () => ({ type: 'new-chat' })],
    [4, () => ({ type: 'mirror-state', payload: {
      conversations: convs(IDS.filter(() => coin(0.5))), activeConversationId: coin(0.3) ? null : pick(IDS), messages: [msg('mm')], error: null,
      ...(coin(0.3) ? {} : { erase: coin(0.6) ? s.erase.shown : pick(ERASES) }),
    } })],
    [2, () => ({ type: 'mirror-new' })],
    [3, () => ({ type: 'thread-gone', id: pick(IDS), tell: coin(0.5) })],
    [5, () => ({ type: 'erase-state', moving: pick(['none', 'own', 'remote'] as const) })],
    [4, () => ({ type: 'erase-shown', erase: coin(0.2) ? s.erase.shown : pick(ERASES), by: pick(['own', 'remote'] as const) })],
    [5, () => ({ type: 'list-wanted' })],
    [6, () => ({
      type: 'list-landed', read: s.list.phase === 'reading' && coin(0.6) ? s.list.read : Math.floor(r() * (s.seq.read + 2)),
      conversations: coin(0.2) ? null : convs(IDS.filter(() => coin(0.5))),
    })],
    [6, () => {
      const current = s.load.phase === 'loading' && coin(0.6);
      return {
        type: 'load-landed', opening: current && s.load.phase === 'loading' ? s.load.opening : Math.floor(r() * (s.seq.opening + 2)),
        id: current && s.load.phase === 'loading' ? s.load.id : pick(IDS), turns: coin(0.2) ? null : [msg('L')],
      };
    }],
    [2, () => ({ type: 'dismiss' })],
  ];
  let w = r() * kinds.reduce((n, [k]) => n + k, 0);
  for (const [k, make] of kinds) if ((w -= k) < 0) return make();
  return kinds[0][1]();
}

const LANDINGS = new Set(['delta', 'done', 'failed', 'list-landed', 'load-landed']);
const isCurrent = (s: ChatState, e: ChatEvent): boolean => {
  if (e.type === 'delta' || e.type === 'done' || e.type === 'failed') return s.turn.phase !== 'idle' && s.turn.turn === e.turn;
  if (e.type === 'list-landed') return s.list.phase === 'reading' && s.list.read === e.read;
  if (e.type === 'load-landed') return e.turns === null || (s.load.phase === 'loading' && s.load.opening === e.opening && s.load.id === e.id);
  return true;
};
const count = (fx: Effect[], type: Effect['type']) => fx.filter((f) => f.type === type).length;

/** Returns the broken invariant's description, or null. */
function check(prev: ChatState, e: ChatEvent, next: ChatState, fx: Effect[], lastMoving: string): string | null {
  // 1. The pending reply or the indicator only under the chat and erase that asked.
  if (showsPending(next) || isLocalSender(next)) {
    const t = next.turn;
    if (t.phase === 'idle' || t.phase === 'orphaned' || t.asked.key !== next.shown.key || t.asked.erase !== next.erase.shown) return 'I1: pending/indicator off its chat or erase';
  }
  // 2. take-edits stayed only under the asking chat and erase (orphaned{own} excepted).
  for (const f of fx) {
    if (f.type !== 'take-edits' || !f.stayed) continue;
    const t = prev.turn;
    if (t.phase === 'idle' || t.asked.key !== prev.shown.key) return 'I2: stayed with a different key';
    if (t.asked.erase !== prev.erase.shown && !(t.phase === 'orphaned' && t.by === 'own')) return 'I2: stayed with a different erase';
  }
  // 3. One request, list read and load current; each minted one is the state's; a stale landing changes nothing.
  if (count(fx, 'request') > 1 || count(fx, 'read-list') > 1 || count(fx, 'read-turns') > 1) return 'I3: two reads or requests in one step';
  for (const f of fx) {
    if (f.type === 'request' && (prev.turn.phase !== 'idle' || next.turn.phase !== 'sending' || next.turn.turn !== f.turn)) return 'I3: request not the turn in flight';
    if (f.type === 'read-list' && (next.list.phase !== 'reading' || next.list.read !== f.read)) return 'I3: read-list not the current read';
    if (f.type === 'read-turns' && (next.load.phase !== 'loading' || next.load.opening !== f.opening || next.load.id !== f.id)) return 'I3: read-turns not the current load';
  }
  if (LANDINGS.has(e.type) && !isCurrent(prev, e) && (JSON.stringify(next) !== JSON.stringify(prev) || fx.length > 0)) return 'I3: a stale landing changed state';
  // 4. No read or request in response to a landing that was dropped; no landing ever re-asks.
  if (LANDINGS.has(e.type) && (count(fx, 'request') + count(fx, 'read-list') > 0)) return 'I4: a landing re-asked';
  if (e.type === 'load-landed' && count(fx, 'read-turns') > 0) return 'I4: a load landing re-asked';
  // 5. moving is the last erase-state's, and nothing else moves it.
  if (next.erase.moving !== lastMoving) return 'I5: moving is not the last erase-state';
  return null;
}

describe('chat-turn property: five invariants over random sequences (§7 item 1)', () => {
  it('holds for 500 seeded sequences of 1-40 events', () => {
    let steps = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const r = mulberry32(seed);
      const initialMoving = (['none', 'none', 'own', 'remote'] as const)[seed % 4];
      let s = initialChatState({ guest: seed % 3 === 0, erase: 'E0', moving: initialMoving });
      let lastMoving: string = initialMoving;
      const events: ChatEvent[] = [];
      const n = 1 + Math.floor(r() * 40);
      for (let i = 0; i < n; i++) {
        const e = genEvent(r, s);
        events.push(e);
        const before = JSON.stringify(s);
        const { state, effects } = transition(s, e);
        if (e.type === 'erase-state') lastMoving = e.moving;
        const broken = JSON.stringify(s) !== before ? 'purity: the input state was mutated' : check(s, e, state, effects, lastMoving);
        if (broken) {
          throw new Error(`${broken}\nseed ${seed}, step ${i}\nevents: ${JSON.stringify(events)}\nprev: ${before}\nnext: ${JSON.stringify(state)}\neffects: ${JSON.stringify(effects)}`);
        }
        s = state;
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(5000);
  });
});
