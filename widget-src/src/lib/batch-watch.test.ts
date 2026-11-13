// The batch watch's table (ledger H43; US-12 AC5a, AC9, AC24): every state x every event,
// with `polled` split into its four kinds of answer and the end that carries neither.
import { describe, expect, it } from 'vitest';
import { transition, watchStart, type BatchWatch, type WatchEvent } from './batch-watch';
import type { BatchPollResponse } from './api-types';

const DEADLINE = 600_000;
const results: NonNullable<BatchPollResponse['results']> = [{ index: 0, errorCode: 'refused' }];
const polled = (answer: BatchPollResponse): WatchEvent => ({ type: 'polled', answer });

const EVENTS: Record<string, WatchEvent> = {
  'polled processing': polled({ status: 'processing', completed: 5, total: 20 }),
  'polled transient error': polled({ status: 'error', completed: 0, total: 20 }),
  'polled ended with results': polled({ status: 'ended', completed: 20, total: 20, results }),
  'polled ended with an error': polled({ status: 'ended', completed: 0, total: 0, error: 'Batch not found.', errorCode: 'server_restart' }),
  'polled ended with neither': polled({ status: 'ended', completed: 20, total: 20 }),
  deadline: { type: 'deadline' },
  cancel: { type: 'cancel' },
};

const watching: BatchWatch = { phase: 'watching', realCompleted: 3, deadline: DEADLINE };
const STATES: Record<string, BatchWatch> = {
  watching,
  done: { phase: 'done', results },
  failed: { phase: 'failed', message: 'Batch poll refused', code: 'server_error' },
  timedOut: { phase: 'timedOut' },
  cancelled: { phase: 'cancelled' },
};

/** watching's row: the state each event leads to. */
const FROM_WATCHING: Record<string, BatchWatch> = {
  'polled processing': { phase: 'watching', realCompleted: 5, deadline: DEADLINE },
  'polled transient error': watching, // the count keeps 3: never less than the last answer (AC24)
  'polled ended with results': { phase: 'done', results },
  'polled ended with an error': { phase: 'failed', message: 'Batch not found.', code: 'server_restart' },
  'polled ended with neither': { phase: 'failed', message: 'Batch poll answer unreadable', code: 'server_error' },
  deadline: { phase: 'timedOut' },
  cancel: { phase: 'cancelled' },
};

describe('H43: the batch watch table', () => {
  it('starts watching with no count and its deadline', () => {
    expect(watchStart(DEADLINE)).toEqual({ phase: 'watching', realCompleted: 0, deadline: DEADLINE });
  });

  describe.each(Object.keys(STATES))('from %s', (from) => {
    it.each(Object.keys(EVENTS))('%s', (event) => {
      const next = transition(STATES[from], EVENTS[event]);
      // Every state but watching ignores every event, and returns itself.
      if (from !== 'watching') expect(next).toBe(STATES[from]);
      else expect(next).toEqual(FROM_WATCHING[event]);
    });
  });
});

describe('H43: watching keeps its facts', () => {
  it('the count never drops, whatever an answer says (US-12 AC24)', () => {
    const lower = transition({ ...watching, realCompleted: 7 }, polled({ status: 'processing', completed: 2, total: 20 }));
    expect(lower).toEqual({ phase: 'watching', realCompleted: 7, deadline: DEADLINE });
  });

  it('the deadline is carried unchanged through every poll', () => {
    let w: BatchWatch = watchStart(DEADLINE);
    for (const completed of [1, 0, 4, 4, 9]) {
      w = transition(w, polled({ status: completed ? 'processing' : 'error', completed, total: 20 }));
    }
    expect(w).toEqual({ phase: 'watching', realCompleted: 9, deadline: DEADLINE });
  });

  it('an error wins over results beside it (US-12 AC24)', () => {
    const both = polled({ status: 'ended', completed: 20, total: 20, results, error: 'Batch failed', errorCode: 'server_restart' });
    expect(transition(watching, both)).toEqual({ phase: 'failed', message: 'Batch failed', code: 'server_restart' });
  });

  it('an error with no code fails as a server error', () => {
    expect(transition(watching, polled({ status: 'ended', completed: 0, total: 0, error: 'Batch failed' })))
      .toEqual({ phase: 'failed', message: 'Batch failed', code: 'server_error' });
  });

  it('results while still processing are not an end', () => {
    expect(transition(watching, polled({ status: 'processing', completed: 4, total: 20, results })))
      .toEqual({ phase: 'watching', realCompleted: 4, deadline: DEADLINE });
  });
});
