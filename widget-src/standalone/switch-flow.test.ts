/**
 * US-09 AC45: the cloud picker runs one move at a time. The table covers
 * every state against every event of switch-flow's pure transition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, getSwitchFlow, resetSwitchFlow, transition, type SwitchEvent, type SwitchFlow } from './switch-flow';

const IDLE: SwitchFlow = { kind: 'idle', error: null };
const FAILED: SwitchFlow = { kind: 'idle', error: 'Dropbox could not be reached.' };
const TO_DRIVE: SwitchFlow = { kind: 'switching', to: 'google-drive', step: 'list' };
const TO_GITHUB: SwitchFlow = { kind: 'switching', to: 'github', step: 'github' };
const LOGGING_OFF: SwitchFlow = { kind: 'loggingOff' };

const START_GITHUB: SwitchEvent = { type: 'start', to: 'github', step: 'github' };
const LOG_OFF: SwitchEvent = { type: 'logOff' };
const FAIL: SwitchEvent = { type: 'failed', message: 'GitHub rejected the token.' };
const CLEAR: SwitchEvent = { type: 'clearError' };

type Row = [string, SwitchFlow, SwitchEvent, SwitchFlow, boolean];
const TABLE: Row[] = [
  ['idle, start', IDLE, START_GITHUB, TO_GITHUB, true],
  ['idle, logOff', IDLE, LOG_OFF, LOGGING_OFF, true],
  ['idle, failed', IDLE, FAIL, IDLE, false],
  ['idle, clearError', IDLE, CLEAR, IDLE, false],
  ['idle with an error, start', FAILED, START_GITHUB, TO_GITHUB, true],
  ['idle with an error, logOff', FAILED, LOG_OFF, LOGGING_OFF, true],
  ['idle with an error, failed', FAILED, FAIL, FAILED, false],
  ['idle with an error, clearError', FAILED, CLEAR, IDLE, false],
  ['switching from the list, start', TO_DRIVE, START_GITHUB, TO_DRIVE, false],
  ['switching from the list, logOff', TO_DRIVE, LOG_OFF, TO_DRIVE, false],
  ['switching from the list, failed', TO_DRIVE, FAIL, { kind: 'idle', error: 'GitHub rejected the token.' }, false],
  ['switching from the list, clearError', TO_DRIVE, CLEAR, TO_DRIVE, false],
  ['switching from a form, start', TO_GITHUB, START_GITHUB, TO_GITHUB, false],
  ['switching from a form, logOff', TO_GITHUB, LOG_OFF, TO_GITHUB, false],
  ['switching from a form, failed', TO_GITHUB, FAIL, { kind: 'idle', error: 'GitHub rejected the token.' }, false],
  ['switching from a form, clearError', TO_GITHUB, CLEAR, TO_GITHUB, false],
  ['logging off, start', LOGGING_OFF, START_GITHUB, LOGGING_OFF, false],
  ['logging off, logOff', LOGGING_OFF, LOG_OFF, LOGGING_OFF, false],
  ['logging off, failed', LOGGING_OFF, FAIL, { kind: 'idle', error: 'GitHub rejected the token.' }, false],
  ['logging off, clearError', LOGGING_OFF, CLEAR, LOGGING_OFF, false],
];

describe('US-09 AC45: switch-flow transition, every state against every event', () => {
  it.each(TABLE)('%s', (_name, state, event, next, run) => {
    expect(transition(state, event)).toEqual({ next, run });
  });

  it('a refused event returns the same state object, so nothing re-renders', () => {
    expect(transition(TO_GITHUB, START_GITHUB).next).toBe(TO_GITHUB);
    expect(transition(LOGGING_OFF, LOG_OFF).next).toBe(LOGGING_OFF);
    expect(transition(IDLE, FAIL).next).toBe(IDLE);
  });

  it('no state the table reaches holds a credential (Q5)', () => {
    for (const [, state, event, next] of TABLE) {
      for (const s of [state, next, transition(state, event).next]) {
        expect(JSON.stringify(s)).not.toMatch(/test-token-good|test-pass-good/);
      }
    }
  });
});

describe('US-09 AC45: the switch-flow store', () => {
  beforeEach(() => resetSwitchFlow());

  it('claims synchronously: a second start in the same turn is refused', () => {
    expect(dispatch(START_GITHUB)).toBe(true);
    expect(getSwitchFlow()).toEqual(TO_GITHUB);
    expect(dispatch({ type: 'start', to: 'google-drive', step: 'list' })).toBe(false);
    expect(dispatch(LOG_OFF)).toBe(false);
    expect(getSwitchFlow()).toEqual(TO_GITHUB);
  });

  it('a failure frees it again and keeps the message until the next start', () => {
    dispatch(START_GITHUB);
    dispatch(FAIL);
    expect(getSwitchFlow()).toEqual({ kind: 'idle', error: 'GitHub rejected the token.' });
    expect(dispatch(LOG_OFF)).toBe(true);
    expect(getSwitchFlow()).toEqual(LOGGING_OFF);
  });
});
