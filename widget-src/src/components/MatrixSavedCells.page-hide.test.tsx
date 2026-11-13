// @vitest-environment jsdom
/**
 * US-04 AC1: a click-away save the person already asked for by leaving runs
 * when the page goes away; in a hidden tab its timer may never come due
 * (H40, owner ruling R2). Text left in an open editor, refocused or not, is
 * never saved by the page going away: that would save an unfinished value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ValueCell } from './MatrixSavedCells';
import { hidePage, showPage } from '../testing/matrix-gestures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { showPage(); cleanup(); vi.useRealTimers(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function editor() {
  const onCorrect = vi.fn().mockResolvedValue('ok');
  const view = render(<ValueCell metric="ldl" display="si" value={3.2} rowId="r1" status="ok" pinned={false} onCorrect={onCorrect}/>);
  fireEvent.click(view.getByRole('button'));
  const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
  return { view, input, onCorrect };
}

describe('US-04 AC1 — the page going away during a click-away save', () => {
  it('hiding the tab within the click-away delay saves the text at once', async () => {
    const { onCorrect, input } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    hidePage();
    expect(onCorrect).toHaveBeenCalledTimes(1); // before the 150 ms would have run out
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.4);
    await wait(2000);
    expect(onCorrect).toHaveBeenCalledTimes(1);
  });

  it('hiding the tab with the editor open saves nothing', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    hidePage();
    await wait(2000);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBe(input);
  });

  it('hiding the tab after a click away and back saves nothing', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3.6' } });
    hidePage();
    await wait(2000);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBe(input);
    expect(input.value).toBe('3.6');
  });
});
