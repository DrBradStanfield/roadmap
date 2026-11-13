/**
 * The saved-value editor's transition table (US-04 AC1, US-05 AC2; H40, T31):
 * every state x event. A pair the table does not name leaves the state as it
 * is, the same object, with no effect: a stale timer, release or result.
 */
import { describe, it, expect } from 'vitest';
import {
  CLOSED, SAVE_ERRORS, UNIT_CHANGED, UNIT_FIRST, isOpen, messageOf, transition,
  type ValueCellEvent, type ValueCellState, type Step, type Verdict,
} from './value-cell-state';

const at = { row: 'r1', unit: 'si' as const, typed: '3.4' };
const STATES = {
  closed: CLOSED,
  closedSaid: { kind: 'closed', message: UNIT_CHANGED },
  closedRefocus: { kind: 'closed', message: UNIT_CHANGED, refocus: true },
  editing: { kind: 'editing', ...at },
  editingRefused: { kind: 'editing', ...at, error: SAVE_ERRORS.error },
  delay: { kind: 'blurPending', ...at, wait: 'delay' },
  press: { kind: 'blurPending', ...at, wait: 'press' },
  release: { kind: 'blurPending', ...at, wait: 'release' },
  saving: { kind: 'saving', ...at },
  savingClosed: { kind: 'savingClosed' },
} satisfies Record<string, ValueCellState>;
type S = keyof typeof STATES;

const SAVE = { save: 1.7 };
const EVENTS = {
  opened: { type: 'opened', row: 'r2', unit: 'conventional', text: '62' },
  typed: { type: 'typed', text: '3.6' },
  blurred: { type: 'blurred' },
  focused: { type: 'focused' },
  delayDue: { type: 'delayDue', pressed: false, verdict: SAVE },
  delayDuePressed: { type: 'delayDue', pressed: true, verdict: SAVE },
  released: { type: 'released' },
  pressCapDue: { type: 'pressCapDue', verdict: SAVE },
  releaseDue: { type: 'releaseDue', verdict: SAVE },
  pageHidden: { type: 'pageHidden', verdict: SAVE },
  escape: { type: 'escape' },
  enterSave: { type: 'submitted', how: 'enter', verdict: SAVE },
  enterUnusable: { type: 'submitted', how: 'enter', verdict: 'unusable' },
  leaveUnusable: { type: 'submitted', how: 'leave', verdict: 'unusable' },
  submitUnchanged: { type: 'submitted', how: 'enter', verdict: 'unchanged' },
  submitUnitChanged: { type: 'submitted', how: 'enter', verdict: 'unitChanged' },
  ok: { type: 'result', status: 'ok' },
  changed: { type: 'result', status: 'changed' },
  failed: { type: 'result', status: 'error' },
  refusedByEngine: { type: 'result', status: { refused: 'The engine said no.' } },
  unitSwitched: { type: 'unitSwitched', hadFocus: false },
  unitSwitchedFocused: { type: 'unitSwitched', hadFocus: true },
  leftForUnitEdited: { type: 'leftForUnit', edited: true },
  leftForUnitUntouched: { type: 'leftForUnit', edited: false },
  refocused: { type: 'refocused' },
} satisfies Record<string, ValueCellEvent>;
type E = keyof typeof EVENTS;

const to = (state: ValueCellState): Step => ({ state, effects: [] });
const saves: Step = { state: { kind: 'saving', ...at }, effects: [{ type: 'save', row: 'r1', value: 1.7 }] };
const editingAgain = { kind: 'editing', ...at } as const;
const closedWith = (message: string): Step => to({ kind: 'closed', message });

/** Whatever an open editor (editing or blurPending) does with these. */
const leavingOpen: Partial<Record<E, Step>> = {
  unitSwitched: closedWith(UNIT_CHANGED),
  unitSwitchedFocused: to({ kind: 'closed', message: UNIT_CHANGED, refocus: true }),
  leftForUnitEdited: closedWith(UNIT_FIRST),
  leftForUnitUntouched: to(CLOSED),
};
const pendingSubmits: Partial<Record<E, Step>> = {
  enterSave: saves, leaveUnusable: to(CLOSED), submitUnchanged: to(CLOSED), submitUnitChanged: closedWith(UNIT_CHANGED),
  pageHidden: saves, // R2: a save already asked for by leaving runs as the page goes away
  focused: to(editingAgain), // PR 1691: coming back cancels the pending save
};

