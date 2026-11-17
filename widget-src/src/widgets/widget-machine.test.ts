// US-74: the widget's one named state, as a table (CLAUDE.md "A mode is one named state").
import { describe, expect, it } from 'vitest';
import { START, transition, type WidgetEvent, type WidgetState } from './widget-machine';
import type { Results } from './body-measures';

const results: Results = { target: 'Target: <89 cm' };
const errors = { heightCm: 'Required' };
const editingWithErrors: WidgetState = { mode: 'editing', errors };
const saving: WidgetState = { mode: 'saving' };
const shown: WidgetState = { mode: 'shown', results };
const failed: WidgetState = { mode: 'failed' };

const ROWS: Array<[string, WidgetState, WidgetEvent, WidgetState]> = [
  ['a valid press saves', START, { type: 'submitted', errors: {} }, saving],
  ['an invalid press shows the errors', START, { type: 'submitted', errors }, editingWithErrors],
  ['an edit clears the errors', editingWithErrors, { type: 'edited' }, START],
  ['an edit while typing changes nothing', START, { type: 'edited' }, START],
  ['a save that lands shows the results', saving, { type: 'saved', results }, shown],
  ['a save refused says so', saving, { type: 'failed' }, failed],
  ['a press while saving waits', saving, { type: 'submitted', errors: {} }, saving],
  ['an edit while saving waits', saving, { type: 'edited' }, saving],
  ['an edit hides results that no longer match', shown, { type: 'edited' }, START],
  ['a press after a result saves again', shown, { type: 'submitted', errors: {} }, saving],
  ['a press after a refusal tries again', failed, { type: 'submitted', errors: {} }, saving],
  ['an edit after a refusal clears it', failed, { type: 'edited' }, START],
  ['an answer with no save on its way is ignored', shown, { type: 'saved', results }, shown],
  ['a refusal with no save on its way is ignored', START, { type: 'failed' }, START],
];

describe('widget state (US-74)', () => {
  it.each(ROWS)('%s', (_name, state, event, next) => {
    expect(transition(state, event)).toEqual(next);
  });
});
