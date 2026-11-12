// Lead A1 (b): the record session's save mode as one union (US-10 AC5, AC5a;
// US-11 AC7; US-16 AC2a; US-34). Lead A6: the erase owns one mode, `erasing`,
// from its confirm (reading) through its write (writing). The table covers
// every sample state x event pair.
import { describe, expect, it } from 'vitest';
import {
  debounceArmed, saveStatus, transition, unsaved, writePending,
  type SaveBase, type SaveEffect, type SaveEvent, type SaveState,
} from './save-state';

const clean = (changes: number): SaveBase => ({ mode: 'clean', changes });
const waiting = (changes: number, saved: number): SaveBase => ({ mode: 'waiting', changes, saved });
const saving = (changes: number, saved: number, from: number, armed = false): SaveBase => ({ mode: 'saving', changes, saved, from, armed });
const failed = (changes: number, saved: number, mirrored = false): SaveBase => ({ mode: 'failed', changes, saved, mirrored });
const reading = (under: SaveBase): SaveState => ({ mode: 'erasing', phase: 'reading', under });
const writing = (under: SaveBase): SaveState => ({ mode: 'erasing', phase: 'writing', under });

const ARM: SaveEffect = { type: 'arm' };
const CANCEL: SaveEffect = { type: 'cancel' };
const pass = (from: number): SaveEffect => ({ type: 'pass', from });

const EVENTS: Record<string, SaveEvent> = {
  edited: { type: 'edited' },
  save: { type: 'save' },
  landed: { type: 'passLanded', from: 6 },
  failed: { type: 'passFailed' },
  synced: { type: 'synced' },
  began: { type: 'eraseBegan' },
  swapped: { type: 'eraseSwapped' },
  aborted: { type: 'eraseAborted' },
  ended: { type: 'eraseEnded' },
  mirrored: { type: 'mirrored', changes: 6 }, // the failed pass's device write landed, holding change 6
};
type Row = [SaveState, SaveEffect[]];
const same = (s: SaveState): Row => [s, []];
/** The erase's three closing events on a base state: stale, they change nothing (pinned). */
const stale = (s: SaveState) => ({ swapped: same(s), aborted: same(s), ended: same(s) });

const STATES: Record<string, SaveState> = {
  clean: clean(5),
  waiting: waiting(6, 5),
  saving: saving(6, 4, 6),
  savingArmed: saving(7, 4, 6, true),
  failed: failed(6, 4),
  failedMirrored: failed(6, 4, true), // US-09 AC30: the device copy holds its changes
  readingClean: reading(clean(5)),
  readingWaiting: reading(waiting(6, 5)), // the debounce put aside, its mode kept
  readingSavingArmed: reading(saving(7, 4, 6, true)),
  readingFailed: reading(failed(6, 4)),
  writingClean: writing(clean(7)),
  writingSaving: writing(saving(7, 4, 6)),
  writingFailed: writing(failed(7, 4)),
};

