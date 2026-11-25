// @vitest-environment jsdom
/**
 * US-04 AC1: a click-away save the person already asked for by leaving runs
 * when the page goes away; in a hidden tab its timer may never come due
 * (H40, owner ruling R2). Text left in an open editor, refocused or not, is
 * never saved by the page going away: that would save an unfinished value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { BACKEND_KEY } from '../storage/web-record-host';
import { ValueCell } from './MatrixSavedCells';
import { hidePage, showPage } from '../testing/matrix-gestures';

const flush = vi.hoisted(() => vi.fn());
const shown = vi.hoisted(() => ({ erase: 'erase-shown' }));
vi.mock('../lib/roadmap-data', () => ({ flushRoadmapStoreSync: flush, getShownErase: () => shown.erase }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { showPage(); cleanup(); vi.useRealTimers(); shown.erase = 'erase-shown'; });

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
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.4, 'erase-shown');
    await wait(2000);
    expect(onCorrect).toHaveBeenCalledTimes(1);
  });

  // US-16 AC2a (PR 1 review, lead L1): the save names the erase shown when the editor opened, not the one shown when
  // its click-away timer or the page hide runs it.
  it('a save that runs after the page shows another erase names the erase the editor opened at', async () => {
    const { onCorrect, input } = editor();
    shown.erase = 'erase-shown-later';
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    hidePage();
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.4, 'erase-shown');
  });

  // US-16 AC2a (PR 2081 review, R2): a correction refused for the erase it opened under is a value changed elsewhere:
  // the editor closes with those words, never "Could not save" kept open for a retry that can never land.
  it('an editor opened before an erase and saved after it closes with the changed words, and writes nothing', async () => {
    vi.useRealTimers();
    localStorage.clear();
    localStorage.setItem(BACKEND_KEY, 'memory');
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    store.showErase(store.eraseIdentity);
    const ldl = store.addMeasurement('ldl', 3.2, '2026-08-15');
    if (ldl.status !== 'inserted') throw new Error('setup failed');
    shown.erase = store.shownErase;
    const view = render(<ValueCell metric="ldl" display="si" value={3.2} rowId={ldl.row.id} status="ok" pinned={false}
      onCorrect={(id, value, erase) => Promise.resolve(store.correctValue(id, value, erase))}/>);
    fireEvent.click(view.getByRole('button'));
    expect((await store.deleteAllData()).success).toBe(true);
    store.showErase(store.eraseIdentity);
    const before = JSON.stringify(store.file);
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(view.container.querySelector('.bt-cell-correcting input')).toBeNull());
    expect(view.container.textContent).toContain('This value changed on another device, so your edit was not saved.');
    expect(view.container.textContent).not.toContain('Could not save');
    expect(JSON.stringify(store.file)).toBe(before);
  });

  // Codex R1: the page's own flush listener ran before the cell's, so the
  // correction staged on hide must be written by a flush after it.
  it('a hide alone (no pagehide) writes the correction, then flushes the record', async () => {
    flush.mockClear();
    const { onCorrect, input } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    await wait(50);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.4, 'erase-shown');
    expect(flush).toHaveBeenCalled();
    expect(onCorrect.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]);
  });

  // Owner ruling F1: a tab or app switch blurs the editor before the hide,
  // so it is a leave, the same as a click away.
  it('a tab switch (blur, then hide) saves the typed text as a leave', async () => {
    const { view, onCorrect, input } = editor();
    fireEvent.change(input, { target: { value: '3.4' } });
    fireEvent.blur(input);
    hidePage();
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith('r1', 3.4, 'erase-shown');
    await wait(2000);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.bt-cell-correcting input')).toBeNull();
  });

  it('a tab switch over text it cannot save closes the editor and writes nothing', async () => {
    const { view, onCorrect, input } = editor();
    fireEvent.change(input, { target: { value: '99999' } }); // outside LDL's range
    fireEvent.blur(input);
    hidePage();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBeNull(); // at the hide, not the timer
    await wait(2000);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(view.container.querySelector('.bt-cell-correcting input')).toBeNull();
    expect(view.getByRole('button').textContent).toContain('3.2');
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
