/**
 * The erase machine's table (untangle fix 4; US-16 AC2a, AC2d; US-11 AC6;
 * US-34 AC1, AC4): one row per (state, event), each naming the state that
 * follows and the effects, in order. Letters cite Fable's rulings (a-g), Q3,
 * Q4, (i) and (iii); "order" is the final re-ruling's epoch-only order;
 * "heard" and R1-R4 are round 3's (an arrival remembered until shown).
 * Synthetic identities only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createEraseStore, initialEraseState, refusalIsNews, transition,
  type EraseDoors, type EraseEffect, type EraseEvent, type EraseState,
} from './erase-machine';
import { epochOf } from '@roadmap/health-core/erase-identity';

const id = (epoch: number, at: string | null) => JSON.stringify([epoch, at]);
const W = id(0, null); // the record before any erase
const X = id(1, '2026-11-01T10:00:00.000Z'); // another writer's erase
const Y = id(1, '2026-11-01T10:00:05.000Z'); // this tab's erase, racing X at the same epoch, later
const E = id(1, '2026-09-01T00:00:00.001Z'); // epoch 1 as a merge can pick it: EARLIER than X (a listing erase takes an unlisted one's erasedAt)
const Z = id(2, '2026-11-01T10:00:09.000Z'); // another writer's erase at a higher epoch
const M = 'not an identity'; // malformed: epoch -1, the floor
const O = id(3, '2026-11-01T10:00:12.000Z'); // this tab's own erase, ending above Z

const set = (...ids: string[]) => new Set(ids);
type Extra = { heard?: string; said?: Set<string>; counted?: Set<string> };
const state = (phase: EraseState['phase'], shown: string, x: Extra): EraseState =>
  ({ phase, shown, heard: x.heard ?? null, said: x.said ?? set(), counted: x.counted ?? set() });
const loading = (shown: string, heard: string | null = null, x: Extra = {}) => state('loading', shown, { ...x, heard: heard ?? undefined });
const idle = (shown: string, x: Extra = {}) => state('idle', shown, x);
const erasing = (shown: string, heard: string | null = null, x: Extra = {}) => state('erasing', shown, { ...x, heard: heard ?? undefined });

const COUNT: EraseEffect = { type: 'count-remote-change' };
const READ: EraseEffect = { type: 'read' };
const CLEAR: EraseEffect = { type: 'clear-drafts' };
const FORGET: EraseEffect = { type: 'forget' };
// The say-outcome text rides on the event that ends the erase (design Q6): synthetic text.
const DONE = 'erase done (test text)';
const FAILED_TEXT = 'erase failed (test text)';
const end = (identity: string): EraseEvent => ({ type: 'own-end', identity, message: DONE });
const FAILED: EraseEvent = { type: 'own-failed', message: FAILED_TEXT };
const SAY: EraseEffect = { type: 'say-outcome', message: DONE };
const SAY_FAILED: EraseEffect = { type: 'say-outcome', message: FAILED_TEXT };
const ALERT: EraseEffect = { type: 'alert-refused' };
const mark = (identity: string): EraseEffect => ({ type: 'mark-store', identity });

/** [rule, row, state, event, next state ('same': unchanged, the same object), effects] */
const rows: Array<[string, string, EraseState, EraseEvent, EraseState | 'same', EraseEffect[]]> = [
  // b: an arrival always reads and never counts; the read shows it. heard: remembered until something shows it.
  ['a b heard', 'idle: another writer\'s new erase arrives: heard, read, not counted, not yet shown', idle(W), { type: 'arrived', identity: X }, idle(W, { heard: X }), [READ]],
  ['a b heard', 'idle: an arrival for the erase already shown: heard, read (it can carry rows), not counted', idle(X), { type: 'arrived', identity: X }, idle(X, { heard: X }), [READ]],
  ['heard order', 'idle: a second arrival, its first read still out: the latest heard, read again', idle(W, { heard: X }), { type: 'arrived', identity: Z }, idle(W, { heard: Z }), [READ]],
  ['heard a c', 'idle: the read that shows the heard erase: shown, heard cleared, counted', idle(W, { heard: X }), { type: 'read', identity: X }, idle(X, { counted: set(X) }), [CLEAR, mark(X), COUNT]],
  ['heard', 'idle: a read of the erase already shown, one heard: heard cleared, nothing else', idle(X, { heard: X }), { type: 'read', identity: X }, idle(X), []],
  ['heard e', 'loading: the first read leaves the heard erase for loaded to read', loading(W, X), { type: 'read', identity: X }, loading(X, X, { counted: set(X) }), [CLEAR, mark(X), COUNT]],
  ['R1 heard', 'idle, an arrival heard, its read in flight: own-start: erasing, the heard erase carried', idle(W, { heard: Z }), { type: 'own-start' }, erasing(W, Z), []],
  ['R4', 'erasing, an erase heard: a read reporting this tab\'s own new identity changes nothing', erasing(W, Z), { type: 'read', identity: O }, 'same', []],
  ['R4', 'erasing, an erase heard: a read reporting the heard erase changes nothing (reads stay dropped)', erasing(W, Z), { type: 'read', identity: Z }, 'same', []],
  // a, c: a read that shows another writer's erase counts it, once.
  ['a c', 'idle: a read with a new erase: shown, drafts cleared, the store marked, counted', idle(W), { type: 'read', identity: X }, idle(X, { counted: set(X) }), [CLEAR, mark(X), COUNT]],
  ['a c', 'idle: a read moving back to an erase already counted: shown, not counted again', idle(Y, { counted: set(X, Y) }), { type: 'read', identity: X }, idle(X, { counted: set(X, Y) }), [CLEAR, mark(X)]],
  ['c', 'idle: a read with the erase shown: nothing', idle(X), { type: 'read', identity: X }, 'same', []],
  ['c', 'erasing: a read loses to this tab\'s erase', erasing(W), { type: 'read', identity: Y }, 'same', []],
  ['a c', 'loading: the first read shows its erase, and counts it', loading(W), { type: 'read', identity: X }, loading(X, null, { counted: set(X) }), [CLEAR, mark(X), COUNT]],
  // order: epoch only; within an epoch the latest report, by inequality.
  ['order', 'idle: a read with a lower epoch: nothing', idle(X), { type: 'read', identity: W }, 'same', []],
  ['order', 'idle: a read at the same epoch with an EARLIER erasedAt (the merge\'s listed-versus-unlisted pick): shown', idle(X), { type: 'read', identity: E }, idle(E, { counted: set(E) }), [CLEAR, mark(E), COUNT]],
  ['order', 'idle: a read at a higher epoch: shown', idle(Y), { type: 'read', identity: Z }, idle(Z, { counted: set(Z) }), [CLEAR, mark(Z), COUNT]],
  ['iii', 'idle: a read with a malformed identity sorts as epoch -1: nothing', idle(W), { type: 'read', identity: M }, 'same', []],
  ['iii', 'idle: a malformed identity shown: any readable erase replaces it', idle(M), { type: 'read', identity: W }, idle(W, { counted: set(W) }), [CLEAR, mark(W), COUNT]],
  // d: two erases racing. An arrival while erasing is kept, never counted at arrival (Q2).
  ['d Q2', 'erasing: another writer\'s erase arrives: heard, no read, not counted', erasing(W), { type: 'arrived', identity: Z }, erasing(W, Z), []],
  ['d order', 'erasing: a later report at the same epoch replaces the one kept, whatever its erasedAt', erasing(W, X), { type: 'arrived', identity: E }, erasing(W, E), []],
  ['d order', 'erasing: a report at a lower epoch keeps the higher', erasing(W, Z), { type: 'arrived', identity: X }, erasing(W, Z), []],
  ['iii', 'erasing: a malformed report keeps the readable one', erasing(W, X), { type: 'arrived', identity: M }, erasing(W, X), []],
  ['d', 'erasing: a refused save is no news (no alert-refused for the own erase)', erasing(W), { type: 'refused', askedUnder: W }, 'same', []],
  // g: this tab's erase ends at the store's identity.
  ['g', 'erasing: own-end, nothing overtook it: its erase shown, the old record forgotten, the pre-erase erase said, not counted', erasing(W), end(Y), idle(Y, { said: set(W) }), [FORGET, CLEAR, mark(Y), SAY]],
  ['d g Q2 R2', 'erasing: own-end at the heard erase (another writer\'s won): shown, its rows read, counted once, not forget-only', erasing(W, Z), end(Z), idle(Z, { said: set(W), counted: set(Z) }), [FORGET, CLEAR, mark(Z), READ, COUNT, SAY]],
  ['d g Q2', 'erasing: own-end at the overtaking erase, already counted: shown and read, not counted again', erasing(W, Z, { counted: set(Z) }), end(Z), idle(Z, { said: set(W), counted: set(Z) }), [FORGET, CLEAR, mark(Z), READ, SAY]],
  ['d g order', 'erasing: own-end at its own erase, an erase overtaken at the same epoch: its own shows, the overtaken one never counts', erasing(W, X), end(Y), idle(Y, { said: set(W) }), [FORGET, CLEAR, mark(Y), SAY]],
  ['d g order', 'erasing: own-end at a merge\'s pick with an EARLIER erasedAt than the shown erase, at that epoch: shown', erasing(X), end(E), idle(E, { said: set(X) }), [FORGET, CLEAR, mark(E), SAY]],
  ['g', 'idle: an own-end with no erase under way: nothing (the newer one stays shown)', idle(Z), end(Y), 'same', []],
  ['-', 'erasing: own-failed, nothing overtook it: back to idle, the failure said', erasing(W), FAILED, idle(W), [SAY_FAILED]],
  ['d i R1', 'erasing: own-failed, another writer\'s erase heard: idle, still heard, read, the failure said; the read shows and counts it', erasing(W, Z), FAILED, idle(W, { heard: Z }), [READ, SAY_FAILED]],
  ['known cost', 'erasing: own-end at the heard erase when that arrival was really this tab\'s own echo (record-session.ts:595/600 rule it out): the person sees their erase done, plus one extra re-read of the empty record (no visible change) and one wrong count', erasing(W, O), end(O), idle(O, { said: set(W), counted: set(O) }), [FORGET, CLEAR, mark(O), READ, COUNT, SAY]],
  ['R3', 'erasing: own-end at this tab\'s own erase, an erase heard: its own shows, the heard one dropped, never counted', erasing(W, Z), end(O), idle(O, { said: set(W) }), [FORGET, CLEAR, mark(O), SAY]],
  ['-', 'idle: own-failed with no erase under way: nothing', idle(W), FAILED, 'same', []],
  ['-', 'idle: own-start: erasing', idle(W), { type: 'own-start' }, erasing(W), []],
  ['-', 'erasing: a second own-start: nothing', erasing(W), { type: 'own-start' }, 'same', []],
  // Q3: no gate. An erase before the first read takes the held erase along as overtaken.
  ['Q3', 'loading, an erase held: own-start: erasing, the held erase overtaken', loading(W, Z), { type: 'own-start' }, erasing(W, Z), []],
  ['Q3', 'loading, nothing held: own-start: erasing, nothing overtaken', loading(W), { type: 'own-start' }, erasing(W), []],
  ['Q3', 'erasing (from loading): loaded is a no-op', erasing(W, Z), { type: 'loaded' }, 'same', []],
  // e: an arrival before the page has loaded is held, then read once.
  ['e', 'loading: an arrival is held, not counted', loading(W), { type: 'arrived', identity: X }, loading(W, X), []],
  ['e order', 'loading: a later report at the same epoch replaces the one held', loading(W, X), { type: 'arrived', identity: E }, loading(W, E), []],
  ['e order', 'loading: a report at a lower epoch keeps the higher', loading(W, Z), { type: 'arrived', identity: X }, loading(W, Z), []],
  ['e heard', 'loading: loaded with an arrival held: idle, still heard, read (the read shows and counts it)', loading(W, X), { type: 'loaded' }, idle(W, { heard: X }), [READ]],
  ['e heard', 'loading: loaded with an arrival held that the first read already showed: idle, still heard, read, no count', loading(X, X, { counted: set(X) }), { type: 'loaded' }, idle(X, { heard: X, counted: set(X) }), [READ]],
  ['e', 'loading: loaded, nothing held: idle', loading(W), { type: 'loaded' }, idle(W), []],
  ['e', 'idle: loaded again: nothing', idle(W), { type: 'loaded' }, 'same', []],
  // f: one alert per erase a refused save was asked under.
  ['f', 'idle: a refused save: said once', idle(W), { type: 'refused', askedUnder: W }, idle(W, { said: set(W) }), [ALERT]],
  ['f', 'idle: a refused save under an erase already said: no second alert', idle(X, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'idle: a save asked before this tab\'s erase, refused after it: no alert', idle(Y, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'loading: a refused save: said once', loading(W), { type: 'refused', askedUnder: W }, loading(W, null, { said: set(W) }), [ALERT]],
  // Q4: keyed on the erase the save was asked under, not the one the store holds when it refuses.
  ['Q4', 'idle: a save asked under W, then X and Z arrive and show, then it is refused: alerted once, W said (today: keyed on Z)', idle(Z, { counted: set(X, Z) }), { type: 'refused', askedUnder: W }, idle(Z, { said: set(W), counted: set(X, Z) }), [ALERT]],
  // 2b-1 R1: an own-end below the heard erase keeps it heard and reads it; that read shows and counts it.
  ['2b-1 R1', 'erasing, an erase heard at a HIGHER epoch than the end (a late reader): idle at the end, heard kept, read, not counted here', erasing(W, O), end(Z), idle(Z, { heard: O, said: set(W) }), [FORGET, CLEAR, mark(Z), READ, SAY]],
  ['2b-1 R1', 'erasing, an erase heard at the SAME epoch as the end: the end shows, the heard one dropped (as R3)', erasing(W, X), end(E), idle(E, { said: set(W) }), [FORGET, CLEAR, mark(E), SAY]],
  // 2b-1 R2 (Fable's corrected rule): an idle read clears heard only when it IS heard, or is above heard's epoch.
  ['2b-1 R2', 'idle: a read BELOW the heard erase\'s epoch: shown and counted, heard kept for a later read', idle(W, { heard: Z }), { type: 'read', identity: X }, idle(X, { heard: Z, counted: set(X) }), [CLEAR, mark(X), COUNT]],
  ['2b-1 R2', 'idle: a read of the erase shown, BELOW the heard erase\'s epoch: nothing, heard kept', idle(X, { heard: Z }), { type: 'read', identity: X }, 'same', []],
  ['2b-1 R2', 'idle: a read at the heard erase\'s epoch, a DIFFERENT identity: shown and counted, heard kept', idle(W, { heard: X }), { type: 'read', identity: E }, idle(E, { heard: X, counted: set(E) }), [CLEAR, mark(E), COUNT]],
  ['2b-1 R2', 'idle: a read of the heard erase itself: shown, heard cleared', idle(W, { heard: X }), { type: 'read', identity: X }, idle(X, { counted: set(X) }), [CLEAR, mark(X), COUNT]],
  ['2b-1 R2', 'idle: a read ABOVE the heard erase\'s epoch: shown, heard cleared', idle(W, { heard: X }), { type: 'read', identity: Z }, idle(Z, { counted: set(Z) }), [CLEAR, mark(Z), COUNT]],
  // 2b-1 Q3: a refused save while an erase is heard asks for the read (L1's end); it alerts only when news.
  ['2b-1 Q3', 'idle: refused under A, C heard, A already said: no alert, one read', idle(X, { heard: Z, said: set(X) }), { type: 'refused', askedUnder: X }, 'same', [READ]],
  ['2b-1 Q3', 'idle: refused under A, C heard, news: alerted, one read', idle(X, { heard: Z }), { type: 'refused', askedUnder: X }, idle(X, { heard: Z, said: set(X) }), [ALERT, READ]],
  ['2b-1 Q3', 'idle: refused under A, nothing heard, A already said: nothing', idle(X, { said: set(X) }), { type: 'refused', askedUnder: X }, 'same', []],
  ['2b-1 Q3', 'loading: refused, an erase held: alerted, one read', loading(W, X), { type: 'refused', askedUnder: W }, loading(W, X, { said: set(W) }), [ALERT, READ]],
  ['2b-1 Q3', 'erasing: refused, an erase heard: nothing (own-end or own-failed reads it)', erasing(W, Z), { type: 'refused', askedUnder: W }, 'same', []],
];

describe('erase machine: transition table (untangle fix 4, US-16 AC2a)', () => {
  it.each(rows)('(%s) %s', (_rule, _row, state, event, next, effects) => {
    const step = transition(state, event);
    if (next === 'same') expect(step.state).toBe(state);
    else expect(step.state).toEqual(next);
    expect(step.effects).toEqual(effects);
  });
});

/** Run events through transition from `state`, answering each read with `store`'s identity; the end state and every effect. */
function run(state: EraseState, events: EraseEvent[]) {
  const effects: EraseEffect[] = [];
  for (const event of events) {
    const step = transition(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}
const counts = (effects: EraseEffect[]) => effects.filter(e => e.type === 'count-remote-change').length;

describe('erase machine: one remote_change_applied per remote erase SHOWN, on every path (a, US-34 AC1)', () => {
  it.each<[string, EraseState, EraseEvent[], EraseState]>([
    ['arrival, then its read', idle(W), [{ type: 'arrived', identity: X }, { type: 'read', identity: X }], idle(X, { counted: set(X) })],
    ['a refused save\'s read first, then the late arrival and its read', idle(W),
      [{ type: 'refused', askedUnder: W }, { type: 'read', identity: X }, { type: 'arrived', identity: X }, { type: 'read', identity: X }],
      idle(X, { said: set(W), counted: set(X) })],
    ['held while loading, then loaded and its read', loading(W), [{ type: 'arrived', identity: X }, { type: 'loaded' }, { type: 'read', identity: X }], idle(X, { counted: set(X) })],
    ['held while loading, the first read shows it, then loaded and its read', loading(W),
      [{ type: 'arrived', identity: X }, { type: 'read', identity: X }, { type: 'loaded' }, { type: 'read', identity: X }], idle(X, { counted: set(X) })],
    ['overtaking this tab\'s erase, the erase ending there, then the read', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: Z }, end(Z), { type: 'read', identity: Z }], idle(Z, { said: set(W), counted: set(Z) })],
    ['overtaking this tab\'s erase, the erase refused, then the read (i)', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: Z }, FAILED, { type: 'read', identity: Z }], idle(Z, { counted: set(Z) })],
    ['held while loading, an erase pressed before the first read, ending at the held erase (Q3)', loading(W),
      [{ type: 'arrived', identity: Z }, { type: 'own-start' }, { type: 'loaded' }, end(Z), { type: 'read', identity: Z }],
      idle(Z, { said: set(W), counted: set(Z) })],
    ['two arrivals folded, A then B, before the read: B only, by design', idle(W),
      [{ type: 'arrived', identity: X }, { type: 'arrived', identity: Z }, { type: 'read', identity: Z }, { type: 'read', identity: Z }], idle(Z, { counted: set(Z) })],
    ['two overtaking arrivals, A then B, the erase ending at B: B only, by design', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: X }, { type: 'arrived', identity: Z }, end(Z), { type: 'read', identity: Z }],
      idle(Z, { said: set(W), counted: set(Z) })],
    ['H26: another writer\'s erase of an empty record arrives in idle, then its read (remote-change.test.ts pins the arrival)', idle(W),
      [{ type: 'arrived', identity: X }, { type: 'read', identity: X }], idle(X, { counted: set(X) })],
    ['2b-1 R1: this tab\'s erase ends below an erase heard during it, then that erase\'s read', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: O }, end(Z), { type: 'read', identity: O }], idle(O, { said: set(W), counted: set(O) })],
  ])('%s: counted once', (_path, start, events, last) => {
    const result = run(start, events);
    expect(result.state).toEqual(last);
    expect(counts(result.effects)).toBe(1);
  });

  it('this tab\'s own erase, and a read of it afterwards: never counted', () => {
    const result = run(idle(W), [{ type: 'own-start' }, end(Y), { type: 'read', identity: Y }]);
    expect(result.state).toEqual(idle(Y, { said: set(W) }));
    expect(counts(result.effects)).toBe(0);
  });
});

