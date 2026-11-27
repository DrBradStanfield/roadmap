// @vitest-environment jsdom
// US-03 AC1a: nothing in either grid's New column is saved under a day that has not happened; its typed cells say so.
// Synthetic values, on a clock held at local noon on 26 Nov 2026, so the days are the same in every time zone.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { BloodTestTimeline, type BloodTestPrefillFn } from './BloodTestTimeline';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { DraftDateCell } from './DraftDateCell';
import { pressMouse, releaseMouse, typeInto } from '../testing/matrix-gestures';
import { BT_TIMELINE_DRAFT_KEY, noteDevicePage } from '../lib/storage';

// This page's record is open, on this device: the drafts it keeps are its own (US-11 AC6).
noteDevicePage();

const [PAST, TODAY, TOMORROW, YEAR_TYPO] = ['2026-08-15', '2026-11-26', '2026-11-27', '2099-03-15'];
const NOT_YET = 'That day has not happened yet.';

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 26, 12) }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pick = (input: HTMLInputElement, day: string) => fireEvent.change(input, { target: { value: day } });
/** Keys typed into the focused date as Chrome sends them, a whole day per key (adversary B1). */
const CHROME_12152025 = ['2026-01-26', '2026-12-26', '2026-12-01', '2026-12-15', '0002-12-15', '0020-12-15', '0202-12-15', '2025-12-15'];
const CHROME_11272026 = ['2026-01-26', '2026-11-26', '2026-11-02', '2026-11-27', '0002-11-27', '0020-11-27', '0202-11-27', TOMORROW];
const CHROME_03152099 = ['2026-03-26', '2026-03-01', '2026-03-15', '0002-03-15', '0020-03-15', '0209-03-15', YEAR_TYPO];
/** Each key's value stays as Chrome sent it: nothing is put back under the caret. The focus stays in the date. */
function typeKeys(input: HTMLInputElement, values: string[]) {
  act(() => input.focus());
  for (const value of values) { pick(input, value); expect(input.value).toBe(value); }
  expect(document.activeElement).toBe(input);
}
const draftCell = (root: HTMLElement, label: string) => [...root.querySelectorAll('.bt-row')].find((r) => r.querySelector('.bt-name-label')?.textContent === label)!.querySelector('.bt-cell-draft input') as HTMLInputElement;
const shown = (root: HTMLElement) => [...root.querySelectorAll('.bt-cell-draft')].filter((c) => c.textContent?.includes(NOT_YET)).length;

function bloodGrid() {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const view = render(<BloodTestTimeline bloodTestHistory={[]} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={() => ({ from: 'si', to: 'conventional' })}
    onSaveBatch={onSaveBatch} onCorrectValue={vi.fn()} isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>);
  return { view, onSaveBatch, prefillRef, date: view.getByLabelText('Choose draft batch date') as HTMLInputElement };
}

