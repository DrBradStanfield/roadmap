// A single-topic widget's one named state (US-74; CLAUDE.md "A mode is one
// named state"): typing, saving, showing what the save kept, or a save the
// store could not keep. Changed only through `transition`; widget-machine.test.ts is its table.
import type { Results } from './body-measures';
import type { Field } from './boxes';

export type FieldErrors = Record<string, string>;

/** A save that kept some entries and not others (review A5): each list names boxes. */
export interface PartlyKept { saved: Field[]; changed: Field[]; refused: Field[] }

export type WidgetState =
  | { mode: 'editing'; errors: FieldErrors }
  | { mode: 'saving' }
  | { mode: 'shown'; results: Results | null; partial: PartlyKept | null }
  | { mode: 'failed' };

export type WidgetEvent =
  | { type: 'edited' }
  | { type: 'submitted'; errors: FieldErrors }
  | { type: 'saved'; results: Results | null; partial: PartlyKept | null }
  | { type: 'failed' };

export const START: WidgetState = { mode: 'editing', errors: {} };

export function transition(state: WidgetState, event: WidgetEvent): WidgetState {
  // A save on its way ends only by its own answer: a press or an edit waits.
  if (state.mode === 'saving') {
    if (event.type === 'saved') return { mode: 'shown', results: event.results, partial: event.partial };
    if (event.type === 'failed') return { mode: 'failed' };
    return state;
  }
  switch (event.type) {
    // An edit hides results that no longer match the boxes.
    case 'edited': return state.mode === 'editing' && Object.keys(state.errors).length === 0 ? state : START;
    case 'submitted': return Object.keys(event.errors).length > 0 ? { mode: 'editing', errors: event.errors } : { mode: 'saving' };
    default: return state; // an answer with no save on its way
  }
}