describe('erase machine: a remote erase heard in idle is never lost to this tab\'s erase (round 3, re-check F1)', () => {
  // Z arrives in idle and its read is in flight; this tab's erase starts; the read lands inside the erase and is dropped.
  const opening: EraseEvent[] = [{ type: 'arrived', identity: Z }, { type: 'own-start' }, { type: 'read', identity: Z }];

  it('R1: own-failed: ends with a read, and Z shown after it', () => {
    const failed = run(idle(W), [...opening, FAILED]);
    expect(failed.state).toEqual(idle(W, { heard: Z }));
    expect(failed.effects).toEqual([READ, READ, SAY_FAILED]);
    const shown = run(failed.state, [{ type: 'read', identity: Z }]);
    expect(shown.state).toEqual(idle(Z, { counted: set(Z) }));
    expect(shown.effects).toEqual([CLEAR, mark(Z), COUNT]);
  });
  it('R1: own-failed, and that read fails too: Z stays heard, and the next erase carries it', () => {
    const result = run(idle(W), [...opening, FAILED, { type: 'own-start' }]);
    expect(result.state).toEqual(erasing(W, Z));
  });
  it('R2: own-end with identity Z: read and counted, not forget-only', () => {
    const result = run(idle(W), [...opening, end(Z)]);
    expect(result.state).toEqual(idle(Z, { said: set(W), counted: set(Z) }));
    expect(result.effects).toEqual([READ, FORGET, CLEAR, mark(Z), READ, COUNT, SAY]);
  });
  it('R3: own-end with identity O: O shown, Z never counted, even when a read of O follows', () => {
    const result = run(idle(W), [...opening, end(O), { type: 'read', identity: O }]);
    expect(result.state).toEqual(idle(O, { said: set(W) }));
    expect(result.effects).toEqual([READ, FORGET, CLEAR, mark(O), SAY]);
  });
  it('R4: a read during the erase that reports this tab\'s own O changes nothing, and Z still waits', () => {
    const result = run(idle(W), [{ type: 'arrived', identity: Z }, { type: 'own-start' }, { type: 'read', identity: O }]);
    expect(result.state).toEqual(erasing(W, Z));
    expect(result.effects).toEqual([READ]);
  });
});