describe('US-03 AC1a: nothing in the New column is saved under a day that has not happened', () => {
  it('blood tests: the picker stops at today; under tomorrow or a year typo the typed cell says so and Enter saves nothing; today saves', async () => {
    const { view, onSaveBatch, date } = bloodGrid(), ldl = draftCell(view.container, 'LDL Cholesterol');
    typeInto(ldl, '3.2');
    for (const day of [TOMORROW, YEAR_TYPO]) {
      pick(date, day);
      expect(date.value).toBe(day);
      expect(shown(view.container)).toBe(1); // the typed cell only, not the empty ones
      expect(view.queryByLabelText('Save typed values')).toBeNull();
      fireEvent.keyDown(ldl, { key: 'Enter' });
      await wait(0);
    }
    expect(onSaveBatch).not.toHaveBeenCalled();
    pick(date, TODAY);
    expect(shown(view.container)).toBe(0);
    onSaveBatch.mockResolvedValueOnce(new Map([[`${TODAY}|ldl`, 'changed']])); // kept, with why
    fireEvent.keyDown(ldl, { key: 'Enter' });
    await wait(0);
    expect(onSaveBatch.mock.calls).toEqual([[[expect.objectContaining({ date: TODAY, values: { ldl: 3.2 } })]]]);
    pick(date, TOMORROW);
    expect(shown(view.container)).toBe(1); // the day's words, not the older refusal
    expect(date.max).toBe(TODAY);
  });

  it('blood tests, keyboard, then the tick with the focus still in the date (B2): saved under the past day typed; tomorrow typed, no tick', async () => {
    const { view, onSaveBatch, date } = bloodGrid();
    typeInto(draftCell(view.container, 'LDL Cholesterol'), '3.2');
    typeKeys(date, CHROME_11272026);
    expect(shown(view.container)).toBe(1);
    expect(view.queryByLabelText('Save typed values')).toBeNull();
    typeKeys(date, CHROME_12152025);
    const tick = view.getByLabelText('Save typed values');
    pressMouse(tick); releaseMouse(tick); // the tick cancels its mousedown, so the focus stays in the date box
    expect(document.activeElement).toBe(date);
    await wait(0);
    expect(onSaveBatch.mock.calls).toEqual([[[expect.objectContaining({ date: '2025-12-15', values: { ldl: 3.2 } })]]]);
  });

  it('blood tests: a chat value dated after today, or a kept draft with such a day, shows that day and is not saved', async () => {
    const { view, onSaveBatch, prefillRef, date } = bloodGrid();
    act(() => { prefillRef.current!('ldl', 3.2, 'si', YEAR_TYPO); });
    expect([draftCell(view.container, 'LDL Cholesterol').value, date.value, shown(view.container)]).toEqual(['3.2', YEAR_TYPO, 1]);
    fireEvent.keyDown(draftCell(view.container, 'LDL Cholesterol'), { key: 'Enter' });
    cleanup();
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ draft: { date: YEAR_TYPO, values: { hdl: '1.4' } }, backfills: {}, meta: {} }));
    const kept = bloodGrid();
    expect([kept.date.value, shown(kept.view.container)]).toEqual([YEAR_TYPO, 1]);
    fireEvent.keyDown(draftCell(kept.view.container, 'HDL Cholesterol'), { key: 'Enter' });
    await wait(0);
    expect([onSaveBatch, kept.onSaveBatch].map((save) => save.mock.calls.length)).toEqual([0, 0]);
  });

  it('vitals: the picker stops at today; under a year typo typed key by key, a weight, a chat waist and a blood pressure are not saved; under a past day typed, they are', async () => {
    const onSave: Mock = vi.fn().mockResolvedValue(new Map());
    const prefillRef: MutableRefObject<VitalsPrefillFn | null> = { current: null };
    const view = render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={onSave} onCorrectValue={vi.fn()} formStage={4}
      prefillRef={prefillRef} plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
    const [date, weight] = [view.getByLabelText('Choose draft date') as HTMLInputElement, draftCell(view.container, 'Weight')];
    typeInto(weight, '80');
    act(() => date.focus());
    pick(date, ''); // Chrome's first key of 03152099: no whole day yet, so the column keeps its day
    expect(date.value).toBe(TODAY);
    typeKeys(date, CHROME_03152099);
    expect(shown(view.container)).toBe(1); // the weight, not the empty cells
    fireEvent.change(view.getByRole('textbox', { name: 'Systolic blood pressure' }), { target: { value: '120' } });
    expect(shown(view.container)).toBe(2); // one half of the pair typed
    act(() => { prefillRef.current!('waist', 90, 'si', YEAR_TYPO); });
    fireEvent.change(view.getByRole('textbox', { name: 'Diastolic blood pressure' }), { target: { value: '80' } });
    expect(shown(view.container)).toBe(3);
    fireEvent.keyDown(weight, { key: 'Enter' });
    await wait(0);
    expect(onSave).not.toHaveBeenCalled();
    typeKeys(date, CHROME_12152025);
    expect(shown(view.container)).toBe(0);
    fireEvent.keyDown(weight, { key: 'Enter' });
    await wait(0);
    expect(onSave.mock.calls[0][0].map((t: { date: string }) => t.date)).toEqual(['2025-12-15', '2025-12-15', '2025-12-15']);
    expect(date.max).toBe(TODAY);
  });

  it('a saved column\'s header (US-04 AC5) shares the picker, so it stops at today too', () => {
    const view = render(<DraftDateCell date={PAST} onChange={() => {}} className="bt-cell-movable" ariaLabel="Change this test's date"/>);
    expect((view.getByLabelText("Change this test's date") as HTMLInputElement).max).toBe(TODAY);
  });
});
