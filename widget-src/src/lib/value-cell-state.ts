// The saved-value editor's modes (ValueCell in MatrixSavedCells.tsx), as one
// named state (US-04 AC1, US-05 AC2; leads H40, T31). The cell sends the
// events and runs the effects; nothing else changes the state.
//
// Every fact an event needs (whether a pointer is down, what the typed text
// would save) is measured as the event is sent, never when it is scheduled.
import type { CorrectStatus } from '../storage/roadmap-store';
import type { CellUnit } from './blood-test-cell';

/** What a refused correction says, wherever one is made. */
export const SAVE_ERRORS: Record<Exclude<Extract<CorrectStatus, string>, 'ok'>, string> = {
  changed: 'This value changed on another device, so your edit was not saved.',
  invalid: 'That value is outside the range this record takes.',
  error: 'Could not save. Check your connection and try again.',
};
/** A refusal's words: the engine's own when it gave them (US-21 AC26). */
export const saveErrorText = (status: Exclude<CorrectStatus, 'ok'>) => typeof status === 'string' ? SAVE_ERRORS[status] : status.refused;

/** What an editor closed by a unit switch says (US-05 AC2). */
export const UNIT_CHANGED = 'The unit changed, so your edit was not saved. Type it again in the new unit.';
/** What an editor left for its own unit control says (US-05 AC2). */
export const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';

/**
 * Every open state carries the row the editor opened on, which its correction
 * names (the store refuses it once another writer has replaced that row), and
 * the unit shown then: a correction is saved only in that unit (US-05 AC2).
 * - closed: the saved value shows, with `message` if the last edit said one;
 *   `refocus`: the focus comes back to the cell (a unit switch closed the
 *   editor that had it).
 * - editing: the editor is open with the focus; `error` a refusal it shows.
 * - blurPending: the focus left; the click-away save waits. `delay`: 150 ms,
 *   so a click on the cell's neighbours runs first. `press`: due during a
 *   press, it waits for the release (its click has not run), a second at most
 *   (a release can be lost). `release`: a task on, so the click runs first.
 *   Coming back cancels it (PR 1691); the page going away runs it.
 * - saving: the correction is out; the editor shows it, disabled.
 * - savingClosed: a unit switch closed the editor while its save was out;
 *   the save reports its own result.
 */
export type ValueCellState =
  | { kind: 'closed'; message?: string; refocus?: true }
  | { kind: 'editing'; row: string; unit?: CellUnit; typed: string; error?: string }
  | { kind: 'blurPending'; row: string; unit?: CellUnit; typed: string; error?: string; wait: 'delay' | 'press' | 'release' }
  | { kind: 'saving'; row: string; unit?: CellUnit; typed: string }
  | { kind: 'savingClosed' };

/** How long each click-away wait lasts, in ms. */
export const WAIT_MS = { delay: 150, press: 1000, release: 0 } as const;

/** What the typed text would do if saved now, judged by the cell as the event
 *  is sent: the unit changed since the editor opened, it saves nothing (empty,
 *  as opened, or the saved value), it cannot be saved, or this value (as stored). */
export type Verdict = 'unitChanged' | 'unchanged' | 'unusable' | { save: number };

export type ValueCellEvent =
  | { type: 'opened'; row: string; unit?: CellUnit; text: string } // a click on the saved value
  | { type: 'typed'; text: string }
  | { type: 'blurred' } // the focus left, for anywhere but this row's unit control
  | { type: 'focused' } // the focus came back
  | { type: 'delayDue'; pressed: boolean; verdict: Verdict } // the 150 ms ran out; `pressed`: a pointer is down
  | { type: 'released' } // the last pointer down came up
  | { type: 'pressCapDue'; verdict: Verdict } // a second passed with the press still held
  | { type: 'releaseDue'; verdict: Verdict } // the task after the release ran
  | { type: 'pageHidden'; verdict: Verdict } // the tab was hidden or the page went away
  | { type: 'escape' }
  | { type: 'submitted'; how: 'enter' | 'leave'; verdict: Verdict }
  | { type: 'result'; status: CorrectStatus } // the correction answered
  | { type: 'unitSwitched'; hadFocus: boolean } // the unit shown changed
  | { type: 'leftForUnit'; edited: boolean } // a press on, or Tab to, a unit control that governs this editor
  | { type: 'refocused' }; // the cell took the focus back