describe('erase machine: a lower-epoch read never loses a heard erase (2b-1 R2)', () => {
  it('two arrivals at one epoch: the first one\'s read lands, the second\'s fails; heard stays, and a refused save re-reads', () => {
    const arrivals = run(idle(W), [{ type: 'arrived', identity: Y }, { type: 'arrived', identity: X }]);
    expect(arrivals.effects).toEqual([READ, READ]); // READ#1, READ#2
    const first = run(arrivals.state, [{ type: 'read', identity: Y }]); // READ#1 lands at Y
    expect(first.state).toEqual(idle(Y, { heard: X, counted: set(Y) }));
    // READ#2 fails: no event. The screen shows Y, the store holds X: a save from it is refused.
    const refused = run(first.state, [{ type: 'refused', askedUnder: Y }]);
    expect(refused.effects).toEqual([ALERT, READ]);
    expect(refused.state).toEqual(idle(Y, { heard: X, said: set(Y), counted: set(Y) }));
  });
  it('Z heard, a read at X shows X; the later read at Z still shows Z and counts it', () => {
    const result = run(idle(W), [{ type: 'arrived', identity: Z }, { type: 'read', identity: X }, { type: 'read', identity: Z }]);
    expect(result.state).toEqual(idle(Z, { counted: set(X, Z) }));
    expect(result.effects).toEqual([READ, CLEAR, mark(X), COUNT, CLEAR, mark(Z), COUNT]);
  });
});

