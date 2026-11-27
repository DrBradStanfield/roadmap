// US-16 AC1b: a chat edit dated to a day the calendar does not have is refused where the edit is
// parsed, the way an edit whose date is not YYYY-MM-DD already is. Synthetic values.
import { describe, expect, it } from 'vitest';
import { parseProposedEdit, parseProposedEdits, readProposedEdits } from './chat-edits';
import { CHAT_VALUES_UNREADABLE, refuseUnreadableEdits } from './chat-edit-refusals';
import { roadmapToolResults } from './run-roadmap';

const FIELD = 'propose_field_edit';
const NO_SUCH_DAY = ['2026-02-30', '2026-02-29', '2025-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '0000-00-00'];
const REAL_DAY = ['2024-02-29', '2026-02-28', '2026-04-30', '2026-12-31'];
const ldl = (date?: string) => ({ field: 'ldlC', value: 3.1, unit: 'mmol/L', ...(date ? { date } : {}) });
const received = (date: string | null) => ({ kind: 'field', field: 'ldlC', displayValue: 3.1, unitSystem: 'si', date });
const statin = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' };

describe('US-16 AC1b: a chat edit dated a day the calendar does not have is refused', () => {
  it.each(NO_SUCH_DAY)('the server parser drops a field edit dated %s', (day) => {
    expect(parseProposedEdit(FIELD, ldl(day))).toBeNull();
  });

  it.each(REAL_DAY)('the server parser keeps a field edit dated %s, with its day', (day) => {
    expect(parseProposedEdit(FIELD, ldl(day))).toMatchObject({ kind: 'field', field: 'ldlC', date: day });
  });

  it('no date is still today (null); one bad-dated edit in a reply drops alone', () => {
    expect(parseProposedEdit(FIELD, ldl())).toMatchObject({ date: null });
    const edits = parseProposedEdits([
      { type: 'tool_use', name: FIELD, input: ldl('2026-02-30') },
      { type: 'tool_use', name: FIELD, input: { field: 'weightKg', value: 80, unit: 'kg', date: '2026-02-28' } },
    ]);
    expect(edits).toEqual([{ kind: 'field', field: 'weightKg', displayValue: 80, unitSystem: 'si', date: '2026-02-28' }]);
  });

  it('the model is told "Not applied" for it, on the web and in the app', () => {
    const blocks = [{ type: 'tool_use' as const, id: 'r', name: 'run_roadmap', input: { values: [] } }, { type: 'tool_use' as const, id: 'x', name: FIELD, input: ldl('2026-02-30') }];
    for (const app of [false, true]) {
      const content = roadmapToolResults(blocks, {}, undefined, app)!.results.find((r) => r.tool_use_id === 'x')!.content;
      expect(content).toMatch(/^Not applied: the edit did not pass the/);
    }
  });

  it.each(NO_SUCH_DAY)('a reply read by a client: a field dated %s refuses the values part, the medication still applies', (day) => {
    const read = readProposedEdits([received(day), statin]);
    expect(read.invalid).toEqual(['field']);
    expect(refuseUnreadableEdits(read)).toEqual({ edits: [statin], refusals: [{ part: 'review', words: CHAT_VALUES_UNREADABLE }] });
  });

  it.each([...REAL_DAY, null])('a reply read by a client: a field dated %s is read as it came', (day) => {
    expect(readProposedEdits([received(day)])).toEqual({ edits: [received(day)], invalid: [] });
  });

  it('the same refusals as a date that is not YYYY-MM-DD, as before', () => {
    for (const day of ['2026-2-3', '2026-02-30']) {
      expect(parseProposedEdit(FIELD, ldl(day))).toBeNull();
      expect(readProposedEdits([received(day), statin])).toEqual({ edits: [statin], invalid: ['field'] });
    }
  });
});
