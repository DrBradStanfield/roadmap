/**
 * US-09 AC45: the cloud picker runs one move at a time, and the Drive
 * reconnect and "Use this browser only" are moves too. The table covers every
 * state against every event of switch-flow's pure transition, including
 * reports that name an older move.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, getSwitchFlow, isCurrentRun, resetSwitchFlow, transition, type SwitchEvent, type SwitchFlow } from './switch-flow';

const IDLE: SwitchFlow = { kind: 'idle', run: 1, error: null };
const FAILED: SwitchFlow = { kind: 'idle', run: 1, error: 'Dropbox could not be reached.' };
const TO_DRIVE: SwitchFlow = { kind: 'switching', run: 2, to: 'google-drive', step: 'list' };
const TO_GITHUB: SwitchFlow = { kind: 'switching', run: 2, to: 'github', step: 'github' };
const LOGGING_OFF: SwitchFlow = { kind: 'loggingOff', run: 2 };
const LEAVING: SwitchFlow = { kind: 'navigating', run: 2, step: 'list' };
const RECONNECTING: SwitchFlow = { kind: 'reconnecting', run: 2 };
const RECONNECTED: SwitchFlow = { kind: 'reconnected', run: 2 };
const STATES = { IDLE, FAILED, TO_DRIVE, TO_GITHUB, LOGGING_OFF, LEAVING, RECONNECTING, RECONNECTED };

const EVENTS = {
  start: { type: 'start', to: 'github', step: 'github' },
  logOff: { type: 'logOff' },
  // "Use this browser only" in the reconnect panel.
  forget: { type: 'start', to: 'local', step: 'list' },
  reconnect: { type: 'reconnect' },
  navigating: { type: 'navigating', run: 2 },
  navigatingOld: { type: 'navigating', run: 1 },
  settled: { type: 'settled', run: 2 },
  settledOld: { type: 'settled', run: 1 },
  failed: { type: 'failed', run: 2, message: 'GitHub rejected the token.' },
  failedOld: { type: 'failed', run: 1, message: 'GitHub rejected the token.' },
  clearError: { type: 'clearError' },
  // "Stop reconnecting": it ends only a reconnect whose popup answer is not yet saved.
  cancel: { type: 'cancel', run: 2 },
  cancelOld: { type: 'cancel', run: 1 },
  // The reconnect saved the popup's grant: from here it runs to its reload.
  saved: { type: 'saved', run: 2 },
  savedOld: { type: 'saved', run: 1 },
  // The browser shows this page again from its back-forward cache.
  restored: { type: 'restored' },
  // The picker opens again on this page.
  reopened: { type: 'reopened' },
} satisfies Record<string, SwitchEvent>;

const NEW_GITHUB: SwitchFlow = { kind: 'switching', run: 2, to: 'github', step: 'github' };
const NEW_LOG_OFF: SwitchFlow = { kind: 'loggingOff', run: 2 };
const NEW_LOCAL: SwitchFlow = { kind: 'switching', run: 2, to: 'local', step: 'list' };
const NEW_RECONNECT: SwitchFlow = { kind: 'reconnecting', run: 2 };
const ERROR_2: SwitchFlow = { kind: 'idle', run: 2, error: 'GitHub rejected the token.' };
const IDLE_2: SwitchFlow = { kind: 'idle', run: 2, error: null };

type Cell = [SwitchFlow, boolean];
const S = (state: SwitchFlow): Cell => [state, false];
/** Every state against every event: [next, run]. */
const TABLE: Record<keyof typeof STATES, Record<keyof typeof EVENTS, Cell>> = {
  IDLE: {
    start: [NEW_GITHUB, true], logOff: [NEW_LOG_OFF, true], forget: [NEW_LOCAL, true], reconnect: [NEW_RECONNECT, true],
    navigating: S(IDLE), navigatingOld: S(IDLE), settled: S(IDLE), settledOld: S(IDLE),
    failed: S(IDLE), failedOld: S(IDLE), clearError: S(IDLE), cancel: S(IDLE), cancelOld: S(IDLE), restored: S(IDLE), reopened: S(IDLE),
    saved: S(IDLE), savedOld: S(IDLE),
  },
  FAILED: {
    start: [NEW_GITHUB, true], logOff: [NEW_LOG_OFF, true], forget: [NEW_LOCAL, true], reconnect: [NEW_RECONNECT, true],
    navigating: S(FAILED), navigatingOld: S(FAILED), settled: S(FAILED), settledOld: S(FAILED),
    failed: S(FAILED), failedOld: S(FAILED), clearError: S(IDLE), cancel: S(FAILED), cancelOld: S(FAILED), restored: S(FAILED), reopened: S(FAILED),
    saved: S(FAILED), savedOld: S(FAILED),
  },
  TO_DRIVE: {
    start: S(TO_DRIVE), logOff: S(TO_DRIVE), forget: S(TO_DRIVE), reconnect: S(TO_DRIVE),
    navigating: S(LEAVING), navigatingOld: S(TO_DRIVE), settled: S(LEAVING), settledOld: S(TO_DRIVE),
    failed: S(ERROR_2), failedOld: S(TO_DRIVE), clearError: S(TO_DRIVE), cancel: S(TO_DRIVE), cancelOld: S(TO_DRIVE), restored: S(TO_DRIVE), reopened: S(TO_DRIVE),
    saved: S(TO_DRIVE), savedOld: S(TO_DRIVE),
  },
  TO_GITHUB: {
    start: S(TO_GITHUB), logOff: S(TO_GITHUB), forget: S(TO_GITHUB), reconnect: S(TO_GITHUB),
    navigating: S({ kind: 'navigating', run: 2, step: 'github' }), navigatingOld: S(TO_GITHUB),
    settled: S({ kind: 'navigating', run: 2, step: 'github' }), settledOld: S(TO_GITHUB),
    failed: S(ERROR_2), failedOld: S(TO_GITHUB), clearError: S(TO_GITHUB), cancel: S(TO_GITHUB), cancelOld: S(TO_GITHUB), restored: S(TO_GITHUB), reopened: S(TO_GITHUB),
    saved: S(TO_GITHUB), savedOld: S(TO_GITHUB),
  },
  LOGGING_OFF: {
    start: S(LOGGING_OFF), logOff: S(LOGGING_OFF), forget: S(LOGGING_OFF), reconnect: S(LOGGING_OFF),
    navigating: S({ kind: 'navigating', run: 2, step: 'log-off' }), navigatingOld: S(LOGGING_OFF),
    settled: S({ kind: 'navigating', run: 2, step: 'log-off' }), settledOld: S(LOGGING_OFF),
    failed: S(ERROR_2), failedOld: S(LOGGING_OFF), clearError: S(LOGGING_OFF), cancel: S(LOGGING_OFF), cancelOld: S(LOGGING_OFF), restored: S(LOGGING_OFF), reopened: S(LOGGING_OFF),
    saved: S(LOGGING_OFF), savedOld: S(LOGGING_OFF),
  },
  LEAVING: {
    start: S(LEAVING), logOff: S(LEAVING), forget: S(LEAVING), reconnect: S(LEAVING),
    navigating: S(LEAVING), navigatingOld: S(LEAVING), settled: S(LEAVING), settledOld: S(LEAVING),
    failed: S(ERROR_2), failedOld: S(LEAVING), clearError: S(LEAVING), cancel: S(LEAVING), cancelOld: S(LEAVING), restored: S(IDLE_2), reopened: S(IDLE_2),
    saved: S(LEAVING), savedOld: S(LEAVING),
  },
  RECONNECTING: {
    start: S(RECONNECTING), logOff: S(RECONNECTING), forget: S(RECONNECTING), reconnect: S(RECONNECTING),
    navigating: S(LEAVING), navigatingOld: S(RECONNECTING), settled: S(LEAVING), settledOld: S(RECONNECTING),
    failed: S(ERROR_2), failedOld: S(RECONNECTING), clearError: S(RECONNECTING), cancel: S(IDLE_2), cancelOld: S(RECONNECTING), restored: S(RECONNECTING), reopened: S(RECONNECTING),
    saved: S(RECONNECTED), savedOld: S(RECONNECTING),
  },
  // The grant is saved: nothing but its own failure or its reload ends it.
  RECONNECTED: {
    start: S(RECONNECTED), logOff: S(RECONNECTED), forget: S(RECONNECTED), reconnect: S(RECONNECTED),
    navigating: S(LEAVING), navigatingOld: S(RECONNECTED), settled: S(LEAVING), settledOld: S(RECONNECTED),
    failed: S(ERROR_2), failedOld: S(RECONNECTED), clearError: S(RECONNECTED), cancel: S(RECONNECTED), cancelOld: S(RECONNECTED), restored: S(RECONNECTED), reopened: S(RECONNECTED),
    saved: S(RECONNECTED), savedOld: S(RECONNECTED),
  },
};