describe('erase machine: a refused save while an erase is heard cannot loop by itself (2b-1 Q3, Fable)', () => {
  // L1: the heard erase's read failed. A failed read dispatches no event, so nothing re-dispatches.
  it('one read per refused save, and nothing more when each read fails', () => {
    const start = idle(X, { heard: Z, said: set(X) });
    const result = run(start, [{ type: 'refused', askedUnder: X }, { type: 'refused', askedUnder: X }]);
    expect(result.effects).toEqual([READ, READ]);
    expect(result.state).toBe(start);
  });
  it('through the store: the read door fails and dispatches nothing; the refusal ran exactly one read', () => {
    const d = doors();
    const store = createEraseStore(X, d);
    store.dispatch({ type: 'loaded' });
    store.dispatch({ type: 'arrived', identity: Z }); // its read fails: no event follows
    expect(refusalIsNews(store, X)).toBe(true);
    expect(refusalIsNews(store, X)).toBe(false);
    expect(d.calls).toEqual(['read', 'read', 'read']); // the arrival's, then one per refusal
    expect(store.getSnapshot()).toEqual(idle(X, { heard: Z, said: set(X) }));
  });
  it('then the read that shows the heard erase ends it: a later refusal reads nothing', () => {
    const result = run(idle(X, { heard: Z, said: set(X) }), [{ type: 'read', identity: Z }, { type: 'refused', askedUnder: X }]);
    expect(result.state).toEqual(idle(Z, { said: set(X), counted: set(Z) }));
    expect(result.effects).toEqual([CLEAR, mark(Z), COUNT]);
  });
});

