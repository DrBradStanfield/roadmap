// Lead A1 (b): the record session's save mode as one union (US-10 AC5, AC5a;
// US-11 AC7; US-16 AC2a; US-34). The table covers every state x event pair.
import { describe, expect, it } from 'vitest';
import {
  debounceArmed, saveStatus, transition, unsaved, writePending,
  type SaveBase, type SaveEffect, type SaveEvent, type SaveState,
} from './save-state';

const clean = (changes: number): SaveBase => ({ mode: 'clean', changes });
const waiting = (changes: number, saved: number): SaveBase => ({ mode: 'waiting', changes, saved });
const saving = (changes: number, saved: number, from: number, armed = false): SaveBase => ({ mode: 'saving', changes, saved, from, armed });
const failed = (changes: number, saved: number): SaveBase => ({ mode: 'failed', changes, saved });
const held = (changes: number, saved: number): SaveBase => ({ mode: 'held', changes, saved });
const erasing = (under: SaveBase): SaveState => ({ mode: 'erasing', under });

const ARM: SaveEffect = { type: 'arm' };
const CANCEL: SaveEffect = { type: 'cancel' };
const pass = (from: number): SaveEffect => ({ type: 'pass', from });

const EVENTS: Record<string, SaveEvent> = {
  edited: { type: 'edited' },
  save: { type: 'save' },
  landed: { type: 'passLanded', from: 6 },
  failed: { type: 'passFailed' },
  synced: { type: 'synced' },
  hold: { type: 'hold' },
  eraseStarted: { type: 'eraseStarted' },
  eraseEnded: { type: 'eraseEnded' },
};
type Row = [SaveState, SaveEffect[]];
const same = (s: SaveState): Row => [s, []];

const STATES: Record<string, SaveState> = {
  clean: clean(5),
  waiting: waiting(6, 5),
  saving: saving(6, 4, 6),
  savingArmed: saving(7, 4, 6, true),
  failed: failed(6, 4),
  held: held(6, 4),
  erasingSaving: erasing(saving(7, 4, 6)),
  erasingHeld: erasing(held(7, 6)),
  erasingClean: erasing(clean(7)),
  erasingFailed: erasing(failed(7, 4)),
};

