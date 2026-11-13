/**
 * "+ Add another supplement" as one named state (US-62 AC30c, AC30e, AC30g),
 * changed only through the pure `transition`. SupplementsSection sends the
 * events and runs what the DOM needs (focus, flushSync).
 *
 * - closed: the row shows. Nothing typed survives it.
 * - open: the search shows in the row's place.
 *   `query`: what is typed.
 *   `list`: its list shows (focus or typing shows it; a press outside hides it).
 *   `held`: a press, by finger or pointer, came down on the list and nothing
 *   has released it yet (chosen, a pointercancel, a press outside). An iPhone
 *   blurs the search before the press's click, so a held press keeps an empty
 *   search open when the focus leaves (AC30g).
 */
export type SupplementAdd =
  | { phase: 'closed' }
  | { phase: 'open'; query: string; list: boolean; held: boolean };

export type SupplementAddEvent =
  /** The row tapped. */
  | { type: 'opened' }
  | { type: 'focused' }
  | { type: 'typed'; query: string }
  | { type: 'pressedList' }
  | { type: 'pressCancelled' }
  | { type: 'pressedOutside' }
  /** Focus left the search and its list together (relatedTarget outside the add box, or null; #985). */
  | { type: 'focusLeft' }
  | { type: 'escaped' }
  | { type: 'added' };

export const CLOSED: SupplementAdd = { phase: 'closed' };

export function transition(state: SupplementAdd, event: SupplementAddEvent): SupplementAdd {
  if (state.phase === 'closed') {
    return event.type === 'opened' ? { phase: 'open', query: '', list: false, held: false } : state;
  }
  switch (event.type) {
    case 'opened': return state;
    case 'focused': return state.list ? state : { ...state, list: true };
    case 'typed': return { ...state, query: event.query, list: true };
    case 'pressedList': return state.held ? state : { ...state, held: true };
    case 'pressCancelled': return state.held ? { ...state, held: false } : state;
    case 'pressedOutside': return state.list || state.held ? { ...state, list: false, held: false } : state;
    case 'focusLeft': return state.held || state.query.trim() ? state : CLOSED;
    case 'escaped':
    case 'added': return CLOSED;
  }
}
