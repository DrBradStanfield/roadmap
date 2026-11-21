// The web upload list's one screen state, the focused input's draft (US-13 AC26, web list PR 2): a table test of its
// pure transition. Every event against every draft shape, and what each sends to the engine. A draft keeps the unit it
// was typed in from its first keystroke (Codex R2): a unit switch while typing never re-reads it.
import { describe, expect, it } from 'vitest';
import { transition, type Draft, type DraftEvent } from './upload-list-draft';

const A: Draft = { key: 'f0:v0', text: '3.4', unit: 'si', unitLabel: 'mmol/L' };
const rows = (...keys: string[]): DraftEvent => ({ type: 'rows', inputs: new Set(keys) });

describe('upload list draft (US-13 AC26)', () => {
  it.each<[string, Draft, DraftEvent, Draft, Draft]>([
    ['typing starts a draft in the unit on screen, with its label', null, { type: 'type', key: 'f0:v0', text: '3', unit: 'conventional', unitLabel: 'mg/dL' }, { key: 'f0:v0', text: '3', unit: 'conventional', unitLabel: 'mg/dL' }, null],
    ['typing on keeps the unit and label it started in (Codex R2, R1)', A, { type: 'type', key: 'f0:v0', text: '3.45', unit: 'conventional', unitLabel: 'mg/dL' }, { key: 'f0:v0', text: '3.45', unit: 'si', unitLabel: 'mmol/L' }, null],
    ['typing in another row commits the old draft first', A, { type: 'type', key: 'f0:v1', text: '9', unit: null, unitLabel: null }, { key: 'f0:v1', text: '9', unit: null, unitLabel: null }, A],
    ['an emptied input is a draft too (the engine clears the row)', A, { type: 'type', key: 'f0:v0', text: '', unit: 'si', unitLabel: 'mmol/L' }, { key: 'f0:v0', text: '', unit: 'si', unitLabel: 'mmol/L' }, null],
    ['commit sends the draft and drops it', A, { type: 'commit' }, null, A],
    ['commit with no draft sends nothing', null, { type: 'commit' }, null, null],
    ['focus on the same row keeps the draft', A, { type: 'focus', key: 'f0:v0' }, A, null],
    ['focus moving to another row commits', A, { type: 'focus', key: 'f0:v1' }, null, A],
    ['focus with no draft does nothing', null, { type: 'focus', key: 'f0:v1' }, null, null],
    ['escape drops the draft unsent', A, { type: 'escape' }, null, null],
    ['escape with no draft does nothing', null, { type: 'escape' }, null, null],
    ['rows still taking input keep the draft', A, rows('f0:v0', 'f0:v1'), A, null],
    ['a row that no longer takes input drops the draft unsent', A, rows('f0:v1'), null, null],
    ['rows with no draft do nothing', null, rows(), null, null],
  ])('%s', (_name, draft, event, next, send) => {
    expect(transition(draft, event)).toEqual({ draft: next, send });
  });

  it('a step that changes nothing returns the same draft object', () => {
    expect(transition(A, { type: 'focus', key: 'f0:v0' }).draft).toBe(A);
    expect(transition(A, rows('f0:v0')).draft).toBe(A);
  });
});