/** save: send the correction of `row` to `value` (as stored), then `result`. */
export type ValueCellEffect = { type: 'save'; row: string; value: number };

export interface Step { state: ValueCellState; effects: ValueCellEffect[] }

export const CLOSED: ValueCellState = { kind: 'closed' };
const stay = (state: ValueCellState): Step => ({ state, effects: [] });
const closed = (message?: string): Step => stay(message ? { kind: 'closed', message } : CLOSED);

/** The editor is on screen (`saving` too: it shows the correction going out). */
export const isOpen = (s: ValueCellState): s is Extract<ValueCellState, { typed: string }> =>
  s.kind === 'editing' || s.kind === 'blurPending' || s.kind === 'saving';

/** What the cell says: its message, or the open editor's refusal. */
export const messageOf = (s: ValueCellState): string | undefined =>
  s.kind === 'closed' ? s.message : s.kind === 'editing' || s.kind === 'blurPending' ? s.error : undefined;

/** A save asked from an open editor. Enter keeps an unusable text open, for
 *  the editor to say why; a leave drops it, never leaving a half-open form. */
function submit(s: Extract<ValueCellState, { kind: 'editing' | 'blurPending' }>, how: 'enter' | 'leave', verdict: Verdict): Step {
  if (verdict === 'unitChanged') return closed(UNIT_CHANGED);
  if (verdict === 'unchanged') return closed();
  if (verdict === 'unusable') return how === 'enter' ? stay(s) : closed();
  return { state: { kind: 'saving', row: s.row, unit: s.unit, typed: s.typed }, effects: [{ type: 'save', row: s.row, value: verdict.save }] };
}

/** The only way the editor's mode changes. Every pair not named leaves it as it is. */
export function transition(state: ValueCellState, event: ValueCellEvent): Step {
  switch (state.kind) {
    case 'closed':
      if (event.type === 'opened') return stay({ kind: 'editing', row: event.row, unit: event.unit, typed: event.text });
      if (event.type === 'refocused' && state.refocus) return closed(state.message);
      return stay(state);
    case 'editing':
    case 'blurPending': {
      const { row, unit, typed, error } = state;
      const editing: ValueCellState = { kind: 'editing', row, unit, typed, ...(error ? { error } : {}) };
      const pending = (wait: 'delay' | 'press' | 'release'): Step => stay({ ...editing, kind: 'blurPending', wait });
      switch (event.type) {
        case 'unitSwitched':
          return stay(event.hadFocus ? { kind: 'closed', message: UNIT_CHANGED, refocus: true } : { kind: 'closed', message: UNIT_CHANGED });
        case 'leftForUnit': return closed(event.edited ? UNIT_FIRST : undefined);
      }
      if (state.kind === 'editing') {
        switch (event.type) {
          case 'typed': return stay({ kind: 'editing', row, unit, typed: event.text });
          case 'blurred': return pending('delay');
          case 'escape': return closed();
          case 'submitted': return submit(state, event.how, event.verdict);
          default: return stay(state); // pageHidden: text left in an open editor is not saved (US-04 AC1)
        }
      }
      switch (event.type) {
        case 'focused': return stay(editing);
        case 'delayDue':
          if (state.wait !== 'delay') return stay(state);
          return event.pressed ? pending('press') : submit(state, 'leave', event.verdict);
        case 'released': return state.wait === 'press' ? pending('release') : stay(state);
        case 'pressCapDue': return state.wait === 'press' ? submit(state, 'leave', event.verdict) : stay(state);
        case 'releaseDue': return state.wait === 'release' ? submit(state, 'leave', event.verdict) : stay(state);
        case 'pageHidden': return submit(state, 'leave', event.verdict);
        case 'submitted': return submit(state, event.how, event.verdict);
        default: return stay(state);
      }
    }
    case 'saving':
      if (event.type === 'unitSwitched') return stay({ kind: 'savingClosed' });
      if (event.type !== 'result') return stay(state);
      // A value replaced meanwhile closes the editor, and the cell says the
      // edit went; any other failure keeps it open for a retry.
      if (event.status === 'ok') return closed();
      if (event.status === 'changed') return closed(saveErrorText(event.status));
      return stay({ kind: 'editing', row: state.row, unit: state.unit, typed: state.typed, error: saveErrorText(event.status) });
    case 'savingClosed':
      if (event.type !== 'result') return stay(state);
      return closed(event.status === 'ok' ? undefined : saveErrorText(event.status));
  }
}