const TABLE: Record<S, Partial<Record<E, Step>>> = {
  closed: { opened: to({ kind: 'editing', row: 'r2', unit: 'conventional', typed: '62' }) },
  closedSaid: { opened: to({ kind: 'editing', row: 'r2', unit: 'conventional', typed: '62' }) },
  closedRefocus: {
    opened: to({ kind: 'editing', row: 'r2', unit: 'conventional', typed: '62' }),
    refocused: closedWith(UNIT_CHANGED),
  },
  editing: {
    ...leavingOpen,
    typed: to({ kind: 'editing', ...at, typed: '3.6' }),
    blurred: to({ kind: 'blurPending', ...at, wait: 'delay' }),
    escape: to(CLOSED),
    enterSave: saves, leaveUnusable: to(CLOSED), submitUnchanged: to(CLOSED), submitUnitChanged: closedWith(UNIT_CHANGED),
    // enterUnusable: stays open for the editor to say why. pageHidden: text
    // left in an open editor, refocused or not, is not saved (US-04 AC1).
  },
  editingRefused: {
    ...leavingOpen,
    typed: to({ kind: 'editing', ...at, typed: '3.6' }), // typing clears the refusal
    blurred: to({ kind: 'blurPending', ...at, error: SAVE_ERRORS.error, wait: 'delay' }),
    escape: to(CLOSED),
    enterSave: saves, leaveUnusable: to(CLOSED), submitUnchanged: to(CLOSED), submitUnitChanged: closedWith(UNIT_CHANGED),
  },
  delay: {
    ...leavingOpen, ...pendingSubmits,
    delayDue: saves,
    delayDuePressed: to({ kind: 'blurPending', ...at, wait: 'press' }),
  },
  press: { ...leavingOpen, ...pendingSubmits, released: to({ kind: 'blurPending', ...at, wait: 'release' }), pressCapDue: saves },
  release: { ...leavingOpen, ...pendingSubmits, releaseDue: saves },
  saving: {
    ok: to(CLOSED),
    changed: closedWith(SAVE_ERRORS.changed),
    failed: to({ kind: 'editing', ...at, error: SAVE_ERRORS.error }),
    refusedByEngine: to({ kind: 'editing', ...at, error: 'The engine said no.' }),
    unitSwitched: to({ kind: 'savingClosed' }),
    unitSwitchedFocused: to({ kind: 'savingClosed' }),
  },
  savingClosed: {
    ok: to(CLOSED),
    changed: closedWith(SAVE_ERRORS.changed),
    failed: closedWith(SAVE_ERRORS.error),
    refusedByEngine: closedWith('The engine said no.'),
  },
};

describe('value-cell-state transition: every state x event', () => {
  for (const s of Object.keys(STATES) as S[]) {
    for (const e of Object.keys(EVENTS) as E[]) {
      const expected = TABLE[s][e];
      it(`${s} x ${e} -> ${expected ? JSON.stringify(expected.state) : 'unchanged'}`, () => {
        const step = transition(STATES[s], EVENTS[e]);
        if (expected) expect(step).toEqual(expected);
        else {
          expect(step.state).toBe(STATES[s]);
          expect(step.effects).toEqual([]);
        }
      });
    }
  }
});

describe('every leave from blurPending judges the text as a leave', () => {
  const leaves: [ValueCellState, (verdict: Verdict) => ValueCellEvent][] = [
    [STATES.delay, verdict => ({ type: 'delayDue', pressed: false, verdict })],
    [STATES.press, verdict => ({ type: 'pressCapDue', verdict })],
    [STATES.release, verdict => ({ type: 'releaseDue', verdict })],
    [STATES.delay, verdict => ({ type: 'pageHidden', verdict })],
  ];
  for (const [state, make] of leaves) {
    const type = make('unusable').type;
    it(`${state.kind}(${'wait' in state ? state.wait : ''}) x ${type}: text it cannot save closes the editor, never a half-open form`, () => {
      expect(transition(state, make('unusable'))).toEqual(to(CLOSED));
    });
    it(`${state.kind}(${'wait' in state ? state.wait : ''}) x ${type}: a unit changed since the open saves nothing and says so`, () => {
      expect(transition(state, make('unitChanged'))).toEqual(closedWith(UNIT_CHANGED));
      expect(transition(state, make('unchanged'))).toEqual(to(CLOSED));
    });
  }
});

describe('blurPending keeps a refusal the editor showed', () => {
  it('coming back shows it again', () => {
    const pending: ValueCellState = { kind: 'blurPending', ...at, error: SAVE_ERRORS.error, wait: 'delay' };
    expect(transition(pending, EVENTS.focused).state).toEqual({ kind: 'editing', ...at, error: SAVE_ERRORS.error });
  });
});

describe('stale events', () => {
  it('a click-away timer due after a refocus does nothing', () => {
    const back = transition(STATES.delay, EVENTS.focused).state;
    expect(transition(back, EVENTS.delayDue)).toEqual(to(back));
    expect(transition(back, EVENTS.pressCapDue).state).toBe(back);
  });
  it('a release, or the release task, in the wrong wait does nothing', () => {
    expect(transition(STATES.delay, EVENTS.released).state).toBe(STATES.delay);
    expect(transition(STATES.delay, EVENTS.releaseDue).state).toBe(STATES.delay);
    expect(transition(STATES.release, EVENTS.pressCapDue).state).toBe(STATES.release);
  });
  it('a correction answering after the editor closed another way changes nothing', () => {
    const closed = transition(STATES.editing, EVENTS.escape).state;
    expect(transition(closed, EVENTS.failed).state).toBe(closed);
  });
});

describe('isOpen and messageOf', () => {
  it('the editor shows in editing, blurPending and saving', () => {
    expect((Object.keys(STATES) as S[]).filter(s => isOpen(STATES[s]))).toEqual(['editing', 'editingRefused', 'delay', 'press', 'release', 'saving']);
  });
  it('says the closed message or the open refusal, nothing while saving', () => {
    expect(messageOf(STATES.closedSaid)).toBe(UNIT_CHANGED);
    expect(messageOf(STATES.editingRefused)).toBe(SAVE_ERRORS.error);
    expect(messageOf(STATES.saving)).toBeUndefined();
    expect(messageOf(STATES.savingClosed)).toBeUndefined();
  });
});
