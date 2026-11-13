// The batch watch as one named state (ledger H43; US-12 AC5a, AC9, AC24). processBatch
// (upload-pipeline.ts) runs the effects: the sleep, the poll, progress, then a throw or a return.
// Its loop checks a cancel first, then the deadline, then polls, and hands each fact here.
import type { BatchPollResponse, UploadErrorCode } from './api-types';

export type BatchWatch =
  | { phase: 'watching'; realCompleted: number; deadline: number }
  | { phase: 'done'; results: NonNullable<BatchPollResponse['results']> }
  | { phase: 'failed'; message: string; code: UploadErrorCode }
  | { phase: 'timedOut' }
  | { phase: 'cancelled' };

/** `polled` carries the whole answer: processing, a failure that can change, ended with results, ended with an error. */
export type WatchEvent = { type: 'polled'; answer: BatchPollResponse } | { type: 'deadline' } | { type: 'cancel' };

export function watchStart(deadline: number): BatchWatch {
  return { phase: 'watching', realCompleted: 0, deadline };
}

/** Pure. Every state but `watching` ignores every event. */
export function transition(state: BatchWatch, event: WatchEvent): BatchWatch {
  if (state.phase !== 'watching') return state;
  if (event.type === 'cancel') return { phase: 'cancelled' };
  if (event.type === 'deadline') return { phase: 'timedOut' };
  const { answer } = event;
  // An error wins over results beside it.
  if (answer.error) return { phase: 'failed', message: answer.error, code: answer.errorCode || 'server_error' };
  if (answer.status === 'ended' && answer.results) return { phase: 'done', results: answer.results };
  // The poll schema already refuses an end with neither (upload-api.ts batchPollAnswer); the type allows it.
  if (answer.status === 'ended') return { phase: 'failed', message: 'Batch poll answer unreadable', code: 'server_error' };
  // Processing, or a failure that can change: never less than the last answer (AC24).
  return { ...state, realCompleted: Math.max(state.realCompleted, answer.completed) };
}
