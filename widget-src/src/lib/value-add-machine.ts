/**
 * The value page's Add form (ValuePage AddValue) as one named state (US-62 AC10,
 * US-03 AC2a, US-05 AC2), changed only through the pure `transition`. AddValue
 * sends the events and runs the work: the save, the clears, `say`, `onDone`.
 *
 * - ready: the form takes a submit. `message` is its alert line: a parse fault,
 *   a refusal, the unit message, or null. `draft: 'cleared'`: a save that landed
 *   ended it, so the screen clears the typed value; every other end keeps it.
 * - saving: a save is out, and Add is disabled. `unitChanged`: the unit moved
 *   under the typed text while it ran, so the text is gone and a refusal or a
 *   throw says so; an ok save says only its own words. Text typed since is in
 *   the new unit, so an edit clears it.
 * A save ends with `ended`, from what the writes did and what the re-read did (US-03 AC11, lead H128):
 * see `transition`'s table. Only writes that all landed clear the typed value.
 * The synchronous claim (lib/sync-claim) stays beside it: a second submit in the
 * same render sees no state set by the first.
 */
import type { CorrectStatus } from '../storage/roadmap-store';
import { HISTORY_UNSHOWN, saveErrorText } from './value-cell-state';

/** What the Add form says when the unit changed under typed text (US-05 AC2). Not the grid editor's line. */
export const ADD_UNIT_CHANGED = 'The unit changed, so your value was not saved. Type it again in the new unit.';

/** What the Add form says when the save threw (lead H128, Brad 2026-11-26). */
export const ADD_SAVE_FAILED = 'Your value could not be saved. Try again.';

/** What the writes did: all landed, the first refusal, or a throw (`partial`: a blood pressure,
 *  whose first part may have landed before its second threw). */
export type WriteResult = { kind: 'landed' } | { kind: 'refused'; why: Exclude<CorrectStatus, 'ok'> } | { kind: 'threw'; partial: boolean };
/** The re-read after the writes: shown, failed, or none (the writes threw first). */
export type ReadResult = 'shown' | 'failed' | 'none';

export type AddForm =
  | { kind: 'ready'; message: string | null; draft?: 'cleared' }
  | { kind: 'saving'; unitChanged: boolean };

export type AddEvent =
  | { type: 'edited' } // typed, or a day picked
  | { type: 'faulted'; message: string } // the form's own check refused it; nothing sent
  | { type: 'sent' }
  | { type: 'ended'; write: WriteResult; read: ReadResult } // the save is over (US-03 AC11)
  | { type: 'unitChanged' };

export const ADD_READY: AddForm = { kind: 'ready', message: null };

/** How a save ends (US-03 AC11), from the writes and the re-read:
 * | write                      | re-read        | line                                      | typed value |
 * | landed                     | shown          | none (the page says Added or Corrected)   | cleared     |
 * | landed                     | failed         | HISTORY_UNSHOWN: it is saved              | cleared     |
 * | refused                    | shown, failed  | the refusal's own line                    | kept        |
 * | threw, nothing landed      | none           | ADD_SAVE_FAILED                           | kept        |
 * | threw, a part may have     | none           | HISTORY_UNSHOWN, never "not saved"        | kept        |
 * A unit that moved during the save (the text already gone) says ADD_UNIT_CHANGED where nothing landed. */
function ended(unitChanged: boolean, write: WriteResult, read: ReadResult): AddForm {
  switch (write.kind) {
    case 'landed': return { kind: 'ready', message: read === 'failed' ? HISTORY_UNSHOWN : null, draft: 'cleared' };
    case 'refused': return { kind: 'ready', message: unitChanged ? ADD_UNIT_CHANGED : saveErrorText(write.why) };
    case 'threw':
      if (write.partial) return { kind: 'ready', message: HISTORY_UNSHOWN };
      return { kind: 'ready', message: unitChanged ? ADD_UNIT_CHANGED : ADD_SAVE_FAILED };
  }
}

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
    case 'ended': return ended(state.unitChanged, event.write, event.read);
    case 'unitChanged': return state.unitChanged ? state : { kind: 'saving', unitChanged: true };
    case 'edited': return state.unitChanged ? { kind: 'saving', unitChanged: false } : state;
    default: return state;
  }
}
