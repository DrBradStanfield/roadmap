// @vitest-environment jsdom
/**
 * The saved-value editor every matrix shares, and what the blood-test matrix
 * does with what is typed in it: a draft, kept on the device as typed, that
 * reaches the record only when the user commits it (US-03, US-04).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import { useState } from 'react';
import { localDay, toCanonicalValue, type ApiMeasurement } from '@roadmap/health-core';
import { BloodTestTimeline, ValueCell } from './BloodTestTimeline';
import { hidePage, pickDraftDate, press, pressMouse, pressWithoutFocus, releaseMouse, showPage, typeInto, typeWithoutTap } from '../testing/matrix-gestures';
import { slotOf, type Refused, type SaveTask } from '../lib/matrix-save';

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

  // US-02 AC7: "1,234" is read in the editor's unit, or asked about.
  it('US-02 AC7: "1,234" in mg/dL triglycerides (both in range) asks and writes nothing', async () => {
    const { view, input, onCorrect } = editor({ metric: 'triglycerides', display: 'conventional', value: 1.5 });
    fireEvent.change(input, { target: { value: '1,234' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.getByText('Did you mean 1234 or 1.234?')).toBeTruthy();
  });

  it('US-02 AC7: "1,234" in mmol/L triglycerides asks (the decimal reading is never chosen), and in µmol/L creatinine is 1234', async () => {
    const tg = editor({ metric: 'triglycerides', display: 'si', value: 1.5 });
    fireEvent.change(tg.input, { target: { value: '1,234' } });
    fireEvent.keyDown(tg.input, { key: 'Enter' });
    await wait(0);
    expect(tg.onCorrect).not.toHaveBeenCalled();
    expect(tg.view.getByText('Did you mean 1234 or 1.234?')).toBeTruthy();
    cleanup();
    const cr = editor({ metric: 'creatinine', display: 'si', value: 80 });
    fireEvent.change(cr.input, { target: { value: '1,234' } });
    fireEvent.keyDown(cr.input, { key: 'Enter' });
    await wait(0);
    expect(cr.onCorrect).toHaveBeenCalledWith('r1', 1234);
  });

  it('US-02 AC7: a lab value has no range, so "1,050" asks and writes nothing', async () => {
    const { view, input, onCorrect } = editor({ metric: undefined, display: undefined, value: 45 });
    fireEvent.change(input, { target: { value: '1,050' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.getByText('Did you mean 1050 or 1.05?')).toBeTruthy();
  });

  it('a lab value is corrected in the unit it is stored in, as typed', async () => {
    const { input, onCorrect } = editor({ metric: undefined, display: undefined, value: 45 });
    expect(input.value).toBe('45');
    fireEvent.change(input, { target: { value: '54' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 54);
  });

  // US-05 AC2: the page's unit switch never changes a lab value's unit, so a
  // press on it is leaving, as anywhere else: the edit saves.
  it('a lab value\'s editor is not closed by a press on the page\'s unit switch: held 1200 ms, it saves as typed', async () => {
    const onCorrect: Mock = vi.fn().mockResolvedValue('ok');
    const view = render(<>
      <ValueCell value={45} rowId="r1" status={null} pinned={false} onCorrect={onCorrect}/>
      <button type="button" data-unit-control="all">Units</button>
    </>);
    fireEvent.click(view.getAllByRole('button')[0]);
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '54' } });
    const pill = view.getByRole('button', { name: 'Units' });
    pressWithoutFocus(pill);
    await wait(1200);
    releaseMouse(pill);
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 54);
    expect(view.queryByText('Not saved: choose the unit first, then type the value.')).toBeNull();
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

// US-04 AC1 / US-05 AC2: a typed correction is saved only in the unit that
// was shown when it was typed, never across a unit change. A user who types
// 3.5 and then clicks the chip means "this number is in the new unit"; saving
// it in the old one is the falsely reassuring error. One rule in the editor:
// a press on a unit control that governs the editor (its row's own, or a
// global one) closes it unsaved at the press, before any click can switch
// the unit; any other click-away save waits while a pointer is down, until
// it is released and its click has run; a save finds the unit changed and
// writes nothing; and a unit switch closes the editor unsaved. Every gesture here is the browser's
// own sequence: the press, the wait, the release, the click.
describe('US-04 / US-05 AC2 — a unit switch while correcting LDL', () => {
  const UNIT_CHANGED = 'The unit changed, so your edit was not saved. Type it again in the new unit.';
  const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';
  const other = (unit: 'si' | 'conventional') => (unit === 'si' ? 'conventional' : 'si');
  function ldlPage(stored: number, unitSystem: 'si' | 'conventional' = 'si') {
    const onCorrectValue: Mock = vi.fn().mockResolvedValue('ok');
    const rows = history([['ldl', stored, '2026-08-15']]);
    /** Another device's switch of LDL's unit, as HealthTool takes it in. */
    const remote = { flip: noop };
    // The page as HealthTool keeps it: each chip toggles its own field, and
    // the global pill (outside the matrix) the whole unit system.
    function Page() {
      const [system, setSystem] = useState(unitSystem);
      const [overrides, setOverrides] = useState<Record<string, 'si' | 'conventional'>>({});
      const toggle = (field: string) => setOverrides((o) => ({ ...o, [field]: other(o[field] ?? system) }));
      remote.flip = () => toggle('ldlC');
      return (
        <>
          <BloodTestTimeline bloodTestHistory={rows} unitSystem={system} unitOverrides={overrides} onToggleFieldUnit={toggle}
            onSaveBatch={vi.fn().mockResolvedValue(new Map())} onCorrectValue={onCorrectValue} onDraftValue={noop}
            isSaving={false} grading={{}} hasApiResponse/>
          <button type="button" data-unit-control="all" onClick={() => { setSystem(other(system)); setOverrides({}); }}>Units</button>
        </>
      );
    }
    const view = render(<Page/>);
    const row = (label: string) => Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === label) as HTMLElement;
    const ldl = () => row('LDL Cholesterol');
    fireEvent.click(ldl().querySelector('.bt-cell-clickable')!);
    const input = ldl().querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const chip = () => ldl().querySelector('.bt-unit-chip') as HTMLElement;
    const hdlChip = () => row('HDL Cholesterol').querySelector('.bt-unit-chip') as HTMLElement;
    const pill = () => view.getByRole('button', { name: 'Units' });
    const title = () => view.container.querySelector('.bt-timeline-title') as HTMLElement;
    /** A mouse press held `ms`, then released: the click. */
    const click = async (el: () => HTMLElement, ms = 0) => {
      pressMouse(el());
      if (ms) await wait(ms);
      releaseMouse(el());
    };
    /** The same, as Safari makes it on a button: the press blurs the editor and nothing takes the focus. */
    const clickNoFocus = async (el: () => HTMLElement, ms = 0) => {
      pressWithoutFocus(el());
      if (ms) await wait(ms);
      releaseMouse(el());
    };
    const editorOpen = () => ldl().querySelector('.bt-cell-correcting');
    const region = () => view.container.querySelector('.bt-timeline [role="status"].bt-cell-messages') as HTMLElement;
    return { view, ldl, input, chip, hdlChip, pill, title, click, clickNoFocus, remote, editorOpen, region, onCorrectValue };
  }

  it('a slow press on its own chip (held 200 ms) writes nothing and says to choose the unit first: the press takes the focus, as in Chrome', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.chip, 200);
    expect(p.chip().textContent).toBe('mg/dL');
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(p.chip()); // the browser's own focus, kept
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a slow press on its own chip that takes no focus (Safari) closes the editor at the press, writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.chip, 200);
    expect(p.chip().textContent).toBe('mg/dL');
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
  });

  // Adversary R1 (2026-10-13): the release wait was capped at a second, so a
  // press held past 1150 ms ran the save in the old unit before the click
  // switched it. The press decides now; nothing waits on the release.
  it('a press on its own chip held 1200 ms (Safari) writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressWithoutFocus(p.chip());
    expect(p.editorOpen()).toBeNull(); // closed at the press
    await wait(1200);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    releaseMouse(p.chip());
    expect(p.chip().textContent).toBe('mg/dL');
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a fast click on its own chip writes nothing and says so: 3.5 typed in mmol/L', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.chip);
    expect(p.chip().textContent).toBe('mg/dL');
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a fast click on its own chip that takes no focus (Safari) writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.chip);
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('the same in US units: 40 typed in mg/dL, then its chip, writes nothing', async () => {
    const p = ldlPage(3.2, 'conventional');
    fireEvent.change(p.input, { target: { value: '40' } });
    await p.click(p.chip);
    expect(p.chip().textContent).toBe('mmol/L');
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a press on its own chip over an untouched editor (Safari) closes it silently at the press and writes nothing: "3.2" over a saved 3.24', async () => {
    const p = ldlPage(3.24);
    expect(p.input.value).toBe('3.2');
    pressWithoutFocus(p.chip());
    expect(p.editorOpen()).toBeNull();
    releaseMouse(p.chip());
    expect(p.chip().textContent).toBe('mg/dL');
    expect(within(p.ldl()).queryByText(UNIT_FIRST)).toBeNull();
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
  });

  // The rule the gesture guards leaked past: a press held on the global
  // pill outside the matrix ran the click-away save in the old unit.
  it('a slow press on the global unit pill (held 200 ms) writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.pill, 200);
    expect(p.chip().textContent).toBe('mg/dL');
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(p.pill());
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a fast click on the global unit pill writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.pill);
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a press on the global unit pill held 1200 ms (Safari) writes nothing and says to choose the unit first', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.pill, 1200);
    expect(p.chip().textContent).toBe('mg/dL');
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  // The gesture guard cancelled every chip's mousedown, so a click on another
  // row's chip never blurred the editor, and the edit was never saved.
  it('a mouse click on another row\'s chip is leaving: the edit saves after 150 ms, in its own unit', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.hdlChip);
    expect(p.hdlChip().textContent).toBe('mg/dL');
    expect(p.chip().textContent).toBe('mmol/L');
    await wait(100);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    await wait(100);
    expect(p.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
    expect(within(p.ldl()).queryByText(UNIT_FIRST)).toBeNull();
  });

  it('a press on another row\'s chip held 1200 ms (Safari) still saves the edit, in its own unit', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.hdlChip, 1200);
    await wait(0);
    expect(p.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
    expect(p.chip().textContent).toBe('mmol/L');
    expect(within(p.ldl()).queryByText(UNIT_FIRST)).toBeNull();
  });

  it('a press held on another row\'s chip saves once it is released, in its own unit', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.click(p.hdlChip, 200);
    expect(p.onCorrectValue).not.toHaveBeenCalled(); // the click had not run when the save was due
    await wait(0);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
  });

  it('Tab from the editor to its own chip writes nothing, says to choose the unit first, and leaves the focus on the chip', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    act(() => p.chip().focus());
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(p.chip());
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('Tab on to another row\'s chip is leaving: the value saves', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    act(() => p.hdlChip().focus());
    await wait(200);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
  });

  it('a click anywhere else still saves after 150 ms', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    press(p.title());
    await wait(100);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    await wait(100);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
  });

  // Adversary R5: a click-away save pending when another device's switch lands.
  it('a click-away save pending when another device switches the unit writes nothing and says so', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    press(p.title());
    await wait(50);
    act(() => p.remote.flip());
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_CHANGED)).toBeTruthy();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a click-away save waiting on a held press when another device switches the unit writes nothing', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressMouse(p.title());
    await wait(200); // the save is due, and waits for the release
    act(() => p.remote.flip());
    releaseMouse(p.title());
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(within(p.ldl()).getByText(UNIT_CHANGED)).toBeTruthy();
  });

  // The press decides (adversary R1, 2026-10-13): a press on the chip
  // dragged off still closed the editor at the press. The unit is unchanged,
  // and the message says why the edit went.
  it('a press on its own chip dragged off (released elsewhere, no click) closes the editor unsaved and says so', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    fireEvent.pointerDown(p.chip()); // a touch on the chip takes no focus
    fireEvent.pointerUp(document.body); // dragged off: no click
    await wait(200);
    expect(p.editorOpen()).toBeNull();
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(p.chip().textContent).toBe('mmol/L');
    expect(within(p.ldl()).getByText(UNIT_FIRST)).toBeTruthy();
  });

  it('a switch with the focus still in the editor closes it, writes nothing, says so, and returns the focus to the cell', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    act(() => p.remote.flip());
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).getByText(UNIT_CHANGED)).toBeTruthy();
    expect(document.activeElement).toBe(p.ldl().querySelector('.bt-cell-clickable'));
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    fireEvent.click(p.ldl().querySelector('.bt-cell-clickable')!); // until the next open
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
  });

  // Adversary R6: an editor nobody typed in loses nothing when it is left for
  // its own unit control, so it closes with no "Not saved" message.
  it('Tab from an untouched editor to its own chip closes it silently', async () => {
    const p = ldlPage(3.2);
    act(() => p.chip().focus());
    expect(p.editorOpen()).toBeNull();
    expect(within(p.ldl()).queryByText(UNIT_FIRST)).toBeNull();
    await wait(300);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(p.region().textContent).toBe('\u00a0');
  });

  // Adversary R5: a click-away save waiting for a release that never comes
  // (the pointerup lost to a drag out of the window, or a system gesture)
  // waited for ever, and the page going away took the edit with it.
  it('a press never released saves after 1000 ms more, in its own unit', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressMouse(p.title()); // no release
    await wait(150 + 900);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    await wait(100);
    expect(p.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
    expect(within(p.ldl()).queryByText(UNIT_CHANGED)).toBeNull();
  });

  it('a press never released, then another device\'s unit switch, still writes nothing after the cap', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressMouse(p.title());
    await wait(200);
    act(() => p.remote.flip());
    await wait(1500);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    expect(within(p.ldl()).getByText(UNIT_CHANGED)).toBeTruthy();
  });

  it('the page hiding runs a save waiting on a held press at once', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressMouse(p.title());
    await wait(200); // the save is due, and waits for the release
    expect(p.onCorrectValue).not.toHaveBeenCalled();
    hidePage();
    await wait(0);
    expect(p.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
    await wait(1500);
    expect(p.onCorrectValue).toHaveBeenCalledTimes(1);
  });

  it('pagehide alone runs it too', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    pressMouse(p.title());
    await wait(200);
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    await wait(0);
    expect(p.onCorrectValue).toHaveBeenCalledWith('row0', 3.5);
  });

  // Codex R2 / adversary R3: a live region set to the text it already holds
  // changes nothing in the page, so the second message went unheard.
  it('the same message twice in a row is a fresh change each time: cleared, then said', async () => {
    const p = ldlPage(3.2);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.chip);
    await wait(0);
    expect(p.region().textContent).toBe(UNIT_FIRST);
    fireEvent.click(p.ldl().querySelector('.bt-cell-clickable')!);
    fireEvent.change(p.ldl().querySelector('.bt-cell-correcting input')!, { target: { value: '140' } });
    await p.clickNoFocus(p.chip);
    expect(p.region().textContent).toBe('\u00a0');
    await wait(0);
    expect(p.region().textContent).toBe(UNIT_FIRST);
    expect(p.onCorrectValue).not.toHaveBeenCalled();
  });

  // Adversary R2 / Codex R2: one polite live region per matrix, on the page
  // from the first render, a p (the theme hides an empty div); the message
  // shows in the cell too.
  it('the cell\'s message is said in the matrix\'s one live region, there from the first render', async () => {
    const p = ldlPage(3.2);
    const region = p.region();
    expect(region).toBeTruthy();
    expect(region.tagName).toBe('P');
    expect(region.textContent).toBe('\u00a0'); // never empty: the theme may hide an empty p or div
    expect(p.view.container.querySelectorAll('[role="status"]')).toHaveLength(1);
    fireEvent.change(p.input, { target: { value: '3.5' } });
    await p.clickNoFocus(p.chip);
    await wait(0);
    expect(p.region()).toBe(region);
    expect(region.textContent).toBe(UNIT_FIRST);
    expect(within(p.ldl()).getByText(UNIT_FIRST).getAttribute('role')).toBeNull(); // the cell shows it; the region says it
  });
});