// state -> event -> [next state, effects asked for]
const TABLE: Record<string, Record<string, Row>> = {
  clean: {
    edited: [waiting(6, 5), [ARM]], save: same(clean(5)), landed: same(clean(5)), failed: same(clean(5)),
    synced: same(clean(5)), began: [reading(clean(5)), []], ...stale(clean(5)), mirrored: same(clean(5)),
  },
  waiting: {
    edited: [waiting(7, 5), [ARM]], save: [saving(6, 5, 6), [CANCEL, pass(6)]],
    landed: same(waiting(6, 5)), failed: same(waiting(6, 5)), synced: [clean(6), [CANCEL]],
    began: [reading(waiting(6, 5)), [CANCEL]], ...stale(waiting(6, 5)), mirrored: same(waiting(6, 5)),
  },
  saving: {
    edited: [saving(7, 4, 6, true), [ARM]], save: same(saving(6, 4, 6)), // joins, never a second pass
    landed: [clean(6), []], failed: [failed(6, 4), []], synced: [saving(6, 6, 6), []],
    began: [reading(saving(6, 4, 6)), []], // the pass goes on under the erase
    ...stale(saving(6, 4, 6)), mirrored: same(saving(6, 4, 6)),
  },
  savingArmed: {
    edited: [saving(8, 4, 6, true), [ARM]], save: [saving(7, 4, 6), [CANCEL]],
    // An edit during the pass: saved moves only to where the pass started, and another pass runs.
    landed: [saving(7, 6, 7, true), [pass(7)]],
    // The re-armed debounce outlives a failed pass, and retries it (as today).
    failed: [waiting(7, 4), []],
    synced: [saving(7, 7, 6), [CANCEL]],
    began: [reading(saving(7, 4, 6, true)), [CANCEL]], ...stale(saving(7, 4, 6, true)),
    mirrored: same(saving(7, 4, 6, true)),
  },
  failed: {
    edited: [waiting(7, 4), [ARM]], save: [saving(6, 4, 6), [pass(6)]],
    landed: same(failed(6, 4)), failed: same(failed(6, 4)), synced: [clean(6), []],
    began: [reading(failed(6, 4)), []], ...stale(failed(6, 4)),
    mirrored: [failed(6, 4, true), []],
  },
  failedMirrored: {
    edited: [waiting(7, 4), [ARM]], save: [saving(6, 4, 6), [pass(6)]],
    landed: same(failed(6, 4, true)), failed: same(failed(6, 4, true)), synced: [clean(6), []],
    began: [reading(failed(6, 4, true)), []], ...stale(failed(6, 4, true)),
    mirrored: same(failed(6, 4, true)),
  },
  readingClean: {
    edited: same(reading(clean(5))), save: same(reading(clean(5))), landed: same(reading(clean(5))),
    failed: same(reading(clean(5))), synced: same(reading(clean(5))), began: same(reading(clean(5))),
    swapped: [writing(failed(6, 5)), []], aborted: [clean(5), []], ended: [clean(5), []],
    mirrored: same(reading(clean(5))),
  },
  readingWaiting: {
    edited: same(reading(waiting(6, 5))), // refused: refuses() answers the caller
    save: [reading(saving(6, 5, 6)), [CANCEL, pass(6)]], // a flush during the read saves the pre-erase copy, as today
    landed: same(reading(waiting(6, 5))), failed: same(reading(waiting(6, 5))),
    synced: [reading(clean(6)), [CANCEL]],
    began: same(reading(waiting(6, 5))), // erase() refuses a second erase before dispatching
    swapped: [writing(failed(7, 5)), []],
    aborted: [waiting(6, 5), [ARM]], // the debounce back, no change added
    ended: [waiting(6, 5), []],
    mirrored: same(reading(waiting(6, 5))),
  },
  readingSavingArmed: {
    edited: same(reading(saving(7, 4, 6, true))), save: [reading(saving(7, 4, 6)), [CANCEL]],
    landed: [reading(saving(7, 6, 7, true)), [pass(7)]], failed: [reading(waiting(7, 4)), []],
    synced: [reading(saving(7, 7, 6)), [CANCEL]], began: same(reading(saving(7, 4, 6, true))),
    swapped: [writing(saving(8, 4, 6)), []], // the pass goes on and carries the erased copy
    aborted: [saving(7, 4, 6, true), [ARM]], ended: [saving(7, 4, 6, true), []],
    mirrored: same(reading(saving(7, 4, 6, true))),
  },
  readingFailed: {
    edited: same(reading(failed(6, 4))), save: [reading(saving(6, 4, 6)), [pass(6)]],
    landed: same(reading(failed(6, 4))), failed: same(reading(failed(6, 4))),
    synced: [reading(clean(6)), []], began: same(reading(failed(6, 4))),
    swapped: [writing(failed(7, 4)), []], aborted: [failed(6, 4), []], ended: [failed(6, 4), []],
    mirrored: [reading(failed(6, 4, true)), []], // passes to `under`: the device write held change 6
  },
  writingClean: {
    edited: same(writing(clean(7))), save: same(writing(clean(7))), landed: same(writing(clean(7))),
    failed: same(writing(clean(7))), synced: same(writing(clean(7))), began: same(writing(clean(7))),
    swapped: same(writing(clean(7))), aborted: same(writing(clean(7))), // past the swap: nothing to abort
    ended: [clean(7), []], mirrored: same(writing(clean(7))),
  },
  writingSaving: {
    edited: same(writing(saving(7, 4, 6))), save: same(writing(saving(7, 4, 6))),
    landed: [writing(saving(7, 6, 7)), [pass(7)]], // the erased copy still to write
    failed: [writing(failed(7, 4)), []], synced: [writing(saving(7, 7, 6)), []],
    began: same(writing(saving(7, 4, 6))), swapped: same(writing(saving(7, 4, 6))), aborted: same(writing(saving(7, 4, 6))),
    ended: [saving(7, 4, 6), []], // replaceUnreadable threw a non-Conflict error while a pre-erase pass runs
    mirrored: same(writing(saving(7, 4, 6))),
  },
  writingFailed: {
    edited: same(writing(failed(7, 4))), save: [writing(saving(7, 4, 7)), [pass(7)]],
    landed: same(writing(failed(7, 4))), failed: same(writing(failed(7, 4))),
    synced: [writing(clean(7)), []], began: same(writing(failed(7, 4))),
    swapped: same(writing(failed(7, 4))), aborted: same(writing(failed(7, 4))),
    ended: [failed(7, 4), []], // an erase whose write rejected never stays erasing
    mirrored: same(writing(failed(7, 4))), // a write that held change 6 does not hold change 7
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

describe('save-state transition table (A1, A6)', () => {
  it('covers every sample state x event pair', () => {
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
    expect(transition(saving(6, 4, 6), { type: 'passLanded', from: 5 })).toEqual({ state: saving(6, 4, 6), effects: [] });
    expect(transition(saving(6, 6, 6), EVENTS.failed)).toEqual({ state: clean(6), effects: [] });
    // a pass landing under an armed debounce leaves it armed, over nothing unsaved
    expect(transition(saving(6, 4, 6, true), EVENTS.landed)).toEqual({ state: waiting(6, 6), effects: [] });
    // a leftover debounce over nothing unsaved is put aside and given back as it was
    expect(run(waiting(5, 5), [EVENTS.began, EVENTS.aborted])).toEqual({ state: waiting(5, 5), effects: [CANCEL, ARM] });
  });

  it('mirrored (US-09 AC30): only a write that holds every change marks a failed pass, so an older write never vouches for a newer failure', () => {
    // pass A failed at change 6; an edit and pass B failed at 7 before A's device write landed
    const b = run(failed(6, 4), [EVENTS.edited, EVENTS.save, EVENTS.failed]).state;
    expect(b).toEqual(failed(7, 4));
    expect(transition(b, { type: 'mirrored', changes: 6 })).toEqual({ state: failed(7, 4), effects: [] });
    expect(transition(b, { type: 'mirrored', changes: 7 })).toEqual({ state: failed(7, 4, true), effects: [] });
    // under an erase, either phase, it passes to `under`
    expect(transition(reading(failed(7, 4)), { type: 'mirrored', changes: 7 })).toEqual({ state: reading(failed(7, 4, true)), effects: [] });
    expect(transition(writing(failed(7, 4)), { type: 'mirrored', changes: 7 })).toEqual({ state: writing(failed(7, 4, true)), effects: [] });
    // the erased copy swapped in is one more change the device write never held
    expect(transition(reading(failed(6, 4, true)), EVENTS.swapped)).toEqual({ state: writing(failed(7, 4)), effects: [] });
    // a new failure starts unmirrored, whatever the last one was
    expect(run(failed(6, 4, true), [EVENTS.save, EVENTS.failed]).state).toEqual(failed(6, 4));
  });

  it('every erase ends at a base state: aborted while reading, or swapped then ended', () => {
    for (const start of [clean(5), waiting(6, 5), saving(6, 4, 6), saving(7, 4, 6, true), failed(6, 4)]) {
      expect(run(start, [EVENTS.began, EVENTS.aborted]).state).toEqual(start);
      const done = run(start, [EVENTS.began, EVENTS.swapped, EVENTS.ended]).state;
      expect(done.mode).not.toBe('erasing');
    }
    // the erase's synchronous write threw: no save, no synced
    expect(run(clean(5), [EVENTS.began, EVENTS.swapped, EVENTS.ended]).state).toEqual(failed(6, 5));
  });

  it('an edit is refused in every erasing state, and the swap never leaves an armed debounce under the write', () => {
    for (const state of Object.values(STATES)) {
      if (state.mode !== 'erasing') continue;
      expect(transition(state, EVENTS.edited)).toEqual({ state, effects: [] });
      const next = transition(state, EVENTS.swapped).state;
      if (next.mode !== 'erasing') continue;
      expect(debounceArmed(next.under)).toBe(state.phase === 'writing' && debounceArmed(state.under));
    }
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
    // the debounce put aside: no timer runs, the change still waits
    ['reading over waiting', reading(waiting(6, 5)), true, true, false, 'saving'],
    ['reading over clean', reading(clean(5)), false, false, false, 'saved'],
    ['writing over saving', writing(saving(7, 4, 6)), true, true, false, 'saving'],
    ['writing over clean', writing(clean(7)), false, false, false, 'saved'],
    ['writing over failed', writing(failed(7, 4)), true, false, false, 'not-saved'],
    // an erase whose sync write failed: swapped, then ended with no synced
    ['after a failed erase write', run(clean(5), [EVENTS.began, EVENTS.swapped, EVENTS.ended]).state, true, false, false, 'not-saved'],
    // US-09 AC30: a failed save whose device write landed; until it lands, not-saved
    ['failed, its device write landed', failed(6, 4, true), true, false, false, 'not-saved-on-device'],
    ['reading over a mirrored failed', reading(failed(6, 4, true)), true, false, false, 'not-saved-on-device'],
    ['writing over a mirrored failed', writing(failed(7, 4, true)), true, false, false, 'not-saved-on-device'],
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
    const a = run(saving(6, 4, 6), [EVENTS.began, EVENTS.swapped, EVENTS.save, EVENTS.landed]);
    expect(a).toEqual({ state: writing(saving(7, 6, 7)), effects: [pass(7)] });
    const b = run(saving(6, 4, 6), [EVENTS.landed, EVENTS.began, EVENTS.swapped, EVENTS.save]);
    expect(b).toEqual({ state: writing(saving(7, 6, 7)), effects: [pass(7)] });
    expect(run(a.state, [{ type: 'passLanded', from: 7 }, EVENTS.ended]).state).toEqual(clean(7));
  });

  it('a pass landing during the read vs after an abort: the debounce comes back either way', () => {
    const a = run(saving(7, 4, 6, true), [EVENTS.began, EVENTS.landed, EVENTS.aborted]);
    expect(a).toEqual({ state: saving(7, 6, 7, true), effects: [CANCEL, pass(7), ARM] });
    const b = run(saving(7, 4, 6, true), [EVENTS.began, EVENTS.aborted, EVENTS.landed]);
    expect(b).toEqual({ state: saving(7, 6, 7, true), effects: [CANCEL, ARM, pass(7)] });
  });

  it('an erase whose write rejects leaves erasing for failed, and its change stays unsaved', () => {
    const r = run(waiting(6, 5), [EVENTS.began, EVENTS.swapped, EVENTS.save, EVENTS.failed, EVENTS.ended]);
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
