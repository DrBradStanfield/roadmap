import { describe, it, expect } from 'vitest';
import { ADD_READY, UNIT_CHANGED, transition, type AddEvent, type AddForm } from './value-add-machine';
import { SAVE_ERRORS } from './value-cell-state';

// US-62 AC10, US-03 AC2a, US-05 AC2: every (state, event) pair names the state that follows.
const ready: AddForm = ADD_READY;
const faulted: AddForm = { kind: 'ready', message: 'Enter a value' };
const saving: AddForm = { kind: 'saving', unitChanged: false };
const savingMoved: AddForm = { kind: 'saving', unitChanged: true };

const edited: AddEvent = { type: 'edited' };
const fault: AddEvent = { type: 'faulted', message: 'Choose a day up to today.' };
const sent: AddEvent = { type: 'sent' };
const ok: AddEvent = { type: 'settled', why: null };
const changed: AddEvent = { type: 'settled', why: 'changed' };
const invalid: AddEvent = { type: 'settled', why: 'invalid' };
const error: AddEvent = { type: 'settled', why: 'error' };
const engine: AddEvent = { type: 'settled', why: { refused: 'The engine says no.' } };
const threw: AddEvent = { type: 'threw' };
const unitChanged: AddEvent = { type: 'unitChanged' };

const SAME = 'same';
const rows: [string, AddForm, AddEvent, AddForm | typeof SAME][] = [
  ['ready, edited: nothing to clear', ready, edited, SAME],
  ['ready with a message, edited: the line clears', faulted, edited, ready],
  ['ready, faulted: says why, nothing sent', ready, fault, { kind: 'ready', message: 'Choose a day up to today.' }],
  ['ready with a message, faulted: the new fault replaces it', faulted, fault, { kind: 'ready', message: 'Choose a day up to today.' }],
  ['ready, sent: saving', ready, sent, saving],
  ['ready with a message, sent: saving, the line clears as the save goes', faulted, sent, saving],
  ['ready, settled ok: stale', ready, ok, SAME],
  ['ready, settled changed: stale', faulted, changed, SAME],
  ['ready, threw: stale', faulted, threw, SAME],
  ['ready, unitChanged: says so', ready, unitChanged, { kind: 'ready', message: UNIT_CHANGED }],
  ['ready with a message, unitChanged: the unit line replaces it', faulted, unitChanged, { kind: 'ready', message: UNIT_CHANGED }],

  ['saving, edited: stays saving', saving, edited, SAME],
  ['saving, faulted: off-mode (the claim holds)', saving, fault, SAME],
  ['saving, sent: off-mode (the claim holds)', saving, sent, SAME],
  ['saving, settled ok: ready, no line', saving, ok, ready],
  ['saving, settled changed: ready, says so', saving, changed, { kind: 'ready', message: SAVE_ERRORS.changed }],
  ['saving, settled invalid: ready, says so', saving, invalid, { kind: 'ready', message: SAVE_ERRORS.invalid }],
  ['saving, settled error: ready, says so', saving, error, { kind: 'ready', message: SAVE_ERRORS.error }],
  ['saving, settled with the engine\'s words: ready, in its words', saving, engine, { kind: 'ready', message: 'The engine says no.' }],
  ['saving, threw: ready, no line (H128)', saving, threw, ready],
  ['saving, unitChanged: noted, the line waits for the result', saving, unitChanged, savingMoved],

  ['saving moved, edited: text typed since is in the new unit', savingMoved, edited, saving],
  ['saving moved, faulted: off-mode', savingMoved, fault, SAME],
  ['saving moved, sent: off-mode', savingMoved, sent, SAME],
  ['saving moved, settled ok: ready, no line (D2)', savingMoved, ok, ready],
  ['saving moved, settled changed: the unit line, the text is gone (D2)', savingMoved, changed, { kind: 'ready', message: UNIT_CHANGED }],
  ['saving moved, settled invalid: the unit line (D2)', savingMoved, invalid, { kind: 'ready', message: UNIT_CHANGED }],
  ['saving moved, settled error: the unit line (D2)', savingMoved, error, { kind: 'ready', message: UNIT_CHANGED }],
  ['saving moved, settled with the engine\'s words: the unit line (D2)', savingMoved, engine, { kind: 'ready', message: UNIT_CHANGED }],
  ['saving moved, threw: the unit line (D2)', savingMoved, threw, { kind: 'ready', message: UNIT_CHANGED }],
  ['saving moved, unitChanged: already noted', savingMoved, unitChanged, SAME],
];

describe('value-add-machine transition', () => {
  it.each(rows)('%s', (_name, state, event, expected) => {
    const next = transition(state, event);
    if (expected === SAME) expect(next).toBe(state);
    else expect(next).toEqual(expected);
  });

  it('the unit line is the value page\'s own words, not the grid editor\'s', () => {
    expect(UNIT_CHANGED).toBe('The unit changed, so your value was not saved. Type it again in the new unit.');
  });
});