const ROWS = Object.entries(TABLE).flatMap(([stateName, row]) =>
  Object.entries(row).map(([eventName, [next, run]]) => [
    `${stateName}, ${eventName}`, STATES[stateName as keyof typeof STATES], EVENTS[eventName as keyof typeof EVENTS] as SwitchEvent, next, run,
  ] as const));

describe('US-09 AC45: switch-flow transition, every state against every event', () => {
  it('covers 8 states by 17 events', () => expect(ROWS).toHaveLength(136));

  it.each(ROWS)('%s', (_name, state, event, next, run) => {
    expect(transition(state, event)).toEqual({ next, run });
  });

  it('an event that changes nothing returns the same state object, so nothing re-renders', () => {
    for (const [, state, event, next] of ROWS) {
      if (JSON.stringify(next) === JSON.stringify(state)) expect(transition(state, event).next).toBe(state);
    }
  });

  it('no state the table reaches holds a credential (Q5)', () => {
    for (const [, state, event] of ROWS) {
      for (const s of [state, transition(state, event).next]) {
        expect(JSON.stringify(s)).not.toMatch(/test-token-good|test-pass-good/);
      }
    }
  });
});

describe('US-09 AC45: the switch-flow store', () => {
  beforeEach(() => resetSwitchFlow());

  it('claims synchronously: a second start in the same turn is refused', () => {
    expect(dispatch(EVENTS.start)).toBe(true);
    expect(getSwitchFlow()).toEqual({ kind: 'switching', run: 1, to: 'github', step: 'github' });
    expect(dispatch({ type: 'start', to: 'google-drive', step: 'list' })).toBe(false);
    expect(dispatch(EVENTS.logOff)).toBe(false);
    expect(getSwitchFlow()).toEqual({ kind: 'switching', run: 1, to: 'github', step: 'github' });
  });

  it('a reconnect claims it as a start does: no move, log-off or second reconnect starts until it ends', () => {
    expect(dispatch(EVENTS.reconnect)).toBe(true);
    expect(getSwitchFlow()).toEqual({ kind: 'reconnecting', run: 1 });
    for (const event of [EVENTS.start, EVENTS.forget, EVENTS.logOff, EVENTS.reconnect]) expect(dispatch(event)).toBe(false);
    dispatch({ type: 'navigating', run: 1 });
    dispatch({ type: 'restored' });
    expect(dispatch(EVENTS.forget)).toBe(true);
    expect(dispatch(EVENTS.reconnect)).toBe(false); // nor a reconnect while "Use this browser only" runs
  });

  it('a failure frees it again and keeps the message until the next start', () => {
    dispatch(EVENTS.start);
    dispatch({ type: 'failed', run: 1, message: 'GitHub rejected the token.' });
    expect(getSwitchFlow()).toEqual({ kind: 'idle', run: 1, error: 'GitHub rejected the token.' });
    expect(dispatch(EVENTS.logOff)).toBe(true);
    expect(getSwitchFlow()).toEqual({ kind: 'loggingOff', run: 2 });
  });

  it('a report from an earlier move changes nothing in a later one', () => {
    dispatch({ type: 'start', to: 'google-drive', step: 'list' });
    dispatch({ type: 'navigating', run: 1 });
    dispatch({ type: 'restored' });
    dispatch(EVENTS.start);
    const running = getSwitchFlow();
    expect(running).toEqual({ kind: 'switching', run: 2, to: 'github', step: 'github' });
    dispatch({ type: 'failed', run: 1, message: 'Google Drive did not answer' });
    dispatch({ type: 'settled', run: 1 });
    expect(getSwitchFlow()).toBe(running);
  });
});

