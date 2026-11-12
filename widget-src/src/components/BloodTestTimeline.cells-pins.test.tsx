// @vitest-environment jsdom
/**
 * Pins for the shared matrix cells, through BloodTestTimeline's exports, so a
 * move of the cells to their own module can be shown to change nothing: the
 * export list, the saved-date header, the saved-value editor's states, the
 * refusal words and the live region. Synthetic values only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import * as timeline from './BloodTestTimeline';
import { BatchDateCell, ValueCell, headerDay, useLiveRegion, SAVE_ERRORS, SAVE_FAILED, saveErrorText } from './BloodTestTimeline';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('BloodTestTimeline cell pins', () => {
  it('exports the same runtime names', () => {
    expect(Object.keys(timeline).sort()).toMatchSnapshot();
  });

  it('headerDay splits a saved date into day and year', () => {
    expect(['2024-03-12', '2019-12-31', '2031-01-01'].map(headerDay)).toMatchSnapshot();
  });

  it('BatchDateCell: plain, pinned, and movable', () => {
    const plain = render(<BatchDateCell date="2024-03-12" pinned={false}/>);
    expect(plain.container.innerHTML).toMatchSnapshot('plain');
    cleanup();
    const pinned = render(<BatchDateCell date="2023-07-04" pinned/>);
    expect(pinned.container.innerHTML).toMatchSnapshot('pinned');
    cleanup();
    const onPick = vi.fn();
    const move = { onPick, picked: null, held: new Set<string>(), onHeld: vi.fn() };
    const movable = render(<BatchDateCell date="2024-03-12" pinned={false} move={move}/>);
    expect(movable.container.innerHTML.replace(/id="[^"]*"/g, 'id="X"').replace(/for="[^"]*"/g, 'for="X"')).toMatchSnapshot('movable');
  });

  it('ValueCell: read-only, clickable, lab value with unit, ungraded limit', () => {
    const states = [
      <ValueCell key="ro" metric="ldl" display="si" value={3.2} status="ok" pinned={false}/>,
      <ValueCell key="click" metric="ldl" display="si" value={3.2} rowId="r1" status="high" pinned onCorrect={vi.fn()}/>,
      <ValueCell key="lab" value={45} unit="U/L" rowId="r2" status={null} pinned={false} onCorrect={vi.fn()}/>,
      <ValueCell key="limit" metric="ldl" display="si" value={0.5} comparator="<" ungraded rowId="r3" status={null} pinned={false} onCorrect={vi.fn()}/>,
    ];
    const html = states.map(el => { const v = render(el); const h = v.container.innerHTML; cleanup(); return h; });
    expect(html).toMatchSnapshot();
  });

  it('ValueCell: the editor open, a refusal kept open, a replaced value closed', async () => {
    const onCorrect = vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce('changed');
    const say = vi.fn();
    const view = render(<ValueCell metric="ldl" display="si" value={3.2} rowId="r1" status="ok" pinned={false} onCorrect={onCorrect} say={say}/>);
    fireEvent.click(view.getByRole('button'));
    const norm = (h: string) => h.replace(/id="[^"]*"/g, 'id="X"').replace(/aria-describedby="[^"]*"/g, 'aria-describedby="X"');
    expect(norm(view.container.innerHTML)).toMatchSnapshot('editor open');
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4.1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenLastCalledWith('r1', 4.1);
    expect(view.container.textContent).toContain(SAVE_ERRORS.invalid);
    expect(norm(view.container.innerHTML)).toMatchSnapshot('refused, still open');
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(view.container.textContent).toContain(SAVE_ERRORS.changed);
    expect(norm(view.container.innerHTML)).toMatchSnapshot('replaced, closed');
    expect(say.mock.calls).toMatchSnapshot('said');
  });

  it('the refusal words', () => {
    expect({ SAVE_ERRORS, SAVE_FAILED, refused: saveErrorText({ refused: 'Engine words.' } as never), invalid: saveErrorText('invalid') }).toMatchSnapshot();
  });

  it('useLiveRegion says each message, a repeat too', async () => {
    let sayIt: (m: string) => void = () => {};
    function Region() {
      const [say, region] = useLiveRegion('pin-region');
      sayIt = say;
      return region;
    }
    const view = render(<Region/>);
    const region = () => view.container.querySelector('.pin-region')!;
    expect(region().outerHTML).toMatchSnapshot('silent');
    act(() => sayIt('Saved.'));
    expect(region().textContent).toBe(' ');
    await wait(0);
    expect(region().outerHTML).toMatchSnapshot('said');
    act(() => sayIt('Saved.'));
    expect(region().textContent).toBe(' ');
    await wait(0);
    expect(region().textContent).toBe('Saved.');
  });
});
