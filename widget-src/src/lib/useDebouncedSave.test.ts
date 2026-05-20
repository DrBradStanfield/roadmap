import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncedSave } from './useDebouncedSave';

// Auto-save on click-away relied on a debounce that (a) batched
// rapid blur→blur sequences (e.g. systolic → diastolic on BP), (b) let an
// explicit Enter keypress flush the pending save immediately, and (c) didn't
// leak a fire after the component unmounted. These tests pin those down.

describe('createDebouncedSave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the queued fn after the delay', () => {
    const d = createDebouncedSave(500);
    const fn = vi.fn();
    d.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-scheduling resets the timer (only the latest fn runs)', () => {
    const d = createDebouncedSave(500);
    const first = vi.fn();
    const second = vi.fn();
    d.schedule(first);
    vi.advanceTimersByTime(400);
    d.schedule(second);
    vi.advanceTimersByTime(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('flush() fires the queued fn immediately and clears the timer', () => {
    const d = createDebouncedSave(500);
    const fn = vi.fn();
    d.schedule(fn);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with no pending call is a no-op', () => {
    const d = createDebouncedSave(500);
    expect(() => d.flush()).not.toThrow();
  });

  it('cancel() drops the pending fn without firing', () => {
    const d = createDebouncedSave(500);
    const fn = vi.fn();
    d.schedule(fn);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rapid blur→blur within the window batches to one save', () => {
    // Simulates: user tabs systolic → diastolic; we expect ONE save with the
    // diastolic state, not two.
    const d = createDebouncedSave(500);
    const save = vi.fn();
    d.schedule(save);    // systolic blur
    vi.advanceTimersByTime(100);
    d.schedule(save);    // diastolic blur, before 500ms elapses
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
