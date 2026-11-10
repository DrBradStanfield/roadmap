/**
 * The erase machine's table (untangle fix 4; US-16 AC2a, AC2d; US-11 AC6;
 * US-34 AC1, AC4): one row per (state, event), each naming the state that
 * follows and the effects, in order. Letters cite Fable's rulings (a-g).
 * Synthetic identities only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createEraseStore, initialEraseState, laterErase, refusalIsNews, transition,
  type EraseDoors, type EraseEffect, type EraseEvent, type EraseState,
} from './erase-machine';

const id = (epoch: number, at: string | null) => JSON.stringify([epoch, at]);
const W = id(0, null); // the record before any erase
const X = id(1, '2026-11-01T10:00:00.000Z'); // another writer's erase
const Y = id(1, '2026-11-01T10:00:05.000Z'); // this tab's erase, racing X at the same epoch, later
const Z = id(2, '2026-11-01T10:00:09.000Z'); // another writer's erase at a higher epoch

const set = (...ids: string[]) => new Set(ids);
type Extra = { said?: Set<string>; counted?: Set<string> };
const loading = (shown: string, held: string | null = null, x: Extra = {}): EraseState =>
  ({ phase: 'loading', held, shown, said: x.said ?? set(), counted: x.counted ?? set() });
const idle = (shown: string, x: Extra = {}): EraseState => ({ phase: 'idle', shown, said: x.said ?? set(), counted: x.counted ?? set() });
const erasing = (shown: string, overtaken: string | null = null, x: Extra = {}): EraseState =>
  ({ phase: 'erasing', overtaken, shown, said: x.said ?? set(), counted: x.counted ?? set() });

const COUNT: EraseEffect = { type: 'count-remote-change' };
const READ: EraseEffect = { type: 'read' };
const CLEAR: EraseEffect = { type: 'clear-drafts' };
const FORGET: EraseEffect = { type: 'forget' };
const SAY: EraseEffect = { type: 'say-outcome' };
const ALERT: EraseEffect = { type: 'alert-refused' };
const mark = (identity: string): EraseEffect => ({ type: 'mark-store', identity });

/** [rule, row, state, event, next state ('same': unchanged, the same object), effects] */
const rows: Array<[string, string, EraseState, EraseEvent, EraseState | 'same', EraseEffect[]]> = [
  // a, b: an arrival counts once per remote erase and always reads; the read shows it.
  ['a', 'idle: another writer\'s new erase arrives: counted, read, not yet shown', idle(W), { type: 'arrived', identity: X }, idle(W, { counted: set(X) }), [COUNT, READ]],
  ['b', 'idle: an arrival for the erase already shown (a read showed it), not yet counted: counted, read, no visible change', idle(X), { type: 'arrived', identity: X }, idle(X, { counted: set(X) }), [COUNT, READ]],
  ['a', 'idle: an arrival for an erase already counted: read only', idle(X, { counted: set(X) }), { type: 'arrived', identity: X }, 'same', [READ]],
  // c: a read shows a new erase, never counts, never alerts.
  ['c', 'idle: a read with a new erase: shown, drafts cleared, the store marked', idle(W), { type: 'read', identity: X }, idle(X), [CLEAR, mark(X)]],
  ['c', 'idle: a read with the erase shown: nothing', idle(X), { type: 'read', identity: X }, 'same', []],
  ['c', 'idle: a read with an older erase: nothing', idle(X), { type: 'read', identity: W }, 'same', []],
  ['c', 'erasing: a read loses to this tab\'s erase', erasing(W), { type: 'read', identity: Y }, 'same', []],
  ['c', 'loading: the first read shows its erase', loading(W), { type: 'read', identity: X }, loading(X), [CLEAR, mark(X)]],
  // d: two erases racing.
  ['d', 'erasing: another writer\'s erase arrives: counted, kept as overtaken, no read', erasing(W), { type: 'arrived', identity: Z }, erasing(W, Z, { counted: set(Z) }), [COUNT]],
  ['d', 'erasing: a second arrival keeps the later erase', erasing(W, Z, { counted: set(Z) }), { type: 'arrived', identity: X }, erasing(W, Z, { counted: set(Z, X) }), [COUNT]],
  ['d', 'erasing: a refused save is no news (no alert-refused for the own erase)', erasing(W), { type: 'refused', askedUnder: W }, 'same', []],
  // g: this tab's erase ends.
  ['g', 'erasing: own-end, nothing overtook it: its erase shown, the old record forgotten, the pre-erase erase said', erasing(W), { type: 'own-end', identity: Y }, idle(Y, { said: set(W) }), [FORGET, CLEAR, mark(Y), SAY]],
  ['d g', 'erasing: own-end for an erase no longer the newest: the higher epoch shows, and its rows are read', erasing(W, Z, { counted: set(Z) }), { type: 'own-end', identity: Y }, idle(Z, { said: set(W), counted: set(Z) }), [FORGET, CLEAR, mark(Z), READ, SAY]],
  ['d', 'erasing: own-end later than the erase kept (same epoch, later erasedAt): its own erase shows', erasing(W, X, { counted: set(X) }), { type: 'own-end', identity: Y }, idle(Y, { said: set(W), counted: set(X) }), [FORGET, CLEAR, mark(Y), SAY]],
  ['g', 'idle: an own-end with no erase under way: nothing (the newer one stays shown)', idle(Z), { type: 'own-end', identity: Y }, 'same', []],
  ['-', 'erasing: own-failed, nothing overtook it: back to idle, the failure said', erasing(W), { type: 'own-failed' }, idle(W), [SAY]],
  ['d', 'erasing: own-failed, another writer\'s erase overtook it: that erase shows and is read', erasing(W, Z, { counted: set(Z) }), { type: 'own-failed' }, idle(Z, { said: set(W), counted: set(Z) }), [FORGET, CLEAR, mark(Z), READ, SAY]],
  ['-', 'idle: own-failed with no erase under way: nothing', idle(W), { type: 'own-failed' }, 'same', []],
  ['-', 'idle: own-start: erasing', idle(W), { type: 'own-start' }, erasing(W), []],
  ['-', 'erasing: a second own-start: nothing', erasing(W), { type: 'own-start' }, 'same', []],
  ['-', 'loading: own-start: nothing (open question: an erase before the first read)', loading(W), { type: 'own-start' }, 'same', []],
  // e: an arrival before the page has loaded is held, then shown once.
  ['e', 'loading: an arrival is held, not counted', loading(W), { type: 'arrived', identity: X }, loading(W, X), []],
  ['e', 'loading: a second arrival keeps the later erase', loading(W, Z), { type: 'arrived', identity: X }, loading(W, Z), []],
  ['e', 'loading: loaded with an arrival held: counted and read', loading(W, X), { type: 'loaded' }, idle(W, { counted: set(X) }), [COUNT, READ]],
  ['e', 'loading: loaded with an arrival held that the first read already showed: counted and read, no visible change', loading(X, X), { type: 'loaded' }, idle(X, { counted: set(X) }), [COUNT, READ]],
  ['e', 'loading: loaded, nothing held: idle', loading(W), { type: 'loaded' }, idle(W), []],
  ['e', 'idle: loaded again: nothing', idle(W), { type: 'loaded' }, 'same', []],
  // f: one alert per erase a refused save was asked under.
  ['f', 'idle: a refused save: said once', idle(W), { type: 'refused', askedUnder: W }, idle(W, { said: set(W) }), [ALERT]],
  ['f', 'idle: a refused save under an erase already said: no second alert', idle(X, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'idle: a save asked before this tab\'s erase, refused after it: no alert', idle(Y, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'loading: a refused save: said once', loading(W), { type: 'refused', askedUnder: W }, loading(W, null, { said: set(W) }), [ALERT]],
];

describe('erase machine: transition table (untangle fix 4, US-16 AC2a)', () => {
  it.each(rows)('(%s) %s', (_rule, _row, state, event, next, effects) => {
    const step = transition(state, event);
    if (next === 'same') expect(step.state).toBe(state);
    else expect(step.state).toEqual(next);
    expect(step.effects).toEqual(effects);
  });
});

/** Run events through transition from `state`; answer the end state and every effect. */
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

describe('erase machine: one remote_change_applied per remote erase, whichever path shows it first (a, US-34 AC1)', () => {
  it('arrival first, then its read: counted once, shown once', () => {
    const end = run(idle(W), [{ type: 'arrived', identity: X }, { type: 'read', identity: X }]);
    expect(end.state).toEqual(idle(X, { counted: set(X) }));
    expect(end.effects).toEqual([COUNT, READ, CLEAR, mark(X)]);
  });
  it('a refused save\'s read first, then the late arrival: counted once, shown once, the arrival changes nothing visible', () => {
    const end = run(idle(W), [{ type: 'refused', askedUnder: W }, { type: 'read', identity: X }, { type: 'arrived', identity: X }, { type: 'read', identity: X }]);
    expect(end.state).toEqual(idle(X, { said: set(W), counted: set(X) }));
    expect(end.effects).toEqual([ALERT, CLEAR, mark(X), COUNT, READ]);
    expect(counts(end.effects)).toBe(1);
  });
  it('held while loading, the first read shows it, then loaded: counted once', () => {
    const end = run(loading(W), [{ type: 'arrived', identity: X }, { type: 'read', identity: X }, { type: 'loaded' }, { type: 'read', identity: X }]);
    expect(end.state).toEqual(idle(X, { counted: set(X) }));
    expect(counts(end.effects)).toBe(1);
  });
});

describe('laterErase: the later of two erase identities, as the merge picks', () => {
  it.each([
    [Z, Y, true], [Y, Z, false], // a higher epoch wins
    [Y, X, true], [X, Y, false], // one epoch: the later erasedAt
    [X, X, false], [X, W, true], [W, X, false],
  ])('laterErase(%s, %s) is %s', (a, b, later) => {
    expect(laterErase(a, b)).toBe(later);
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
    alertRefused: () => calls.push('alert-refused'),
    sayOutcome: () => calls.push('say-outcome'),
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
    expect(store.dispatch({ type: 'own-end', identity: Y })).toEqual([FORGET, CLEAR, mark(Y), SAY]);
    expect(d.calls).toEqual(['forget', 'clear-drafts', `mark-store ${Y}`, 'say-outcome']);
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

  it('refusalIsNews (f): true and alerted once per erase asked under, false inside this tab\'s erase', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    store.dispatch({ type: 'loaded' });
    expect(refusalIsNews(store, W)).toBe(true);
    expect(refusalIsNews(store, W)).toBe(false);
    expect(d.calls).toEqual(['alert-refused']);
    store.dispatch({ type: 'read', identity: X });
    store.dispatch({ type: 'own-start' });
    expect(refusalIsNews(store, X)).toBe(false);
    expect(d.calls).toEqual(['alert-refused', 'clear-drafts', `mark-store ${X}`]);
  });
});
