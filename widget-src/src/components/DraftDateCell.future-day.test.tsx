// @vitest-environment jsdom
/**
 * US-03 AC1a: the New column of either grid never takes a day that has not
 * happened. Its picker offers no day after today, and a day typed or handed
 * in past today is not taken: the column keeps its day. Synthetic values, on
 * a clock held at local noon on 26 Nov 2026, so the days are the same in
 * every time zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { BloodTestTimeline, type BloodTestPrefillFn } from './BloodTestTimeline';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { DraftDateCell } from './DraftDateCell';
import { typeInto } from '../testing/matrix-gestures';
import { noteDevicePage } from '../lib/storage';

// This page's record is open, on this device: the drafts it keeps are its own (US-11 AC6).
noteDevicePage();

const [PAST, TODAY, TOMORROW, YEAR_TYPO] = ['2026-08-15', '2026-11-26', '2026-11-27', '2099-03-15'];

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 26, 12) }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pick = (input: HTMLInputElement, day: string) => fireEvent.change(input, { target: { value: day } });
/** Keys typed into the focused date as Chrome sends them, a whole day per key; each must show as typed (B1). */
const CHROME_12152025 = ['2026-01-26', '2026-12-26', '2026-12-01', '2026-12-15', '0002-12-15', '0020-12-15', '0202-12-15', '2025-12-15'];
const CHROME_11272026 = ['2026-01-26', '2026-11-26', '2026-11-02', '2026-11-27', '0002-11-27', '0020-11-27', '0202-11-27', TOMORROW];
const CHROME_03152099 = ['', '2026-03-26', '2026-03-01', '2026-03-15', '0002-03-15', '0020-03-15', '0209-03-15', YEAR_TYPO];
function typeKeys(input: HTMLInputElement, values: string[]) {
  act(() => input.focus());
  for (const value of values) { pick(input, value); expect(input.value).toBe(value); }
  act(() => input.blur());
}
const draftCell = (root: HTMLElement, label: string) => Array.from(root.querySelectorAll('.bt-row'))
  .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!.querySelector('.bt-cell-draft input') as HTMLInputElement;

function bloodGrid() {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const view = render(<BloodTestTimeline bloodTestHistory={[]} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={() => ({ from: 'si', to: 'conventional' })}
    onSaveBatch={onSaveBatch} onCorrectValue={vi.fn()} isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>);
  return { view, onSaveBatch, prefillRef, date: view.getByLabelText('Choose draft batch date') as HTMLInputElement };
}

describe('US-03 AC1a: the New column never takes a day that has not happened', () => {
  it('blood tests: the picker stops at today; tomorrow and a year typo are not taken, today and a past day are', async () => {
    const { view, onSaveBatch, date } = bloodGrid();
    const ldl = draftCell(view.container, 'LDL Cholesterol');
    typeInto(ldl, '3.2');
    pick(date, PAST);
    expect(date.value).toBe(PAST);
    pick(date, TOMORROW);
    expect(date.value).toBe(PAST);
    pick(date, YEAR_TYPO);
    expect(date.value).toBe(PAST);
    pick(date, TODAY);
    expect(date.value).toBe(TODAY);
    pick(date, TOMORROW);
    fireEvent.keyDown(ldl, { key: 'Enter' });
    await wait(0);
    expect(onSaveBatch).toHaveBeenCalledTimes(1);
    expect(onSaveBatch.mock.calls[0][0]).toEqual([expect.objectContaining({ date: TODAY, values: { ldl: 3.2 } })]);
    expect(date.max).toBe(TODAY);
  });

  it('blood tests: a chat value dated after today is typed into the New column, which keeps its day', () => {
    const { view, prefillRef, date } = bloodGrid();
    act(() => { prefillRef.current!('ldl', 3.2, 'si', YEAR_TYPO); });
    expect(draftCell(view.container, 'LDL Cholesterol').value).toBe('3.2');
    expect(date.value).toBe(TODAY);
  });

  it('vitals: the picker stops at today, tomorrow is not taken, and a chat waist dated after today keeps the column\'s day', () => {
    const prefillRef: MutableRefObject<VitalsPrefillFn | null> = { current: null };
    const view = render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={4}
      prefillRef={prefillRef} plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
    const date = view.getByLabelText('Choose draft date') as HTMLInputElement;
    typeInto(draftCell(view.container, 'Weight'), '80');
    pick(date, TOMORROW);
    expect(date.value).toBe(TODAY);
    pick(date, PAST);
    expect(date.value).toBe(PAST);
    act(() => { prefillRef.current!('waist', 90, 'si', YEAR_TYPO); });
    expect(draftCell(view.container, 'Waist Circumference').value).toBe('90');
    expect(date.value).toBe(PAST);
    expect(date.max).toBe(TODAY);
  });

  it('blood tests, keyboard: a past day typed key by key is taken as typed, and tomorrow typed so is not', async () => {
    const { view, onSaveBatch, date } = bloodGrid();
    const ldl = draftCell(view.container, 'LDL Cholesterol');
    typeInto(ldl, '3.2');
    typeKeys(date, CHROME_11272026);
    expect(date.value).toBe(TODAY);
    typeKeys(date, CHROME_12152025);
    fireEvent.keyDown(ldl, { key: 'Enter' });
    await wait(0);
    expect(onSaveBatch.mock.calls).toEqual([[[expect.objectContaining({ date: '2025-12-15', values: { ldl: 3.2 } })]]]);
  });

  it('vitals, keyboard: a year typo typed key by key is not taken, and a past day typed so is', () => {
    const date = render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={4}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>).getByLabelText('Choose draft date') as HTMLInputElement;
    typeKeys(date, CHROME_03152099);
    expect(date.value).toBe(TODAY);
    typeKeys(date, CHROME_12152025);
    expect(date.value).toBe('2025-12-15');
  });

  it('the day typed is handed on once, when the focus leaves; a focus with nothing typed hands on nothing', () => {
    const onChange = vi.fn(), date = render(<DraftDateCell date={PAST} onChange={onChange} ariaLabel="Choose date"/>).getByLabelText('Choose date') as HTMLInputElement;
    act(() => date.focus());
    act(() => date.blur());
    typeKeys(date, CHROME_12152025);
    expect(onChange.mock.calls).toEqual([['2025-12-15']]);
    expect(date.value).toBe(PAST);
  });

  it('a saved column\'s header (US-04 AC5) shares the picker, so it stops at today too', () => {
    const view = render(<DraftDateCell date={PAST} onChange={() => {}} className="bt-cell-movable" ariaLabel="Change this test's date"/>);
    expect((view.getByLabelText("Change this test's date") as HTMLInputElement).max).toBe(TODAY);
  });
});