function history(rows: Array<[string, number, string]>): ApiMeasurement[] {
  return rows.map(([metricType, value, day], i) => ({
    id: `row${i}`, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, status: 'active',
  }));
}
/** The matrix on a page, with a control and some text outside it.
 *  `showHistory` renders the page again over another history. */
function matrix(rows: ApiMeasurement[] = [], onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map()), onDraftValue: () => void = noop) {
  const onCorrectValue = vi.fn();
  const page = (recorded: ApiMeasurement[]) => (
    <>
      <BloodTestTimeline bloodTestHistory={recorded} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={noop}
        onSaveBatch={onSaveBatch} onCorrectValue={onCorrectValue} onDraftValue={onDraftValue}
        isSaving={false} grading={{}} hasApiResponse/>
      <button type="button">Elsewhere</button>
      <p>Page text</p>
    </>
  );
  const view = render(page(rows));
  const showHistory = (recorded: ApiMeasurement[]) => view.rerender(page(recorded));
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
  return { view, root, header, row, cell, backfill, dateCell, dateInput, elsewhere, text, tapText, onSaveBatch, showHistory };
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
    m.showHistory(history([['hdl', 1.4, '2026-08-15'], ['ldl', 2.9, '2026-08-15']]));
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
    m.showHistory(filled);
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
    m.showHistory(history([['hdl', 1.4, '2026-08-15'], ['ldl', 2.9, '2026-08-15']]));
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
      onToggleFieldUnit={noop} onSaveBatch={vi.fn()} onDraftValue={noop} isSaving={false} grading={{}} hasApiResponse/>);
    const ldl = within(whileSaving.container).getByText('LDL Cholesterol').closest('.bt-row')!;
    expect((ldl.querySelector('.bt-cell-draft input') as HTMLInputElement).value).toBe('3.2');
    whileSaving.unmount();

    await act(async () => { accept(new Map()); });
    first.view.unmount();
    expect(matrix().cell('LDL Cholesterol').value).toBe('');
  });

  // Brad, 2026-09-25: the record read again no longer takes back what the
  // draft lent. The matrix judges the draft again against each history it is
  // given, with nothing typed.
  it('US-03 AC6: a new history judges the draft again, with nothing typed: it lends while its slot holds what it expects, and nothing once another row fills it', () => {
    const onDraftValue = vi.fn();
    const m = matrix([], undefined, onDraftValue);
    typeInto(m.cell('LDL Cholesterol'), '3');
    expect(onDraftValue).toHaveBeenLastCalledWith('ldlC', 3, TODAY);

    m.showHistory(history([['hdl', 1.4, TODAY]])); // another test
    expect(onDraftValue).not.toHaveBeenCalledWith('ldlC', undefined);

    m.showHistory(history([['hdl', 1.4, TODAY], ['ldl', 2.9, TODAY]])); // the draft's slot, filled elsewhere
    expect(onDraftValue).toHaveBeenLastCalledWith('ldlC', undefined);
  });

  it('US-07 AC7: the draft lends its value with the day it is dated, and lends it again when that day changes', () => {
    const onDraftValue = vi.fn();
    const m = matrix([], undefined, onDraftValue);
    typeInto(m.cell('Creatinine'), '80');
    expect(onDraftValue).toHaveBeenLastCalledWith('creatinine', 80, TODAY);
    fireEvent.change(m.dateInput, { target: { value: '2026-07-01' } });
    expect(onDraftValue).toHaveBeenLastCalledWith('creatinine', 80, '2026-07-01');
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

  // US-02 AC7: in µmol/L, "1,234" creatinine can only be 1234 (1.234 is below
  // the range); in mmol/L, "1,234" triglycerides fits only as 1.234, a decimal
  // reading, which is never chosen: it stays in the draft, asking.
  it('US-02 AC7: a draft "1,234" saves thousands below which the decimal reading falls, and asks otherwise', async () => {
    const m = matrix();
    typeInto(m.cell('Creatinine'), '1,234');
    typeInto(m.cell('Triglycerides'), '1,234');
    press(m.elsewhere);
    await wait(0);
    expect(m.onSaveBatch).toHaveBeenCalledTimes(1);
    expectSent(m.onSaveBatch, 0, [{ date: TODAY, values: { creatinine: 1234 } }]);
    expect(m.cell('Triglycerides').value).toBe('1,234');
    expect(m.view.getByText('Did you mean 1234 or 1.234?')).toBeTruthy();
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

// US-07 AC5: an editable cell shows the plain value, the number the draft
// router and the editor compare a typed value against (US-03 AC3). Its colour
// is the plan's grade, so a value within one display step of its line,
// entered in the other unit, can read on the other side of its hint.
describe('US-07 AC5: a lipid cell shows its plain value, coloured by the plan\'s grade', () => {
  const cellOf = (metric: string, value: number, unitOverrides: Record<string, 'si' | 'conventional'> = {}) => {
    const view = render(
      <BloodTestTimeline bloodTestHistory={history([[metric, value, '2026-09-01']])} unitSystem="si" unitOverrides={unitOverrides}
        onToggleFieldUnit={noop} onSaveBatch={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={noop} isSaving={false} grading={{}} hasApiResponse/>,
    );
    const r = Array.from(view.container.querySelectorAll('.bt-row')).find((row) => row.querySelector('.bt-cell-value .bt-value-num'))!;
    return [r.querySelector('.bt-ref-label')?.textContent, r.querySelector('.bt-value-num')?.textContent, r.querySelector('.bt-cell-value .bt-status-tick')?.className];
  };

  it('LDL 54 mg/dL shown in mmol/L reads 1.4 beside "<1.4", and is graded optimal', () => {
    expect(cellOf('ldl', toCanonicalValue('ldl', 54, 'conventional')))
      .toEqual(['Optimal: <1.4 mmol/L', '1.4', 'bt-status-tick bt-status-ok']);
  });

  it('LDL 1.40 mmol/L shown in mg/dL reads 54 beside "<55", and is graded above optimal', () => {
    expect(cellOf('ldl', 1.4, { ldlC: 'conventional' }))
      .toEqual(['Optimal: <55 mg/dL', '54', 'bt-status-tick bt-status-warn']);
  });

  it('a value typed in the shown unit reads as typed', () => {
    expect(cellOf('ldl', 1.4)[1]).toBe('1.4');
    expect(cellOf('apob', 0.49)[1]).toBe('0.49');
  });
});
