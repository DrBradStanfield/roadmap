// @vitest-environment jsdom
/**
 * The saved-value editor every matrix shares, and what the blood-test matrix
 * does with what is typed in it: a draft, kept on the device as typed, that
 * reaches the record only when the user commits it (US-03, US-04).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import { localDay, toCanonicalValue, type ApiMeasurement } from '@roadmap/health-core';
import { BloodTestTimeline, ValueCell } from './BloodTestTimeline';
import { hidePage, pickDraftDate, press, showPage, typeInto, typeWithoutTap } from '../testing/matrix-gestures';
import { slotOf, type Refused, type SaveTask } from '../lib/matrix-save';
import { recordReread } from '../lib/useMatrixDraft';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  showPage();
  vi.useRealTimers();
});

/** Time passes, and the promises it settles run. */
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const noop = () => {};
function editor(props: Partial<Parameters<typeof ValueCell>[0]> = {}) {
  const onCorrect = vi.fn().mockResolvedValue('ok');
  const view = render(
    <ValueCell metric="ldl" display="si" value={3.2} rowId="r1" status="ok" pinned={false} onCorrect={onCorrect} {...props}/>,
  );
  fireEvent.click(view.getByRole('button'));
  const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
  return { view, input, onCorrect };
}

describe('US-04 — the saved-value editor', () => {
  it('an emptied editor cancels on Enter and writes nothing', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it('an emptied editor cancels on click-away too', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await wait(200);
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it('an emptied lab editor cancels as well', async () => {
    const { view, input, onCorrect } = editor({ metric: undefined, display: undefined, value: 45 });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await wait(200);
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it('US-03 AC3: the number already saved, typed again, writes nothing', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
  });

  it('US-03 AC3: 3.24 typed over a displayed 3.2 is a correction, not rounded away', async () => {
    const { input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.24' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.24);
  });

  it('US-03 AC3: a lab value re-entered as displayed (1.17 over a stored 1.1655) writes nothing', async () => {
    const { view, input, onCorrect } = editor({ metric: undefined, display: undefined, value: 1.1655 });
    expect(input.value).toBe('1.17');
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
  });

  it('a changed number is a correction, in the unit it is stored in', async () => {
    const { input, onCorrect } = editor({ display: 'conventional', value: 3.2 });
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', toCanonicalValue('ldl', 100, 'conventional'));
  });

  it('a lab value is corrected in the unit it is stored in, as typed', async () => {
    const { input, onCorrect } = editor({ metric: undefined, display: undefined, value: 45 });
    expect(input.value).toBe('45');
    fireEvent.change(input, { target: { value: '54' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 54);
  });

  it('a value the record refuses keeps the editor open with the reason', async () => {
    const { view, input, onCorrect } = editor();
    onCorrect.mockResolvedValue('invalid');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(view.getByText('That value is outside the range this record takes.')).toBeTruthy();
  });

  // US-04 AC1 (round 5): the correction names the row the editor opened
  // on, and the store refuses it if another writer has replaced that row.
  it('corrects the row it opened on, though the cell has since been given another', async () => {
    const { view, input, onCorrect } = editor();
    view.rerender(<ValueCell metric="ldl" display="si" value={2.5} rowId="r2" status="ok" pinned={false} onCorrect={onCorrect}/>);
    fireEvent.change(input, { target: { value: '3.3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.3);
  });

  it('a value replaced elsewhere closes the editor, and the cell says the edit was not saved', async () => {
    const { view, input, onCorrect } = editor();
    onCorrect.mockResolvedValue('changed');
    fireEvent.change(input, { target: { value: '3.3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(view.getByText('This value changed on another device, so your edit was not saved.')).toBeTruthy();
  });

  it('offers no editor to a caller with no correction handler (read-only)', () => {
    const view = render(<ValueCell value={45} rowId="r1" status={null} pinned={false}/>);
    expect(view.queryByRole('button')).toBeNull();
  });
});

function history(rows: Array<[string, number, string]>): ApiMeasurement[] {
  return rows.map(([metricType, value, day], i) => ({
    id: `row${i}`, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, status: 'active',
  }));
}
/** The matrix on a page, with a control and some text outside it. */
function matrix(rows: ApiMeasurement[] = [], onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map()), onFieldChange: () => void = noop) {
  const view = render(
    <>
      <BloodTestTimeline bloodTestHistory={rows} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={noop}
        onSaveBatch={onSaveBatch} onCorrectValue={vi.fn()} onFieldChange={onFieldChange}
        isSaving={false} hasApiResponse/>
      <button type="button">Elsewhere</button>
      <p>Page text</p>
    </>,
  );
  const root = view.container.querySelector('.bt-timeline') as HTMLElement;
  const header = view.container.querySelector('.bt-header-row') as HTMLElement;
  const row = (label: string) => Array.from(view.container.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === label) as HTMLElement;
  const cell = (label: string) => row(label).querySelector('.bt-cell-draft input') as HTMLInputElement;
  /** A saved column's empty cell for that test. */
  const backfill = (label: string) => row(label).querySelector('.bt-cell-backfill input') as HTMLInputElement;
  const dateCell = header.querySelector('.bt-cell-draft-date') as HTMLButtonElement;
  const dateInput = dateCell.querySelector('input[type="date"]') as HTMLInputElement;
  const elsewhere = view.getByRole('button', { name: 'Elsewhere' });
  const text = view.getByText('Page text');
  /** A tap on text outside the matrix: nothing there takes the focus. */
  const tapText = (pointerId = 1) => {
    fireEvent.pointerDown(text, { pointerId });
    fireEvent.pointerUp(text, { pointerId });
  };
  return { view, root, header, row, cell, backfill, dateCell, dateInput, elsewhere, text, tapText, onSaveBatch };
}
/** What one save sent: these tasks, in any order, each as far as it is given. */
function expectSent(onSaveBatch: Mock, call: number, tasks: Array<Partial<SaveTask>>) {
  expect(onSaveBatch.mock.calls[call][0]).toHaveLength(tasks.length);
  expect(onSaveBatch.mock.calls[call][0]).toEqual(expect.arrayContaining(tasks.map((t) => expect.objectContaining(t))));
}
const TODAY = localDay(new Date());
const SAME_SLOT = 'This test already has a value on that day in another column.';

describe('US-03 — the draft', () => {
  beforeEach(() => { localStorage.clear(); });

  it('is labelled as new, so it never repeats a saved column’s header', () => {
    const { header } = matrix(history([['ldl', 3.2, TODAY]]));
    const [saved, draft] = [header.querySelector('.bt-cell-date')!, header.querySelector('.bt-cell-draft-date')!];
    expect(within(draft as HTMLElement).getByText('New')).toBeTruthy();
    expect(draft.textContent).not.toBe(saved.textContent);
  });

  it('keeps typed values when the save does not land, says so, and a retry clears both (US-03 AC4)', async () => {
    const m = matrix([], vi.fn().mockResolvedValueOnce(new Map([[slotOf(TODAY, 'ldl'), 'error']])).mockResolvedValueOnce(new Map()));
    const draft = m.cell('LDL Cholesterol');
    typeInto(draft, '3.2');
    fireEvent.keyDown(draft, { key: 'Enter' });
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalled();
    expect(draft.value).toBe('3.2');
    expect(m.view.getByText('Some values did not save. Try again.')).toBeTruthy();

    fireEvent.keyDown(draft, { key: 'Enter' });
    await wait(0);
    expect(m.cell('LDL Cholesterol').value).toBe('');
    expect(m.view.queryByText('Some values did not save. Try again.')).toBeNull();
  });

  // US-03 AC3 (review of 2026-09-24): the draft dated onto a saved column, and
  // that column's empty cell, can name one test on one day. Neither is sent
  // while both hold a value; the rest of the draft is.
  it('two cells for one test on one day are an error on both, and neither is sent until one is cleared', async () => {
    const m = matrix(history([['hdl', 1.4, '2026-08-15']]));
    typeInto(m.backfill('LDL Cholesterol'), '3.1');
    pickDraftDate(m.root, '2026-08-15');
    typeInto(m.cell('LDL Cholesterol'), '3.4');
    typeInto(m.cell('Triglycerides'), '1.1');
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: '2026-08-15', values: { triglycerides: 1.1 } }]);
    expect(within(m.row('LDL Cholesterol')).getAllByText(SAME_SLOT)).toHaveLength(2);
    expect(m.cell('LDL Cholesterol').value).toBe('3.4');
    expect(m.backfill('LDL Cholesterol').value).toBe('3.1');

    typeInto(m.backfill('LDL Cholesterol'), '');
    expect(within(m.row('LDL Cholesterol')).queryByText(SAME_SLOT)).toBeNull();
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 1, [{ date: '2026-08-15', values: { ldl: 3.4 } }]);
  });

  it('a cell the test cannot take stays, with its error; the others are sent', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    typeInto(m.cell('HDL Cholesterol'), '99');
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }]);
    expect(m.cell('LDL Cholesterol').value).toBe('');
    expect(m.cell('HDL Cholesterol').value).toBe('99');
    expect(m.cell('HDL Cholesterol').getAttribute('aria-invalid')).toBe('true');
    expect(m.view.getByText('Fix invalid values')).toBeTruthy();
  });

  // A draft now outlives the page, so a saved column's empty cell can be
  // filled elsewhere (another device, a connector) while what was typed into
  // it waits. The cell is gone from the screen; what was typed never commits.
  it('never commits a cell that has since been filled elsewhere, and is no longer on screen', async () => {
    const m = matrix(history([['hdl', 1.4, '2026-08-15']]));
    typeInto(m.backfill('LDL Cholesterol'), '3.1');
    typeInto(m.cell('Triglycerides'), '1.1');
    m.view.rerender(
      <>
        <BloodTestTimeline bloodTestHistory={history([['hdl', 1.4, '2026-08-15'], ['ldl', 2.9, '2026-08-15']])} unitSystem="si"
          unitOverrides={{}} onToggleFieldUnit={noop} onSaveBatch={m.onSaveBatch} onCorrectValue={vi.fn()} onFieldChange={noop}
          isSaving={false} hasApiResponse/>
        <button type="button">Elsewhere</button>
        <p>Page text</p>
      </>,
    );
    expect(m.backfill('LDL Cholesterol')).toBeNull();
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { triglycerides: 1.1 } }]);
  });

  // US-03 AC2 (review of 2026-09-24, round 3; round 5): the same fill
  // reaches the draft's own slot. The cell shows the clash, and every commit
  // sends it naming the empty slot it was typed against, however often it is
  // typed again, so the record refuses it (Codex R1). Emptied and typed
  // again, it names the row now on screen.
  it('a draft value whose slot was filled elsewhere since it was typed shows the clash, and names the empty slot it was typed against until it is emptied', async () => {
    const filled = history([['hdl', 1.4, '2026-08-15'], ['ldl', 2.9, '2026-08-15']]); // the LDL is row1
    const refusedAsChanged = new Map([[slotOf('2026-08-15', 'ldl'), 'changed']]); // as the store answers
    const m = matrix(history([['hdl', 1.4, '2026-08-15']]), vi.fn().mockResolvedValueOnce(refusedAsChanged).mockResolvedValue(new Map()));
    pickDraftDate(m.root, '2026-08-15');
    typeInto(m.cell('LDL Cholesterol'), '3.4');
    m.view.rerender(
      <>
        <BloodTestTimeline bloodTestHistory={filled} unitSystem="si"
          unitOverrides={{}} onToggleFieldUnit={noop} onSaveBatch={m.onSaveBatch} onCorrectValue={vi.fn()} onFieldChange={noop}
          isSaving={false} hasApiResponse/>
        <button type="button">Elsewhere</button>
        <p>Page text</p>
      </>,
    );
    expect(within(m.row('LDL Cholesterol')).getByText(SAME_SLOT)).toBeTruthy();

    typeInto(m.cell('LDL Cholesterol'), '3.5'); // typed again
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: '2026-08-15', values: { ldl: 3.5 }, expected: { ldl: null } }]);
    expect(within(m.row('LDL Cholesterol')).getByText(SAME_SLOT)).toBeTruthy();

    typeInto(m.cell('LDL Cholesterol'), '');
    typeInto(m.cell('LDL Cholesterol'), '3.6'); // with 2.9 on screen
    expect(within(m.row('LDL Cholesterol')).queryByText(SAME_SLOT)).toBeNull();
    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 1, [{ date: '2026-08-15', values: { ldl: 3.6 }, expected: { ldl: 'row1' } }]);
  });

  // Round 5: a saved column's cell refused because another writer filled its
  // slot leaves the screen once the page shows that value. Nothing is left
  // for the user to fix, so the matrix no longer says a save failed.
  it('a refused cell that has left the screen no longer holds up the "did not save" line', async () => {
    const refusedAsChanged = new Map([[slotOf('2026-08-15', 'ldl'), 'changed']]);
    const m = matrix(history([['hdl', 1.4, '2026-08-15']]), vi.fn().mockResolvedValue(refusedAsChanged));
    typeInto(m.backfill('LDL Cholesterol'), '3.1');
    press(m.elsewhere);
    await wait(0);
    expect(m.view.getByText('Some values did not save. Try again.')).toBeTruthy();
    m.view.rerender(
      <>
        <BloodTestTimeline bloodTestHistory={history([['hdl', 1.4, '2026-08-15'], ['ldl', 2.9, '2026-08-15']])} unitSystem="si"
          unitOverrides={{}} onToggleFieldUnit={noop} onSaveBatch={m.onSaveBatch} onCorrectValue={vi.fn()} onFieldChange={noop}
          isSaving={false} hasApiResponse/>
        <button type="button">Elsewhere</button>
        <p>Page text</p>
      </>,
    );
    expect(m.backfill('LDL Cholesterol')).toBeNull();
    expect(m.view.queryByText('Some values did not save. Try again.')).toBeNull();
  });

  it('keeps a typed draft across a reload, unsaved', () => {
    const first = matrix();
    typeInto(first.cell('LDL Cholesterol'), '3.2');
    first.view.unmount();
    const again = matrix();
    expect(again.cell('LDL Cholesterol').value).toBe('3.2');
    expect(again.dateInput.value).toBe(TODAY);
    expect(first.onSaveBatch).not.toHaveBeenCalled();
  });

  it('leaves the device only once the save is accepted, not when it starts', async () => {
    let accept: (refused: Refused) => void = noop;
    const first = matrix([], vi.fn(() => new Promise<Refused>((resolve) => { accept = resolve; })));
    typeInto(first.cell('LDL Cholesterol'), '3.2');
    press(first.elsewhere);
    await wait(0);
    expect(first.onSaveBatch).toHaveBeenCalledTimes(1);
    // The same device, read while the save is still running: the draft is there.
    const whileSaving = render(<BloodTestTimeline bloodTestHistory={[]} unitSystem="si" unitOverrides={{}}
      onToggleFieldUnit={noop} onSaveBatch={vi.fn()} onFieldChange={noop} isSaving={false} hasApiResponse/>);
    const ldl = within(whileSaving.container).getByText('LDL Cholesterol').closest('.bt-row')!;
    expect((ldl.querySelector('.bt-cell-draft input') as HTMLInputElement).value).toBe('3.2');
    whileSaving.unmount();

    await act(async () => { accept(new Map()); });
    first.view.unmount();
    expect(matrix().cell('LDL Cholesterol').value).toBe('');
  });

  // Cleanup review of 2026-09-25: the matrix read the page's read of the
  // record from state React could not see, so it withdrew what it lent only
  // when something above it happened to render too.
  it('US-03 AC6: a re-read of the record takes back what the draft lent, with nothing above the matrix rendering; typing lends it again', () => {
    const onFieldChange = vi.fn();
    const m = matrix([], undefined, onFieldChange);
    typeInto(m.cell('LDL Cholesterol'), '3');
    expect(onFieldChange).toHaveBeenLastCalledWith('ldlC', 3);

    act(() => recordReread());
    expect(onFieldChange).toHaveBeenLastCalledWith('ldlC', undefined);

    typeWithoutTap(m.cell('LDL Cholesterol'), '3.0');
    expect(onFieldChange).toHaveBeenLastCalledWith('ldlC', 3);
  });
});

