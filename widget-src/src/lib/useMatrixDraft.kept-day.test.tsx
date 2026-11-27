// @vitest-environment jsdom
// US-03 AC5a: a draft kept on this device under a day the calendar does not have comes back in today's
// column, its typed values kept. Synthetic values, on a clock held at local noon on 26 Nov 2026.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { BloodTestTimeline } from '../components/BloodTestTimeline';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { BT_TIMELINE_DRAFT_KEY, VITALS_DRAFT_KEY, noteDevicePage } from './storage';

// This page's record is open, on this device: the drafts it keeps are its own (US-11 AC6).
noteDevicePage();

const TODAY = '2026-11-26';

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 26, 12) }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const keep = (key: string, date: string, values: Record<string, string>) =>
  localStorage.setItem(key, JSON.stringify({ draft: { date, values }, backfills: {}, meta: {} }));
const draftCell = (root: HTMLElement, label: string) => [...root.querySelectorAll('.bt-row')]
  .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!.querySelector('.bt-cell-draft input') as HTMLInputElement;
/** The New column's header as a person reads it: its day and month. */
const header = (root: HTMLElement) => root.querySelector('.bt-cell-draft-date .bt-date-day')?.textContent;

function bloodGrid() {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const view = render(<BloodTestTimeline bloodTestHistory={[]} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={() => ({ from: 'si', to: 'conventional' })}
    onSaveBatch={onSaveBatch} onCorrectValue={vi.fn()} isSaving={false} grading={{}} hasApiResponse/>);
  return { view, onSaveBatch, date: view.getByLabelText('Choose draft batch date') as HTMLInputElement };
}

describe('US-03 AC5a: a kept draft whose day the calendar does not have comes back under today', () => {
  it.each([
    ['30 February', '2026-02-30', TODAY, '26 Nov'],
    ['31 February', '2024-02-31', TODAY, '26 Nov'],
    ['an all-zero day', '0000-00-00', TODAY, '26 Nov'],
    ['a leap day, which is kept', '2024-02-29', '2024-02-29', '29 Feb'],
  ])('blood tests, %s: the column, its header and the save use the right day, the HDL typed is kept', async (_, kept, day, shown) => {
    keep(BT_TIMELINE_DRAFT_KEY, kept, { hdl: '1.4' });
    const { view, onSaveBatch, date } = bloodGrid();
    const hdl = draftCell(view.container, 'HDL Cholesterol');
    expect([date.value, header(view.container), hdl.value]).toEqual([day, shown, '1.4']);
    fireEvent.keyDown(hdl, { key: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(onSaveBatch.mock.calls).toEqual([[[expect.objectContaining({ date: day, values: { hdl: 1.4 } })]]]);
  });

  it('US-03 AC5: a kept draft with no New column part keeps the values typed under a saved day', () => {
    const backfills = { '2026-08-15': { hdl: '1.4' } };
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ backfills, meta: {} }));
    const { date } = bloodGrid();
    expect([date.value, JSON.parse(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)!).backfills]).toEqual([TODAY, backfills]);
  });

  it('vitals, 29 February of a year that has none: the column is today\'s and the weight typed is kept and saved under today', async () => {
    keep(VITALS_DRAFT_KEY, '2025-02-29', { weight: '80' });
    const onSave: Mock = vi.fn().mockResolvedValue(new Map());
    const view = render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={onSave} onCorrectValue={vi.fn()} formStage={4}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
    const weight = draftCell(view.container, 'Weight');
    expect([(view.getByLabelText('Choose draft date') as HTMLInputElement).value, header(view.container), weight.value]).toEqual([TODAY, '26 Nov', '80']);
    fireEvent.keyDown(weight, { key: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(onSave.mock.calls[0][0].map((t: { date: string }) => t.date)).toEqual([TODAY]);
  });
});
