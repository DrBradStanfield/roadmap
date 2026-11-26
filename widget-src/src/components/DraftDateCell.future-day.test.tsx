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

  it('a saved column\'s header (US-04 AC5) shares the picker, so it stops at today too', () => {
    const view = render(<DraftDateCell date={PAST} onChange={() => {}} className="bt-cell-movable" ariaLabel="Change this test's date"/>);
    expect((view.getByLabelText("Change this test's date") as HTMLInputElement).max).toBe(TODAY);
  });
});