describe('erase machine: an erase pressed before the first read shows (Q3)', () => {
  it('nothing held: own-start, loaded mid-erase (no-op), own-end: its erase shows, as from idle', () => {
    const result = run(loading(W), [{ type: 'own-start' }, { type: 'loaded' }, end(Y)]);
    expect(result.state).toEqual(idle(Y, { said: set(W) }));
    expect(result.effects).toEqual([FORGET, CLEAR, mark(Y), SAY]);
  });
  it('nothing held: own-start, own-failed: idle at the old erase, the failure said; a later loaded is a no-op', () => {
    const result = run(loading(W), [{ type: 'own-start' }, FAILED, { type: 'loaded' }]);
    expect(result.state).toEqual(idle(W));
    expect(result.effects).toEqual([SAY_FAILED]);
  });
  it('an erase held: own-start, own-failed: the held erase is read, and the read shows and counts it', () => {
    const result = run(loading(W, Z), [{ type: 'own-start' }, FAILED, { type: 'read', identity: Z }]);
    expect(result.state).toEqual(idle(Z, { counted: set(Z) }));
    expect(result.effects).toEqual([READ, SAY_FAILED, CLEAR, mark(Z), COUNT]);
  });
  it('an erase held: own-start, own-end at this tab\'s own higher erase: its erase shows, the held one never counts', () => {
    const later = id(3, '2026-11-01T10:00:10.000Z');
    const result = run(loading(W, Z), [{ type: 'own-start' }, end(later)]);
    expect(result.state).toEqual(idle(later, { said: set(W) }));
    expect(result.effects).toEqual([FORGET, CLEAR, mark(later), SAY]);
  });
});

