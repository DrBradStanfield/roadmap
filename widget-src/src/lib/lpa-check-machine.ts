/**
 * The Lp(a) check's answering mode as one named state (US-05 AC3, lead W1-6),
 * changed only through the pure `transition`. LpaChecks sends the events and
 * runs the work: the keep mark, the correction, what the region says, the focus.
 *
 * Phases, one answer at a time (every answer button is disabled outside idle):
 * - idle: free to answer.
 * - saving: a correction of `rowId` is writing.
 * - cooling: an answer just ended, whatever its outcome; for 600 ms
 *   (LpaChecks' timer sends `cooled`), so the second click of a double click
 *   never answers the notice that moved into its place (adversary R1).
 * `refusals` holds each row's last refusal text; a row's retry clears its own.
 */
import type { CorrectStatus } from '../storage/roadmap-store';
import { saveErrorText } from './value-cell-state';

export type Answering = { phase: 'idle' } | { phase: 'saving'; rowId: string } | { phase: 'cooling' };
export type LpaCheckState = { answering: Answering; refusals: Record<string, string> };
export type LpaCheckEvent =
  | { type: 'kept' }
  | { type: 'correcting'; rowId: string }
  | { type: 'settled'; status: CorrectStatus }
  | { type: 'cooled' };

export const LPA_CHECK_START: LpaCheckState = { answering: { phase: 'idle' }, refusals: {} };
/** How long every answer button rests after an answer. */
export const LPA_CHECK_COOL_MS = 600;

/** The same state back means the event changed nothing. */
export function transition(state: LpaCheckState, event: LpaCheckEvent): LpaCheckState {
  const { answering } = state;
  switch (event.type) {
    case 'kept':
      return answering.phase === 'idle' ? { ...state, answering: { phase: 'cooling' } } : state;
    case 'correcting': {
      if (answering.phase !== 'idle') return state;
      const { [event.rowId]: _old, ...refusals } = state.refusals;
      return { answering: { phase: 'saving', rowId: event.rowId }, refusals };
    }
    case 'settled':
      if (answering.phase !== 'saving') return state;
      return event.status === 'ok' || event.status === 'changed'
        ? { ...state, answering: { phase: 'cooling' } }
        : { answering: { phase: 'cooling' }, refusals: { ...state.refusals, [answering.rowId]: saveErrorText(event.status) } };
    case 'cooled':
      return answering.phase === 'cooling' ? { ...state, answering: { phase: 'idle' } } : state;
  }
}
