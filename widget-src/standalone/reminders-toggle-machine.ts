/**
 * The reminders toggle's mode as one named state (lead H116, US-17 AC18).
 * Changed only through the pure `transition`; reminders-control.tsx sends the
 * events and runs the calls. On or off is never here: it is the record's
 * opt-in, read at render, so this state only says what the person is doing.
 *
 * Steps:
 * - idle: the off line (or nothing to do while the record is on).
 * - asking: the step that asks to turn on, with what has been typed. The
 *   record turning on elsewhere closes it (Q2).
 * - refreshed: the address was already enrolled (AC8), so this device cannot
 *   show "on"; it says so. A Turn off here drops it (Q1).
 * - turningOn: the opt-in call runs; the form is read-only (Q4).
 * - turningOff: the cancel runs; `prior` is the step it returns to.
 * The resting steps carry the last failure's words; the running steps none.
 */

export interface ToggleForm {
  wantsUpdates: boolean;
  typedEmail: string;
  /** The provider had no email to give: ask for it (never enrol silently). */
  needsEmail: boolean;
  reminderEmail: string;
}
/** What typing changes; only a failure asks for the reminder field. */
export type FormEdit = Partial<Omit<ToggleForm, 'needsEmail'>>;

/** The words of the last failure, or none. */
type Failure = string | null;
export type Resting =
  | { phase: 'idle'; error: Failure }
  | { phase: 'asking'; form: ToggleForm; error: Failure }
  | { phase: 'refreshed'; email: string; error: Failure };
export type ToggleStep =
  | Resting
  | { phase: 'turningOn'; form: ToggleForm }
  | { phase: 'turningOff'; prior: Resting };

export type ToggleEvent =
  | { type: 'open' }
  | { type: 'edit'; edit: FormEdit }
  | { type: 'submit' }
  | { type: 'dismiss' }
  | { type: 'onDone' }
  | { type: 'onRefreshed'; email: string }
  | { type: 'onFailed'; message: string; needsEmail: boolean }
  | { type: 'off' }
  | { type: 'offDone' }
  | { type: 'offFailed'; message: string }
  /** The record's opt-in is on, written by another tab or device. */
  | { type: 'recordOn' };

export const EMPTY_FORM: ToggleForm = { wantsUpdates: false, typedEmail: '', needsEmail: false, reminderEmail: '' };
export const INITIAL_STEP: ToggleStep = { phase: 'idle', error: null };

/** The resting step the person sees: a running step shows the one it came from, buttons off. */
export function shown(state: ToggleStep): Resting {
  if (state.phase === 'turningOff') return state.prior;
  if (state.phase === 'turningOn') return { phase: 'asking', form: state.form, error: null };
  return state;
}
export const busy = (state: ToggleStep): boolean => state.phase === 'turningOn' || state.phase === 'turningOff';

export function transition(state: ToggleStep, event: ToggleEvent): ToggleStep {
  switch (event.type) {
    case 'open':
      // The words of the last failure stay (the old error state outlived the open).
      return state.phase === 'idle' ? { phase: 'asking', form: EMPTY_FORM, error: state.error } : state;
    case 'edit':
      // Only the open step takes typing: while Turn on runs it sends what was submitted (Q4).
      return state.phase === 'asking' ? { ...state, form: { ...state.form, ...event.edit } } : state;
    case 'submit':
      return state.phase === 'asking' ? { phase: 'turningOn', form: state.form } : state;
    case 'dismiss':
      return state.phase === 'asking' ? INITIAL_STEP : state;
    case 'onDone':
      return state.phase === 'turningOn' ? INITIAL_STEP : state;
    case 'onRefreshed':
      return state.phase === 'turningOn' ? { phase: 'refreshed', email: event.email, error: null } : state;
    case 'onFailed':
      if (state.phase !== 'turningOn') return state;
      return { phase: 'asking', form: { ...state.form, needsEmail: state.form.needsEmail || event.needsEmail }, error: event.message };
    case 'off':
      // Turn off shows only while the record is on; any resting step can sit under it.
      if (state.phase === 'turningOn' || state.phase === 'turningOff') return state;
      return { phase: 'turningOff', prior: { ...state, error: null } };
    case 'offDone':
      // "Already set up" is no longer true once reminders are off (Q1).
      if (state.phase !== 'turningOff') return state;
      return state.prior.phase === 'refreshed' ? INITIAL_STEP : state.prior;
    case 'offFailed':
      return state.phase === 'turningOff' ? { ...state.prior, error: event.message } : state;
    case 'recordOn':
      // A step left open would come back after a Turn off, stale (Q2).
      return state.phase === 'asking' ? INITIAL_STEP : state;
  }
}