describe('erase machine: a refusal is keyed on the erase it was asked under (Q4, the one intended difference)', () => {
  it('asked under W, then X and Z arrive and show, then refused: one alert; a second save asked under X, refused: a second alert', () => {
    const result = run(idle(W), [
      { type: 'arrived', identity: X }, { type: 'read', identity: X },
      { type: 'arrived', identity: Z }, { type: 'read', identity: Z },
      { type: 'refused', askedUnder: W },
      { type: 'refused', askedUnder: W },
      { type: 'refused', askedUnder: X },
    ]);
    expect(result.state).toEqual(idle(Z, { said: set(W, X), counted: set(X, Z) }));
    expect(result.effects.filter(e => e.type === 'alert-refused')).toEqual([ALERT, ALERT]);
  });
});

describe('erase machine: two overlapping reads (pins the read event\'s contract, the 2b hook\'s, not 2a code)', () => {
  // Two erases at one epoch: the store moves from the first to the second while a read awaits.
  const [P, Q] = [X, E];
  /** A read as the contract has it: the record read under one identity, dispatched after the await only if the store still holds it. */
  function read(store: { identity: string }) {
    const under = store.identity;
    return (state: EraseState): EraseState => (store.identity === under ? transition(state, { type: 'read', identity: store.identity }).state : state);
  }

  it.each([['the later read lands first'], ['the earlier read lands first']])('%s: the screen ends at the store\'s identity', (order) => {
    const store = { identity: P };
    let state = idle(W);
    const slow = read(store); // started under P
    store.identity = Q; // another writer's erase is taken in; its arrival starts a second read
    state = transition(state, { type: 'arrived', identity: Q }).state;
    const fast = read(store);
    state = order === 'the later read lands first' ? slow(fast(state)) : fast(slow(state));
    expect(state.shown).toBe(store.identity);
  });

  it('why the contract: a stale identity dispatched last moves the screen back within an epoch', () => {
    const state = run(idle(W), [{ type: 'read', identity: Q }, { type: 'read', identity: P }]).state;
    expect(state.shown).toBe(P); // the store holds Q: every save would be refused
  });
});

