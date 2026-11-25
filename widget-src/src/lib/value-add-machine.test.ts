import { describe, it, expect } from 'vitest';
import { ADD_READY, ADD_SAVE_FAILED, ADD_UNIT_CHANGED, transition, type AddEvent, type AddForm, type ReadResult, type WriteResult } from './value-add-machine';
import { HISTORY_UNSHOWN, SAVE_ERRORS } from './value-cell-state';

// US-62 AC10, US-03 AC2a, US-05 AC2: every (state, event) pair names the state that follows.
const ready: AddForm = ADD_READY;
const faulted: AddForm = { kind: 'ready', message: 'Enter a value' };
const saving: AddForm = { kind: 'saving', unitChanged: false };
const savingMoved: AddForm = { kind: 'saving', unitChanged: true };

const edited: AddEvent = { type: 'edited' };
const fault: AddEvent = { type: 'faulted', message: 'Choose a day up to today.' };
const sent: AddEvent = { type: 'sent' };
// US-03 AC11: a save ends from (what the writes did, what the re-read did).
const end = (write: WriteResult, read: ReadResult = 'shown'): AddEvent => ({ type: 'ended', write, read });
const ok = end({ kind: 'landed' });
const okUnread = end({ kind: 'landed' }, 'failed');
const changed = end({ kind: 'refused', why: 'changed' });
const changedUnread = end({ kind: 'refused', why: 'changed' }, 'failed');
const invalid = end({ kind: 'refused', why: 'invalid' });
const error = end({ kind: 'refused', why: 'error' });
const engine = end({ kind: 'refused', why: { refused: 'The engine says no.' } });
const threw = end({ kind: 'threw', partial: false }, 'none');
const threwPart = end({ kind: 'threw', partial: true }, 'none');
const CLEARED: AddForm = { kind: 'ready', message: null, draft: 'cleared' };
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
  ['ready, ended unread: stale', faulted, okUnread, SAME],
  ['ready after a landed save, edited: the clear stays done', CLEARED, edited, SAME],
  ['ready after a landed save, sent: saving again', CLEARED, sent, saving],
  ['ready, unitChanged: says so', ready, unitChanged, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['ready with a message, unitChanged: the unit line replaces it', faulted, unitChanged, { kind: 'ready', message: ADD_UNIT_CHANGED }],

  ['saving, edited: stays saving', saving, edited, SAME],
  ['saving, faulted: off-mode (the claim holds)', saving, fault, SAME],
  ['saving, sent: off-mode (the claim holds)', saving, sent, SAME],
  // US-03 AC11: (write, re-read) -> (line, typed value). Only writes that all landed clear it.
  ['saving, landed, shown: no line, cleared', saving, ok, CLEARED],
  ['saving, landed, re-read failed: the reload line, cleared (it is saved)', saving, okUnread, { kind: 'ready', message: HISTORY_UNSHOWN, draft: 'cleared' }],
  ['saving, refused (changed), shown: its line, kept', saving, changed, { kind: 'ready', message: SAVE_ERRORS.changed }],
  ['saving, refused (changed), re-read failed: its line, kept, never the saved outcome (Codex)', saving, changedUnread, { kind: 'ready', message: SAVE_ERRORS.changed }],
  ['saving, refused invalid: its line, kept', saving, invalid, { kind: 'ready', message: SAVE_ERRORS.invalid }],
  ['saving, refused error: its line, kept', saving, error, { kind: 'ready', message: SAVE_ERRORS.error }],
  ['saving, refused in the engine\'s words: those words, kept', saving, engine, { kind: 'ready', message: 'The engine says no.' }],
  ['saving, threw, nothing landed: not saved, kept (H128)', saving, threw, { kind: 'ready', message: ADD_SAVE_FAILED }],
  ['saving, blood pressure threw, a part may have landed: the reload line, kept', saving, threwPart, { kind: 'ready', message: HISTORY_UNSHOWN }],
  ['saving, unitChanged: noted, the line waits for the result', saving, unitChanged, savingMoved],

  ['saving moved, edited: text typed since is in the new unit', savingMoved, edited, saving],
  ['saving moved, faulted: off-mode', savingMoved, fault, SAME],
  ['saving moved, sent: off-mode', savingMoved, sent, SAME],
  ['saving moved, landed, shown: no line, cleared (D2)', savingMoved, ok, CLEARED],
  ['saving moved, landed, re-read failed: the reload line, cleared', savingMoved, okUnread, { kind: 'ready', message: HISTORY_UNSHOWN, draft: 'cleared' }],
  ['saving moved, refused changed: the unit line, the text is gone (D2)', savingMoved, changed, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, refused changed, re-read failed: the unit line', savingMoved, changedUnread, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, refused invalid: the unit line (D2)', savingMoved, invalid, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, refused error: the unit line (D2)', savingMoved, error, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, refused in the engine\'s words: the unit line (D2)', savingMoved, engine, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, threw: the unit line (D2)', savingMoved, threw, { kind: 'ready', message: ADD_UNIT_CHANGED }],
  ['saving moved, blood pressure threw: the reload line, never "not saved"', savingMoved, threwPart, { kind: 'ready', message: HISTORY_UNSHOWN }],
  ['saving moved, unitChanged: already noted', savingMoved, unitChanged, SAME],
];

describe('value-add-machine transition', () => {
  it.each(rows)('%s', (_name, state, event, expected) => {
    const next = transition(state, event);
    if (expected === SAME) expect(next).toBe(state);
    else expect(next).toEqual(expected);
  });

  it('the unit line is the value page\'s own words, not the grid editor\'s', () => {
    expect(ADD_UNIT_CHANGED).toBe('The unit changed, so your value was not saved. Type it again in the new unit.');
  });

  it('US-03: a save that threw says the value was not saved (Brad 2026-11-26, lead H128)', () => {
    expect(ADD_SAVE_FAILED).toBe('Your value could not be saved. Try again.');
  });

  it('US-03: a save whose re-read threw says the history line, the history panel\'s own words', () => {
    expect(HISTORY_UNSHOWN).toBe('Your history could not be shown. Reload the page to try again.');
  });
});
