/**
 * The value page's Add form (ValuePage AddValue) as one named state (US-62 AC10,
 * US-03 AC2a, US-05 AC2), changed only through the pure `transition`. AddValue
 * sends the events and runs the work: the save, the clears, `say`, `onDone`.
 *
 * - ready: the form takes a submit. `message` is its alert line: a parse fault,
 *   a refusal, the unit message, or null.
 * - saving: a save is out, and Add is disabled. `unitChanged`: the unit moved
 *   under the typed text while it ran, so the text is gone and a refusal or a
 *   throw says so; an ok save says only its own words. Text typed since is in
 *   the new unit, so an edit clears it.
 * A throw ends the save with no words, as before (lead H128).
 * The synchronous claim (lib/sync-claim) stays beside it: a second submit in the
 * same render sees no state set by the first.
 */
import type { CorrectStatus } from '../storage/roadmap-store';
import { saveErrorText } from './value-cell-state';

/** What the Add form says when the unit changed under typed text (US-05 AC2). Not the grid editor's line. */
export const ADD_UNIT_CHANGED = 'The unit changed, so your value was not saved. Type it again in the new unit.';

export type AddForm =
  | { kind: 'ready'; message: string | null }
  | { kind: 'saving'; unitChanged: boolean };

export type AddEvent =
  | { type: 'edited' } // typed, or a day picked
  | { type: 'faulted'; message: string } // the form's own check refused it; nothing sent
  | { type: 'sent' }
  | { type: 'settled'; why: Exclude<CorrectStatus, 'ok'> | null } // the first refusal, or none
  | { type: 'threw' } // the save, or the weight answer before it, threw
  | { type: 'unitChanged' };

export const ADD_READY: AddForm = { kind: 'ready', message: null };

/** The same state back means the event changed nothing. */
export function transition(state: AddForm, event: AddEvent): AddForm {
  if (state.kind === 'ready') {
    switch (event.type) {
      case 'edited': return state.message === null ? state : ADD_READY;
      case 'faulted': return { kind: 'ready', message: event.message };
      case 'sent': return { kind: 'saving', unitChanged: false };
      case 'unitChanged': return { kind: 'ready', message: ADD_UNIT_CHANGED };
      default: return state;
    }
  }
  switch (event.type) {
    case 'settled':
      if (event.why === null) return ADD_READY;
      return { kind: 'ready', message: state.unitChanged ? ADD_UNIT_CHANGED : saveErrorText(event.why) };
    case 'threw': return state.unitChanged ? { kind: 'ready', message: ADD_UNIT_CHANGED } : ADD_READY;
    case 'unitChanged': return state.unitChanged ? state : { kind: 'saving', unitChanged: true };
    case 'edited': return state.unitChanged ? { kind: 'saving', unitChanged: false } : state;
    default: return state;
  }
}