describe('epochOf: the one order the machine keeps', () => {
  it.each([
    [W, 0], [X, 1], [Z, 2], [M, -1], ['[]', -1], ['["1", null]', -1], ['5', -1], ['null', -1], ['[null, null]', -1],
  ])('epochOf(%s) is %s', (identity, epoch) => {
    expect(epochOf(identity)).toBe(epoch);
  });
});

function doors(): EraseDoors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    markStore: (identity) => calls.push(`mark-store ${identity}`),
    clearDrafts: () => calls.push('clear-drafts'),
    forget: () => calls.push('forget'),
    read: () => calls.push('read'),
    countRemoteChange: () => calls.push('count-remote-change'),
    sayOutcome: (message) => calls.push(`say-outcome ${message}`),
  };
}

describe('createEraseStore: the state\'s only copy, and the one place effects run', () => {
  it('starts loading at the erase shown; subscribers hear a change, not a no-op; effects run in order', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    expect(store.getSnapshot()).toEqual(initialEraseState(W));
    expect(store.getSnapshot()).toEqual(loading(W));
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.dispatch({ type: 'loaded' });
    expect(heard).toHaveBeenCalledTimes(1);
    const before = store.getSnapshot();
    store.dispatch({ type: 'loaded' }); // a no-op: the same snapshot, nobody told
    expect(store.getSnapshot()).toBe(before);
    expect(heard).toHaveBeenCalledTimes(1);
    store.dispatch({ type: 'own-start' });
    expect(store.dispatch(end(Y))).toEqual([FORGET, CLEAR, mark(Y), SAY]);
    expect(d.calls).toEqual(['forget', 'clear-drafts', `mark-store ${Y}`, `say-outcome ${DONE}`]);
    expect(store.getSnapshot()).toEqual(idle(Y, { said: set(W) }));
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    store.dispatch({ type: 'read', identity: Z });
    expect(heard).toHaveBeenCalledTimes(3); // unsubscribed
    expect(store.getSnapshot().shown).toBe(Z);
  });

  it('a subscriber reads the new state before any effect runs', () => {
    const seen: string[] = [];
    const store = createEraseStore(W, { ...doors(), markStore: () => seen.push(`effect at ${store.getSnapshot().shown}`) });
    store.subscribe(() => seen.push(`told at ${store.getSnapshot().shown}`));
    store.dispatch({ type: 'read', identity: X });
    expect(seen).toEqual([`told at ${X}`, `effect at ${X}`]);
  });

  it.todo('PR 2b, after HealthTool.chat-profile.test.tsx:777 ("after an erase whose write failed, the screen shows the erased copy the store holds"): the hook sends own-end whenever the store\'s identity moved, whatever result.success says, and own-failed only when it did not (re-check F2)');
  it.todo('PR 2b: the hook\'s markStore door marks the store only in the layout effect of the commit that shows the identity (US-16 AC2d)');

  it('refusalIsNews (f, F4b): answers true once per erase asked under, false inside this tab\'s erase, and runs no door', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    store.dispatch({ type: 'loaded' });
    expect(refusalIsNews(store, W)).toBe(true);
    expect(refusalIsNews(store, W)).toBe(false);
    expect(d.calls).toEqual([]); // the caller says it
    store.dispatch({ type: 'read', identity: X });
    store.dispatch({ type: 'own-start' });
    expect(refusalIsNews(store, X)).toBe(false);
    expect(d.calls).toEqual(['clear-drafts', `mark-store ${X}`, 'count-remote-change']);
  });
});
