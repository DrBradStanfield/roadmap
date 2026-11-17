// US-74: the widget's save, one named state, as a table (CLAUDE.md "A mode is one named state").
import { describe, expect, it } from 'vitest';
import { START, transition, type PartlyKept, type WidgetEvent, type WidgetState } from './widget-machine';

const partial: PartlyKept = { saved: ['height'], changed: ['waist'], refused: [] };
const saving: WidgetState = { mode: 'saving', edited: false };
const savingEdited: WidgetState = { mode: 'saving', edited: true };
const saved: WidgetState = { mode: 'saved', partial: null };
const savedPartial: WidgetState = { mode: 'saved', partial };
const failed: WidgetState = { mode: 'failed' };

const ROWS: Array<[string, WidgetState, WidgetEvent, WidgetState]> = [
  ['a save starts', START, { type: 'started' }, saving],
  ['a queued save starts after the last', saved, { type: 'started' }, saving],
  ['a retry after a failure starts', failed, { type: 'started' }, saving],
  ['typing with nothing to say changes nothing', START, { type: 'edited' }, START],
  ['typing during a save is remembered', saving, { type: 'edited' }, savingEdited],
  ['typing again during a save stays remembered', savingEdited, { type: 'edited' }, savingEdited],
  ['a kept save says Saved', saving, { type: 'kept', partial: null }, saved],
  ['a part-kept save says what was kept (review A5)', saving, { type: 'kept', partial }, savedPartial],
  ['a save kept while the person typed does not say Saved', savingEdited, { type: 'kept', partial: null }, START],
  ['but still says what it did not keep', savingEdited, { type: 'kept', partial }, savedPartial],
  ['a save the store could not keep says so', saving, { type: 'failed' }, failed],
  ['typing after Saved clears it', saved, { type: 'edited' }, START],
  ['typing after a notice clears it', savedPartial, { type: 'edited' }, START],
  ['typing after a failure clears it; the drafts are kept', failed, { type: 'edited' }, START],
  ['an answer with no save on its way is ignored', saved, { type: 'kept', partial }, saved],
  ['a failure with no save on its way is ignored', START, { type: 'failed' }, START],
];

describe('widget save state (US-74)', () => {
  it.each(ROWS)('%s', (_name, state, event, next) => {
    expect(transition(state, event)).toEqual(next);
  });
});