// state -> event -> [next state, effects asked for]
const TABLE: Record<string, Record<string, Row>> = {
  clean: {
    edited: [waiting(6, 5), [ARM]], save: same(clean(5)), landed: same(clean(5)), failed: same(clean(5)),
    synced: same(clean(5)), hold: same(clean(5)), eraseStarted: [erasing(held(6, 5)), []], eraseEnded: same(clean(5)),
  },
  waiting: {
    edited: [waiting(7, 5), [ARM]], save: [saving(6, 5, 6), [CANCEL, pass(6)]],
    landed: same(waiting(6, 5)), failed: same(waiting(6, 5)),
    synced: [clean(6), [CANCEL]], hold: [held(6, 5), [CANCEL]],
    eraseStarted: [erasing(held(7, 5)), [CANCEL]], eraseEnded: same(waiting(6, 5)),
  },
  saving: {
    edited: [saving(7, 4, 6, true), [ARM]], save: same(saving(6, 4, 6)), // joins, never a second pass
    landed: [clean(6), []], failed: [failed(6, 4), []],
    synced: [saving(6, 6, 6), []], hold: same(saving(6, 4, 6)),
    eraseStarted: [erasing(saving(7, 4, 6)), []], eraseEnded: same(saving(6, 4, 6)),
  },
  savingArmed: {
    edited: [saving(8, 4, 6, true), [ARM]], save: [saving(7, 4, 6), [CANCEL]],
    // An edit during the pass: saved moves only to where the pass started, and another pass runs.
    landed: [saving(7, 6, 7, true), [pass(7)]],
    // The re-armed debounce outlives a failed pass, and retries it (as today).
    failed: [waiting(7, 4), []],
    synced: [saving(7, 7, 6), [CANCEL]], hold: [saving(7, 4, 6), [CANCEL]],
    eraseStarted: [erasing(saving(8, 4, 6)), [CANCEL]], eraseEnded: same(saving(7, 4, 6, true)),
  },
  failed: {
    edited: [waiting(7, 4), [ARM]], save: [saving(6, 4, 6), [pass(6)]],
    landed: same(failed(6, 4)), failed: same(failed(6, 4)),
    synced: [clean(6), []], hold: same(failed(6, 4)),
    eraseStarted: [erasing(held(7, 4)), []], eraseEnded: same(failed(6, 4)),
  },
  held: {
    edited: [waiting(7, 4), [ARM]], save: [saving(6, 4, 6), [pass(6)]],
    landed: same(held(6, 4)), failed: same(held(6, 4)),
    synced: [clean(6), []], hold: same(held(6, 4)),
    eraseStarted: [erasing(held(7, 4)), []], eraseEnded: same(held(6, 4)),
  },
  erasingSaving: {
    edited: same(erasing(saving(7, 4, 6))), // refused: refuses() answers the caller
    save: same(erasing(saving(7, 4, 6))),
    landed: [erasing(saving(7, 6, 7)), [pass(7)]], // the erased copy still to write
    failed: [erasing(failed(7, 4)), []],
    synced: [erasing(saving(7, 7, 6)), []], hold: same(erasing(saving(7, 4, 6))),
    eraseStarted: [erasing(saving(8, 4, 6)), []],
    eraseEnded: [saving(7, 4, 6), []], // a synchronous erase write beside a pass still running
  },
  erasingHeld: {
    edited: same(erasing(held(7, 6))), save: [erasing(saving(7, 6, 7)), [pass(7)]],
    landed: same(erasing(held(7, 6))), failed: same(erasing(held(7, 6))),
    synced: [erasing(clean(7)), []], hold: same(erasing(held(7, 6))),
    eraseStarted: [erasing(held(8, 6)), []], eraseEnded: [held(7, 6), []],
  },
  erasingClean: {
    edited: same(erasing(clean(7))), save: same(erasing(clean(7))),
    landed: same(erasing(clean(7))), failed: same(erasing(clean(7))),
    synced: same(erasing(clean(7))), hold: same(erasing(clean(7))),
    eraseStarted: [erasing(held(8, 7)), []], eraseEnded: [clean(7), []],
  },
  erasingFailed: {
    edited: same(erasing(failed(7, 4))), save: [erasing(saving(7, 4, 7)), [pass(7)]],
    landed: same(erasing(failed(7, 4))), failed: same(erasing(failed(7, 4))),
    synced: [erasing(clean(7)), []], hold: same(erasing(failed(7, 4))),
    eraseStarted: [erasing(held(8, 4)), []],
    eraseEnded: [failed(7, 4), []], // an erase whose write rejected never stays erasing
  },
};

