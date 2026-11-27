/**
 * US-34 AC4 — a remote change that lands on a dirty form is HELD, not dropped.
 *
 * HealthTool has no test harness, so the decision this makes lives here as a
 * pure relay and the component only wires it up.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRemoteChangeRelay, transition, type HoldEvent, type HoldRead, type HoldState } from './remote-replay';

/** A relay whose page has shown its first read. */
const ready = <T,>(apply: (remote: boolean) => T) => { const relay = createRemoteChangeRelay(apply); relay.loaded(); return relay; };

describe('US-34 AC4 — createRemoteChangeRelay', () => {
  it('applies a change that arrives on a clean form', () => {
    const apply = vi.fn();
    ready(apply).arrived('free');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('holds a change that arrives mid-typing, and replays it once the edit is saved', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived('typing');
    expect(apply).not.toHaveBeenCalled();

    relay.settled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('replays a held change once, however many saves follow', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived('typing');
    relay.settled();
    relay.settled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a save when no change was held', () => {
    const apply = vi.fn();
    ready(apply).settled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('collapses several changes held during one edit into a single replay', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived('typing');
    relay.arrived('typing');
    relay.settled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('US-11 AC6: a held change, then one applied at once (an erase from another device), applies once; the save after finds nothing held', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived('typing');
    relay.arrived('free');
    relay.settled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('survey R8: a re-read the page makes for itself while a change is held takes it in, once; the save after finds nothing held', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = ready(apply);

    relay.arrived('typing');
    expect(relay.reread()).toBe(true);
    relay.settled();
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('survey R8: a re-read with nothing held takes in no remote change', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = ready(apply);

    expect(relay.reread()).toBe(false);
    relay.settled();
    expect(apply.mock.calls).toEqual([[false]]);
  });

  it('survey R2: a change arriving before the page has shown its first read waits, then applies once when it has, whatever the form', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.arrived('free');
    relay.settled();
    expect(apply).not.toHaveBeenCalled();
    relay.loaded();
    relay.loaded();
    relay.settled();
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('US-34 AC4 (PR 1155 review F2): a re-read the page makes before its first read is shown keeps the waiting change for that read: it applies once the read is shown, counted once', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = createRemoteChangeRelay(apply);

    relay.arrived('free');
    expect(relay.reread()).toBe(false); // the first read, still to come, would overwrite what this shows
    relay.loaded();
    relay.settled();
    expect(apply.mock.calls).toEqual([[false], [true]]);
  });

  it('survey R2: with no change before it, showing the first read applies nothing, and a later change applies at once', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.loaded();
    expect(apply).not.toHaveBeenCalled();
    relay.arrived('free');
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('US-34 AC9 (H15): `holding` is true only while a change waits for the next profile save, never while loading', () => {
    const relay = createRemoteChangeRelay(vi.fn());
    const seen: boolean[] = [relay.holding()]; // loading
    relay.arrived('typing'); seen.push(relay.holding()); // loading-held
    relay.loaded(); seen.push(relay.holding()); // idle (the waiting change applied)
    relay.arrived('typing'); seen.push(relay.holding()); // held
    relay.settled(); seen.push(relay.holding()); // idle
    relay.arrived('typing'); relay.reread(); seen.push(relay.holding()); // a re-read ends it
    relay.arrived('typing'); relay.shows(); seen.push(relay.holding()); // so does the erase machine's read
    expect(seen).toEqual([false, false, false, true, false, false, false]);
  });

  it('fix 4 2b-3: the erase machine\'s read (`shows`) ends a hold and counts nothing; the save that cleans the form reads nothing more', () => {
    const apply = vi.fn();
    const relay = ready(apply);
    relay.arrived('typing');
    relay.shows();
    expect(apply.mock.calls).toEqual([[false]]);
    relay.settled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('fix 4 2b-3: before the first read is shown, `shows` ends a wait but the relay stays loading: loaded reads nothing more, a later change still waits', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);
    relay.arrived('free'); // loading-held
    relay.shows();
    relay.loaded();
    expect(apply.mock.calls).toEqual([[false]]);
    const early = vi.fn();
    const other = createRemoteChangeRelay(early);
    other.shows();
    other.arrived('free');
    expect(early.mock.calls).toEqual([[false]]); // the change waits for the first read
    other.loaded();
    expect(early.mock.calls).toEqual([[false], [true]]);
  });

  // fix 4 2b-3 R1/F2: the late echo of the erase the screen shows is a remote change that counts nothing.
  // apply(remote, counts): remote clears the answer mark (US-62 AC13); counts fires remote_change_applied.
  type Relay = ReturnType<typeof createRemoteChangeRelay<void>>;
  it.each<[string, boolean, (relay: Relay) => void, unknown[][]]>([
    ['a held echo waits, then the save that cleans the form applies it: clears, counts nothing', true,
      r => { r.arrived('typing', false); r.settled(); }, [[true, false]]],
    ['a clean echo applies at once: clears, counts nothing', true, r => { r.arrived('free', false); }, [[true, false]]],
    ['an echo held with a plain change: one read, counted once', true, r => { r.arrived('typing', false); r.arrived('typing'); r.settled(); }, [[true]]],
    ['a plain change held, then an echo: one read, counted once', true, r => { r.arrived('typing'); r.arrived('typing', false); r.settled(); }, [[true]]],
    ['a held echo ended by a reread (an upload, a \'left\' re-read): clears, counts nothing', true,
      r => { r.arrived('typing', false); r.reread(); }, [[true, false]]],
    ['a loading-held echo ended by loaded: clears, counts nothing', false, r => { r.arrived('free', false); r.loaded(); }, [[true, false]]],
    ['a held echo ended by saved: clears, counts nothing; a second save reads nothing', true,
      r => { r.arrived('typing', false); r.settled(); r.settled(); }, [[true, false]]],
    ['a reread with nothing held: neither', true, r => { r.reread(); }, [[false]]],
  ])('F2: %s', (_name, loaded, steps, calls) => {
    const apply = vi.fn();
    const relay = loaded ? ready(apply) : createRemoteChangeRelay(apply);
    steps(relay);
    expect(apply.mock.calls).toEqual(calls);
  });
});

// US-34 AC4 (R13 PR 1): the hold is one state, changed only through `transition`. Every state crossed
// with every event names the state that follows and the read it asks for (- for none).
const STATES: Record<string, HoldState> = {
  loading: { phase: 'loading' },
  'loading-held+': { phase: 'loading-held', counts: true },
  'loading-held-': { phase: 'loading-held', counts: false },
  idle: { phase: 'idle' },
  'held+': { phase: 'held', counts: true },
  'held-': { phase: 'held', counts: false },
};
const EVENTS: Record<string, HoldEvent> = {
  'arrived typing': { type: 'arrived', form: 'typing', counts: true },
  'arrived free': { type: 'arrived', form: 'free', counts: true },
  'echo typing': { type: 'arrived', form: 'typing', counts: false },
  'echo free': { type: 'arrived', form: 'free', counts: false },
  loaded: { type: 'loaded' },
  settled: { type: 'settled' },
  reread: { type: 'reread' },
  shows: { type: 'shows' },
};
type Row = [state: string, event: string, next: string, read: HoldRead | '-'];
const TABLE: Row[] = [
  ['loading', 'arrived typing', 'loading-held+', '-'],
  ['loading', 'arrived free', 'loading-held+', '-'],
  ['loading', 'echo typing', 'loading-held-', '-'],
  ['loading', 'echo free', 'loading-held-', '-'],
  ['loading', 'loaded', 'idle', '-'],
  ['loading', 'settled', 'loading', '-'], // early save: nothing held yet
  ['loading', 'reread', 'loading', 'own'],
  ['loading', 'shows', 'loading', 'own'],
  ['loading-held+', 'arrived typing', 'loading-held+', '-'],
  ['loading-held+', 'arrived free', 'loading-held+', '-'],
  ['loading-held+', 'echo typing', 'loading-held+', '-'], // a counting change waits beside the echo
  ['loading-held+', 'echo free', 'loading-held+', '-'],
  ['loading-held+', 'loaded', 'idle', 'remote'],
  ['loading-held+', 'settled', 'loading-held+', '-'], // out of order: a save before the first read keeps the wait
  ['loading-held+', 'reread', 'loading-held+', 'own'], // the first read, still to come, takes the change in
  ['loading-held+', 'shows', 'loading', 'own'],
  ['loading-held-', 'arrived typing', 'loading-held+', '-'],
  ['loading-held-', 'arrived free', 'loading-held+', '-'],
  ['loading-held-', 'echo typing', 'loading-held-', '-'],
  ['loading-held-', 'echo free', 'loading-held-', '-'],
  ['loading-held-', 'loaded', 'idle', 'uncounted'],
  ['loading-held-', 'settled', 'loading-held-', '-'],
  ['loading-held-', 'reread', 'loading-held-', 'own'],
  ['loading-held-', 'shows', 'loading', 'own'],
  ['idle', 'arrived typing', 'held+', '-'],
  ['idle', 'arrived free', 'idle', 'remote'],
  ['idle', 'echo typing', 'held-', '-'],
  ['idle', 'echo free', 'idle', 'uncounted'],
  ['idle', 'loaded', 'idle', '-'], // late: a second first-read signal reads nothing
  ['idle', 'settled', 'idle', '-'], // late: a second save reads nothing
  ['idle', 'reread', 'idle', 'own'],
  ['idle', 'shows', 'idle', 'own'],
  ['held+', 'arrived typing', 'held+', '-'],
  ['held+', 'arrived free', 'idle', 'remote'],
  ['held+', 'echo typing', 'held+', '-'],
  ['held+', 'echo free', 'idle', 'remote'], // one read, counted once
  ['held+', 'loaded', 'held+', '-'], // late: the first read was shown long ago
  ['held+', 'settled', 'idle', 'remote'],
  ['held+', 'reread', 'idle', 'remote'],
  ['held+', 'shows', 'idle', 'own'], // the erase machine counts its own read
  ['held-', 'arrived typing', 'held+', '-'],
  ['held-', 'arrived free', 'idle', 'remote'],
  ['held-', 'echo typing', 'held-', '-'],
  ['held-', 'echo free', 'idle', 'uncounted'],
  ['held-', 'loaded', 'held-', '-'],
  ['held-', 'settled', 'idle', 'uncounted'],
  ['held-', 'reread', 'idle', 'uncounted'],
  ['held-', 'shows', 'idle', 'own'],
];

describe('US-34 AC4 — the hold transition table', () => {
  it('has one row for every state crossed with every event', () => {
    const pairs = TABLE.map(([state, event]) => `${state} x ${event}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs.length).toBe(Object.keys(STATES).length * Object.keys(EVENTS).length);
  });

  it.each(TABLE)('%s + %s -> %s, read %s', (state, event, next, read) => {
    expect(transition(STATES[state], EVENTS[event])).toEqual({ state: STATES[next], read: read === '-' ? null : read });
  });

  // Late and out-of-order sequences from a fresh page (loading), folded through the transition alone.
  it.each<[string, string[], string, (HoldRead | '-')[]]>([
    ['a change before the first read, a save, then the read shown: applies once, at the read',
      ['arrived free', 'settled', 'loaded', 'settled'], 'idle', ['-', '-', 'remote', '-']],
    ['the first-read signal twice: the second reads nothing', ['loaded', 'loaded'], 'idle', ['-', '-']],
    ['a hold, then the erase machine\'s read, then the late save: the save reads nothing',
      ['loaded', 'arrived typing', 'shows', 'settled'], 'idle', ['-', '-', 'own', '-']],
    ['the erase machine\'s read before the first read: still loading, so a later change waits',
      ['shows', 'arrived free', 'loaded'], 'idle', ['own', '-', 'remote']],
    ['an echo held, then a counting change: one read at the save, counted',
      ['loaded', 'echo typing', 'arrived typing', 'settled'], 'idle', ['-', '-', '-', 'remote']],
    // US-34 AC8 (H14): `settled` fires on a save that landed or had a value refused, so a refused value never ends the hold for good.
    ['AC8: a refused value left in the form: each change held behind an edit, each save that settles ends its hold, once',
      ['loaded', 'arrived typing', 'settled', 'arrived typing', 'settled', 'settled'], 'idle', ['-', '-', 'remote', '-', 'remote', '-']],
    ['AC8: a re-read ends the hold, then the save settles late: it reads nothing',
      ['loaded', 'arrived typing', 'reread', 'settled'], 'idle', ['-', '-', 'remote', '-']],
    ['AC8 out of order: the save settles, then a change arrives while an edit is still to save: held for the next save',
      ['loaded', 'settled', 'arrived typing'], 'held+', ['-', '-', '-']],
  ])('%s', (_name, events, last, reads) => {
    let state = STATES.loading;
    const seen: (HoldRead | '-')[] = [];
    for (const name of events) {
      const step = transition(state, EVENTS[name]);
      state = step.state;
      seen.push(step.read ?? '-');
    }
    expect(seen).toEqual(reads);
    expect(state).toEqual(STATES[last]);
  });
});
