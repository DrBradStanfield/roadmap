// @vitest-environment jsdom
// US-16 AC1b: the New column's date, set by the chat's pre-fill (setDate), never takes a day the calendar
// does not have; the column keeps its day. Synthetic values, on a clock held at local noon on 26 Nov 2026.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useMatrixDraft } from './useMatrixDraft';

const TODAY = '2026-11-26';
const NO_SUCH_DAY = ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '0000-00-00'];

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 26, 12) }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const grid = () => renderHook(() => useMatrixDraft<'hdl'>('test-set-date-draft', { onScreen: () => false, rowsUnder: () => ({}) })).result;

describe('US-16 AC1b: setDate keeps the column\'s day when handed a day the calendar does not have', () => {
  it.each(NO_SUCH_DAY)('%s: an unpicked column stays today\'s; a picked one keeps the day picked', (day) => {
    const draft = grid();
    act(() => draft.current.setDate(day));
    expect(draft.current.draft.date).toBe(TODAY);
    act(() => draft.current.setDate('2026-08-15'));
    act(() => draft.current.setDate(day));
    expect(draft.current.draft.date).toBe('2026-08-15');
  });

  it.each(['2024-02-29', '2026-02-28', '2026-04-30'])('a real day, %s, is taken', (day) => {
    const draft = grid();
    act(() => draft.current.setDate(day));
    expect(draft.current.draft.date).toBe(day);
  });
});
