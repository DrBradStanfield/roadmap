// @vitest-environment jsdom
/**
 * US-16 AC2a, AC2c: the erase the screen shows, and this tab's own erase.
 * The page-level journeys are in the HealthTool.*erase* tests; these check
 * the hook's own rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';

const store = vi.hoisted(() => ({
  identity: 'e1', shown: 'e1',
  next: null as null | (() => Promise<Record<string, unknown>>),
}));
vi.mock('../lib/roadmap-data', () => ({
  getEraseIdentity: () => store.identity,
  getShownErase: () => store.shown,
  markEraseShown: (e: string) => { store.shown = e; },
  deleteUserData: () => store.next!(),
}));

import { useErase } from './useErase';
import { ERASE_DONE, ERASE_FAILED } from '../lib/erase-copy';

let alerts: string[];
beforeEach(() => {
  store.identity = 'e1'; store.shown = 'e1'; store.next = null;
  alerts = [];
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
});

describe('US-16 AC2a: the erase the screen shows', () => {
  it('showErase marks the store, updates shownErase and runs onShown once per move', () => {
    const onShown = vi.fn();
    const { result } = renderHook(() => useErase(onShown));
    act(() => result.current.showErase('e1')); // already shown: nothing
    expect(onShown).not.toHaveBeenCalled();
    act(() => result.current.showErase('e2'));
    expect(store.shown).toBe('e2');
    expect(result.current.shownErase).toBe('e2');
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('eraseUnshown is true while the store holds an erase the screen does not show', () => {
    const { result } = renderHook(() => useErase(() => {}));
    expect(result.current.eraseUnshown()).toBe(false);
    store.identity = 'e2';
    expect(result.current.eraseUnshown()).toBe(true);
  });

  it('a refused save is news once per erase', () => {
    const { result } = renderHook(() => useErase(() => {}));
    expect(result.current.refusalIsNews()).toBe(true);
    expect(result.current.refusalIsNews()).toBe(false);
    store.identity = 'e2';
    expect(result.current.refusalIsNews()).toBe(true);
  });
});

describe('US-16 AC2a: this tab\'s erase', () => {
  it('locks while it writes, refusals then are no news, and on success it forgets the record, shows the new erase and says it is done', async () => {
    const forget = vi.fn();
    const onShown = vi.fn();
    const { result } = renderHook(() => useErase(onShown));
    let finish!: () => void;
    store.next = () => new Promise(r => { finish = () => { store.identity = 'e2'; r({ success: true, chatErased: true }); }; });
    let done!: Promise<boolean>;
    act(() => { done = result.current.eraseAll(forget); });
    expect(result.current.erasing).toBe(true);
    expect(result.current.refusalIsNews()).toBe(false);
    await act(async () => { finish(); expect(await done).toBe(true); });
    expect(result.current.erasing).toBe(false);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(result.current.shownErase).toBe('e2');
    expect(onShown).toHaveBeenCalled();
    expect(alerts).toEqual([ERASE_DONE]);
    // A refusal of the erase's own leftovers is no news either.
    expect(result.current.refusalIsNews()).toBe(false);
  });

  it('a failed write that still moved the erase forgets the record; one that moved nothing keeps it', async () => {
    const forget = vi.fn();
    const { result } = renderHook(() => useErase(() => {}));
    store.next = async () => ({ success: false });
    await act(async () => { expect(await result.current.eraseAll(forget)).toBe(false); });
    expect(forget).not.toHaveBeenCalled();
    expect(alerts).toEqual([ERASE_FAILED]);
    store.next = async () => { store.identity = 'e2'; return { success: false, error: 'Not saved' }; };
    await act(async () => { await result.current.eraseAll(forget); });
    expect(forget).toHaveBeenCalledTimes(1);
    expect(result.current.shownErase).toBe('e2');
    expect(alerts).toEqual([ERASE_FAILED, 'Not saved']);
  });

  it('a cancelled confirm erases nothing', async () => {
    vi.stubGlobal('confirm', () => false);
    store.next = vi.fn();
    const { result } = renderHook(() => useErase(() => {}));
    await act(async () => { expect(await result.current.eraseAll(vi.fn())).toBe(false); });
    expect(store.next).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });
});