describe('US-09 AC45: a popup answer is kept only while its reconnect still runs', () => {
  // The answer comes from the reconnect that claimed run 2.
  it.each([
    ['still reconnecting at its run', { kind: 'reconnecting', run: 2 }, true],
    ['its grant saved, before its reload', { kind: 'reconnected', run: 2 }, true],
    ['idle after Stop reconnecting', { kind: 'idle', run: 2, error: null }, false],
    ['idle after the reconnect failed', { kind: 'idle', run: 2, error: 'Google Drive sign-in was cancelled or blocked.' }, false],
    ['a newer picker move', { kind: 'switching', run: 3, to: 'dropbox', step: 'list' }, false],
    ['a newer "Use this browser only"', { kind: 'switching', run: 3, to: 'local', step: 'list' }, false],
    ['a log-off', { kind: 'loggingOff', run: 3 }, false],
    ['its own reload under way', { kind: 'navigating', run: 2, step: 'list' }, false],
    ['a newer move navigating', { kind: 'navigating', run: 3, step: 'list' }, false],
    ['a newer reconnect', { kind: 'reconnecting', run: 3 }, false],
  ] as const)('%s: kept is %s', (_name, state, kept) => {
    expect(isCurrentRun(2, state as SwitchFlow)).toBe(kept);
  });

  it('reads the store: a reconnect stopped before its answer keeps nothing', () => {
    resetSwitchFlow();
    expect(dispatch(EVENTS.reconnect)).toBe(true);
    expect(isCurrentRun(1)).toBe(true);
    dispatch({ type: 'cancel', run: 1 });
    expect(getSwitchFlow()).toEqual({ kind: 'idle', run: 1, error: null });
    expect(isCurrentRun(1)).toBe(false);
  });

  it('reads the store: once the grant is saved, Stop changes nothing and no move starts until its reload', () => {
    resetSwitchFlow();
    dispatch(EVENTS.reconnect);
    dispatch({ type: 'saved', run: 1 });
    dispatch({ type: 'cancel', run: 1 });
    expect(getSwitchFlow()).toEqual({ kind: 'reconnected', run: 1 });
    expect(isCurrentRun(1)).toBe(true);
    for (const event of [EVENTS.start, EVENTS.forget, EVENTS.logOff, EVENTS.reconnect]) expect(dispatch(event)).toBe(false);
    dispatch({ type: 'navigating', run: 1 });
    expect(getSwitchFlow()).toEqual({ kind: 'navigating', run: 1, step: 'list' });
  });
});
