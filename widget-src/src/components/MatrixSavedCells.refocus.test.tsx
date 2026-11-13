// @vitest-environment jsdom
/**
 * US-04 AC1: coming back to a saved-value editor within its click-away
 * window cancels the pending save (H40). Before, the 150 ms timer saved the
 * text as it was at the blur, and could close the editor under the user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ValueCell } from './MatrixSavedCells';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function editor() {
  const onCorrect = vi.fn().mockResolvedValue('ok');
  const view = render(<ValueCell metric="ldl" display="si" value={3.2} rowId="r1" status="ok" pinned={false} onCorrect={onCorrect}/>);
  fireEvent.click(view.getByRole('button'));
  const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
  return { view, input, onCorrect };
}

describe('US-04 AC1 — a refocus cancels a pending click-away save', () => {
  it('a click away and back, then more typing, saves nothing until Enter or another leave', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3.6' } });
    await wait(2000);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBe(input);
    expect(input.value).toBe('3.6');

    // Another leave saves the text typed since.
    fireEvent.blur(input);
    await wait(200);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.6);
  });

  // A guard, not an H40 pin: submit() already cleared the timer before the fix.
  it('Enter after coming back saves the current text, once', async () => {
    const { input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3.6' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(2000);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.6);
  });

  it('a save waiting on a held press is cancelled by coming back too', async () => {
    const { view, input, onCorrect } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    fireEvent.pointerDown(document.body, { pointerId: 1 });
    await wait(200); // due during the press: it waits for the release
    fireEvent.focus(input);
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    fireEvent.change(input, { target: { value: '3.6' } });
    await wait(2000);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBe(input);
    expect(input.value).toBe('3.6');
    fireEvent.blur(input);
    await wait(200);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.6);
  });
});