// US-03 AC5: what is typed commits when the user leaves the matrix, presses
// Enter or the tick; never while the user is still in it, and never because
// the page was put away.
describe('US-03 AC5 — the matrix commits when you leave it', () => {
  beforeEach(() => { localStorage.clear(); });

  it('moving from cell to cell never commits, however long it takes; leaving then commits once', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    typeInto(m.cell('HDL Cholesterol'), '1'); // on its way to 1.4
    await wait(5000);
    expect(m.onSaveBatch).not.toHaveBeenCalled();
    expect(m.cell('HDL Cholesterol').value).toBe('1');

    fireEvent.change(m.cell('HDL Cholesterol'), { target: { value: '1.4' } });
    press(m.elsewhere);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }, { date: TODAY, values: { hdl: 1.4 } }]);
  });

  it('a press outside the matrix commits, once', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    typeInto(m.cell('HDL Cholesterol'), '1.4');
    press(m.elsewhere);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }, { date: TODAY, values: { hdl: 1.4 } }]);
    await wait(5000);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
  });

  // 2026-09-24: a finger that lands outside the matrix to scroll the page is
  // not leaving it. The browser cancels a pointer that becomes a scroll, and
  // "3." saved on the way to 3.2 would have been a row, then a correction.
  it('a touch outside that turns into a scroll does not commit; a tap then commits the finished number', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.'); // on its way to 3.2
    fireEvent.pointerDown(m.text, { pointerId: 7 });
    fireEvent.pointerCancel(m.text, { pointerId: 7 }); // the page scrolls
    fireEvent.pointerUp(m.text, { pointerId: 7 });
    await wait(5000);
    expect(m.onSaveBatch).not.toHaveBeenCalled();
    expect(m.cell('LDL Cholesterol').value).toBe('3.');

    typeWithoutTap(m.cell('LDL Cholesterol'), '3.2');
    m.tapText(8);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }]);
  });

  it('a tap outside on nothing focusable commits, once', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    m.tapText(8);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }]);
    m.tapText(9);
    await wait(5000);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
  });

  // Review of 2026-09-24: iOS keeps the focus in a cell after a tap on blank
  // space, so a second value is typed with no new tap.
  it('after a commit, a value typed into the cell that kept the focus commits on the next leave', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    m.tapText(8);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(m.cell('LDL Cholesterol'));

    typeWithoutTap(m.cell('LDL Cholesterol'), '3.5');
    m.tapText(9);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(2);
    expectSent(m.onSaveBatch, 1, [{ date: TODAY, values: { ldl: 3.5 } }]);
  });

  it('a focus outside the matrix commits, once', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    act(() => m.elsewhere.focus()); // Tab
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }]);
  });

  it('Enter commits at once, and so does the tick', async () => {
    const m = matrix();
    const ldl = m.cell('LDL Cholesterol');
    typeInto(ldl, '3.2');
    fireEvent.keyDown(ldl, { key: 'Enter' });
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);

    typeInto(m.cell('HDL Cholesterol'), '1.4');
    fireEvent.click(m.view.getByRole('button', { name: 'Save typed values' }));
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(2);
  });

  // Review of 2026-09-24 (D3): the page hiding used to save, and cleared the
  // draft as its save began; a phone that never came back lost the values.
  it('the page hiding commits nothing; the draft is there when it comes back, and after a reload, to commit then', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    hidePage();
    await wait(5000);
    expect(m.onSaveBatch).not.toHaveBeenCalled();
    showPage();
    expect(m.cell('LDL Cholesterol').value).toBe('3.2');
    m.view.unmount();

    const again = matrix();
    expect(again.cell('LDL Cholesterol').value).toBe('3.2');
    press(again.cell('LDL Cholesterol'));
    press(again.elsewhere);
    await wait(0);
    expectSent(again.onSaveBatch, 0, [{ date: TODAY, values: { ldl: 3.2 } }]);
  });

  it('the date picker, opened by a press, never commits; leaving commits under the picked date', async () => {
    const m = matrix();
    typeInto(m.cell('LDL Cholesterol'), '3.2');
    fireEvent.pointerDown(m.dateCell); // Safari never gives the button focus
    fireEvent.pointerUp(m.dateCell);
    fireEvent.click(m.dateCell);
    act(() => m.dateInput.focus());
    await wait(3000); // a person choosing a date
    fireEvent.change(m.dateInput, { target: { value: '2026-08-15' } });
    act(() => m.dateInput.blur()); // iOS "Done"
    await wait(5000);
    expect(m.onSaveBatch).not.toHaveBeenCalled();

    press(m.elsewhere);
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: '2026-08-15', values: { ldl: 3.2 } }]);
  });

  it('the date picker, opened from the keyboard, never commits; tabbing out commits under the picked date', async () => {
    const m = matrix();
    const ldl = m.cell('LDL Cholesterol');
    act(() => ldl.focus());
    fireEvent.change(ldl, { target: { value: '3.2' } });
    act(() => m.dateCell.focus()); // Tab
    fireEvent.click(m.dateCell); // Enter or Space
    act(() => m.dateInput.focus());
    fireEvent.change(m.dateInput, { target: { value: '2026-08-15' } });
    await wait(5000);
    expect(m.onSaveBatch).not.toHaveBeenCalled();

    act(() => m.elsewhere.focus()); // Tab, out of the matrix
    await wait(0);
    expectSent(m.onSaveBatch, 0, [{ date: '2026-08-15', values: { ldl: 3.2 } }]);
  });
});