const run = (start: SaveState, events: SaveEvent[]) => {
  let state = start;
  const effects: SaveEffect[] = [];
  for (const e of events) {
    const step = transition(state, e);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
};

describe('save-state transition table (A1)', () => {
  it('covers every state x event pair', () => {
    for (const name of Object.keys(STATES)) expect(Object.keys(TABLE[name]).sort()).toEqual(Object.keys(EVENTS).sort());
  });
  for (const [name, state] of Object.entries(STATES)) {
    for (const [ev, event] of Object.entries(EVENTS)) {
      it(`${name} + ${ev}`, () => {
        const [next, effects] = TABLE[name][ev];
        expect(transition(state, event)).toEqual({ state: next, effects });
      });
    }
  }

  it('edge rows: a leftover debounce over nothing unsaved, a stale pass report, a failed pass after a sync landed', () => {
    expect(transition(waiting(5, 5), EVENTS.save)).toEqual({ state: clean(5), effects: [CANCEL] });
    expect(transition(waiting(5, 5), EVENTS.hold)).toEqual({ state: clean(5), effects: [CANCEL] });
    expect(transition(saving(6, 4, 6), { type: 'passLanded', from: 5 })).toEqual({ state: saving(6, 4, 6), effects: [] });
    expect(transition(saving(6, 6, 6), EVENTS.failed)).toEqual({ state: clean(6), effects: [] });
    // a pass landing under an armed debounce leaves it armed, over nothing unsaved
    expect(transition(saving(6, 4, 6, true), EVENTS.landed)).toEqual({ state: waiting(6, 6), effects: [] });
  });
});

describe('derived answers', () => {
  const rows: [string, SaveState, boolean, boolean, boolean, string][] = [
    // name, state, unsaved, writePending, debounceArmed, status
    ['clean', clean(5), false, false, false, 'saved'],
    ['waiting', waiting(6, 5), true, true, true, 'saving'],
    ['waiting over nothing', waiting(5, 5), false, true, true, 'saved'],
    ['saving', saving(6, 4, 6), true, true, false, 'saving'],
    ['saving armed', saving(7, 4, 6, true), true, true, true, 'saving'],
    // US-34: a failed save never stops the re-read.
    ['failed', failed(6, 4), true, false, false, 'not-saved'],
    ['held', held(6, 4), true, false, false, 'not-saved'],
    ['erasing over saving', erasing(saving(7, 4, 6)), true, true, false, 'saving'],
    ['erasing over clean', erasing(clean(7)), false, false, false, 'saved'],
    ['erasing over failed', erasing(failed(7, 4)), true, false, false, 'not-saved'],
  ];
  for (const [name, s, u, w, a, status] of rows) {
    it(name, () => {
      expect([unsaved(s), writePending(s), debounceArmed(s), saveStatus(s)]).toEqual([u, w, a, status]);
    });
  }
});

describe('any order is safe where two events race', () => {
  const settle = (s: SaveState) => {
    // Run the session's side: land the pass running, fire the debounce, land every pass asked for.
    for (let i = 0; i < 10; i += 1) {
      let from: number;
      if (s.mode === 'saving') from = s.from;
      else {
        const step = transition(s, { type: 'save' });
        const p = step.effects.find((e) => e.type === 'pass');
        s = step.state;
        if (!p) return s;
        from = (p as { from: number }).from;
      }
      for (;;) {
        const landed = transition(s, { type: 'passLanded', from });
        s = landed.state;
        const next = landed.effects.find((e) => e.type === 'pass');
        if (!next) break;
        from = (next as { from: number }).from;
      }
    }
    return s;
  };

  it('a pass landing vs an edit: the edit is saved either way', () => {
    const a = run(saving(6, 4, 6), [EVENTS.edited, EVENTS.landed]);
    const b = run(saving(6, 4, 6), [EVENTS.landed, EVENTS.edited]);
    expect(a.effects).toEqual([ARM, pass(7)]);
    expect(b.effects).toEqual([ARM]);
    expect(settle(a.state)).toEqual(clean(7));
    expect(settle(b.state)).toEqual(clean(7));
  });

  it('a synchronous write during a pass vs the pass landing', () => {
    const a = run(saving(7, 4, 6, true), [EVENTS.synced, EVENTS.landed]);
    const b = run(saving(7, 4, 6, true), [EVENTS.landed, EVENTS.synced]);
    // saved moves back to where the pass started, and one more pass carries change 7 (as today)
    expect(a.state).toEqual(saving(7, 6, 7));
    expect(b.state).toEqual(saving(7, 7, 7));
    expect(settle(a.state)).toEqual(clean(7));
    expect(settle(b.state)).toEqual(clean(7));
  });

  it('an erase during a pass: the erased copy is written by a pass before the erase ends', () => {
    const a = run(saving(6, 4, 6), [EVENTS.eraseStarted, EVENTS.save, EVENTS.landed]);
    expect(a).toEqual({ state: erasing(saving(7, 6, 7)), effects: [pass(7)] });
    const b = run(saving(6, 4, 6), [EVENTS.landed, EVENTS.eraseStarted, EVENTS.save]);
    expect(b).toEqual({ state: erasing(saving(7, 6, 7)), effects: [pass(7)] });
    expect(run(a.state, [{ type: 'passLanded', from: 7 }, EVENTS.eraseEnded]).state).toEqual(clean(7));
  });

  it('an erase whose write rejects leaves erasing for failed, and its change stays unsaved', () => {
    const r = run(waiting(6, 5), [EVENTS.hold, EVENTS.eraseStarted, EVENTS.save, EVENTS.failed, EVENTS.eraseEnded]);
    expect(r).toEqual({ state: failed(7, 5), effects: [CANCEL, pass(7)] });
    expect(unsaved(r.state)).toBe(true);
  });

  it('the debounce firing during a pass joins it: no second pass', () => {
    const a = run(saving(7, 4, 6, true), [EVENTS.save, EVENTS.landed]);
    const b = run(saving(7, 4, 6, true), [EVENTS.landed, EVENTS.save]);
    expect(a.effects.filter((e) => e.type === 'pass')).toEqual([pass(7)]);
    expect(b.effects.filter((e) => e.type === 'pass')).toEqual([pass(7)]);
    expect(a.state).toEqual(saving(7, 6, 7));
    expect(b.state).toEqual(saving(7, 6, 7));
  });
});
