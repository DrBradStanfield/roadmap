// A single-topic widget's save, as one named state (US-74; CLAUDE.md "A mode
// is one named state"): nothing to say, saving, kept (with what was not, when
// some was not), or a save the store could not keep. Saves are automatic, so
// an edit during a save is part of the state: the save that ends then does
// not say "Saved" over an entry it did not take. Changed only through
// `transition`; widget-machine.test.ts is its table.
import type { Field } from './boxes';

/** A save that kept some entries and not others (review A5): each list names boxes. */
export interface PartlyKept { saved: Field[]; changed: Field[]; refused: Field[] }

export type WidgetState =
  | { mode: 'idle' }
  | { mode: 'saving'; edited: boolean }
  | { mode: 'saved'; partial: PartlyKept | null }
  | { mode: 'failed' };

export type WidgetEvent =
  | { type: 'edited' }
  | { type: 'started' }
  | { type: 'kept'; partial: PartlyKept | null }
  | { type: 'failed' };

export const START: WidgetState = { mode: 'idle' };

export function transition(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case 'started': return { mode: 'saving', edited: false };
    case 'edited':
      if (state.mode === 'saving') return state.edited ? state : { mode: 'saving', edited: true };
      return state.mode === 'idle' ? state : START; // an edit makes "Saved" or a notice out of date
    case 'kept':
      if (state.mode !== 'saving') return state;
      // An entry typed while it saved is not saved yet: say only what the save did not keep.
      if (state.edited) return event.partial ? { mode: 'saved', partial: event.partial } : START;
      return { mode: 'saved', partial: event.partial };
    case 'failed': return state.mode === 'saving' ? { mode: 'failed' } : state;
  }
}
