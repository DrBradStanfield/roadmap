import { describe, it, expect } from 'vitest';
import { transition, LPA_CHECK_START, type LpaCheckEvent, type LpaCheckState } from './lpa-check-machine';
import { SAVE_ERRORS } from './value-cell-state';

// US-05 AC3 (lead W1-6): every (phase, event) pair names the state that follows.
const refusals = { row0: SAVE_ERRORS.invalid, row1: SAVE_ERRORS.error };
const idle: LpaCheckState = { answering: { phase: 'idle' }, refusals };
const saving: LpaCheckState = { answering: { phase: 'saving', rowId: 'row0' }, refusals };
const cooling: LpaCheckState = { answering: { phase: 'cooling' }, refusals };

const kept: LpaCheckEvent = { type: 'kept' };
const correcting: LpaCheckEvent = { type: 'correcting', rowId: 'row0' };
const ok: LpaCheckEvent = { type: 'settled', status: 'ok' };
const invalid: LpaCheckEvent = { type: 'settled', status: 'invalid' };
const error: LpaCheckEvent = { type: 'settled', status: 'error' };
const engine: LpaCheckEvent = { type: 'settled', status: { refused: 'The engine says no.' } };
const changed: LpaCheckEvent = { type: 'settled', status: 'changed' };
const cooled: LpaCheckEvent = { type: 'cooled' };

const SAME = 'same';
const rows: [string, LpaCheckState, LpaCheckEvent, LpaCheckState | typeof SAME][] = [
  ['idle, kept: cooling, refusals kept', idle, kept, cooling],
  ['idle, correcting: saving that row, its old refusal cleared (D2)', idle, correcting,
    { answering: { phase: 'saving', rowId: 'row0' }, refusals: { row1: SAVE_ERRORS.error } }],
  ['idle, correcting a row with no refusal: saving, refusals as they were', idle, { type: 'correcting', rowId: 'row2' },
    { answering: { phase: 'saving', rowId: 'row2' }, refusals }],
  ['idle, settled ok: stale', idle, ok, SAME],
  ['idle, settled invalid: stale', idle, invalid, SAME],
  ['idle, settled changed: stale', idle, changed, SAME],
  ['idle, cooled: stale', idle, cooled, SAME],

  ['saving, kept: refused (one answer at a time)', saving, kept, SAME],
  ['saving, correcting: refused', saving, correcting, SAME],
  ['saving, settled ok: cooling (D1)', saving, ok, cooling],
  ['saving, settled invalid: cooling, the row\'s reason set (D1)', saving, invalid,
    { answering: { phase: 'cooling' }, refusals: { ...refusals, row0: SAVE_ERRORS.invalid } }],
  ['saving, settled error: cooling, the row\'s reason set', saving, error,
    { answering: { phase: 'cooling' }, refusals: { ...refusals, row0: SAVE_ERRORS.error } }],
  ['saving, settled with the engine\'s words: cooling, those words', saving, engine,
    { answering: { phase: 'cooling' }, refusals: { ...refusals, row0: 'The engine says no.' } }],
  ['saving, settled changed: cooling, no reason in the notice (D1)', saving, changed, cooling],
  ['saving, cooled: stale', saving, cooled, SAME],

  ['cooling, kept: refused', cooling, kept, SAME],
  ['cooling, correcting: refused', cooling, correcting, SAME],
  ['cooling, settled ok: stale', cooling, ok, SAME],
  ['cooling, settled invalid: stale', cooling, invalid, SAME],
  ['cooling, settled changed: stale', cooling, changed, SAME],
  ['cooling, cooled: idle', cooling, cooled, idle],
];

describe('lpa-check-machine transition', () => {
  it.each(rows)('%s', (_name, state, event, expected) => {
    const next = transition(state, event);
    if (expected === SAME) expect(next).toBe(state);
    else expect(next).toEqual(expected);
  });

  it('starts idle with no refusals', () => {
    expect(LPA_CHECK_START).toEqual({ answering: { phase: 'idle' }, refusals: {} });
  });

  it('a refusal, a retry and an ok: the reason goes at the retry and stays gone', () => {
    const start: LpaCheckState = LPA_CHECK_START;
    const steps: LpaCheckEvent[] = [correcting, invalid, cooled, correcting];
    const retrying = steps.reduce(transition, start);
    expect(retrying).toEqual({ answering: { phase: 'saving', rowId: 'row0' }, refusals: {} });
    expect([ok, cooled].reduce(transition, retrying)).toEqual(LPA_CHECK_START);
  });
});
