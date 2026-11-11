// @vitest-environment jsdom
/**
 * US-16 AC2a, AC2c, AC2d: the erase the screen shows, and this tab's own
 * erase, through the erase machine (lib/erase-machine.ts). The page-level
 * journeys are in the HealthTool.*erase* tests; these check the hook's own
 * rules: what it dispatches, and what its doors do.
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
  askedUnder: () => store.shown,
  markEraseShown: (e: string) => { store.shown = e; },
  deleteUserData: () => store.next!(),
}));

import { useErase } from './useErase';
import { ERASE_DONE, ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';

let alerts: string[];
beforeEach(() => {
  store.identity = 'e1'; store.shown = 'e1'; store.next = null;
  alerts = [];
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
});

function setup() {
  const doors = { clearDrafts: vi.fn(), forget: vi.fn(), reread: vi.fn() };
  const hook = renderHook(() => useErase(doors));
  return { doors, result: hook.result };
}

describe('US-16 AC2a: the erase the screen shows', () => {
  it('a read of a new erase marks the store, updates shownErase and clears the drafts once per move', () => {
    const { doors, result } = setup();
    act(() => { result.current.store.dispatch({ type: 'read', identity: 'e1' }); }); // already shown: nothing
    expect(doors.clearDrafts).not.toHaveBeenCalled();
    act(() => { result.current.store.dispatch({ type: 'read', identity: 'e2' }); });
    expect(store.shown).toBe('e2');
    expect(result.current.shownErase).toBe('e2');
    expect(doors.clearDrafts).toHaveBeenCalledTimes(1);
  });

  it('US-16 AC2d: the store mark moves when the new tree commits, not when the read is dispatched', () => {
    const { result } = setup();
    store.identity = 'e2';
    let markAtAsk = '';
    act(() => { result.current.store.dispatch({ type: 'read', identity: 'e2' }); markAtAsk = store.shown; });
    expect(markAtAsk).toBe('e1'); // asked, not yet on screen: a save asked now keeps e1 and is refused
    expect(store.shown).toBe('e2'); // committed
  });

  it('eraseUnshown is true while the store holds an erase the screen does not show', () => {
    const { result } = setup();
    expect(result.current.eraseUnshown()).toBe(false);
    store.identity = 'e2';
    expect(result.current.eraseUnshown()).toBe(true);
  });

  it('a refused save is said once per erase it was asked under, and re-reads the record once', () => {
    const { doors, result } = setup();
    store.identity = 'e2'; // the store moved; the screen still shows e1
    act(() => result.current.writeRefused('e1'));
    act(() => result.current.writeRefused('e1'));
    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(doors.reread.mock.calls).toEqual([['refused']]);
    // Asked of a record the screen has left: news for that erase, re-read without spending a landing.
    act(() => result.current.writeRefused('e0'));
    expect(alerts).toEqual([WRITE_REFUSED, WRITE_REFUSED]);
    expect(doors.reread.mock.calls).toEqual([['refused'], ['left']]);
  });

  it('F4c: a save that names no erase (the supplement stop) is taken as asked under the shown one', () => {
    const { doors, result } = setup();
    store.identity = 'e2';
    act(() => result.current.writeRefused());
    act(() => result.current.writeRefused('e1')); // the same erase: said already
    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(doors.reread.mock.calls).toEqual([['refused']]);
  });

  it('Q3: a news refusal while another writer\'s erase is heard re-reads exactly once, through the machine', () => {
    const { doors, result } = setup();
    // PR 2b-3 wires these two from the page; dispatched here as it will.
    act(() => { result.current.store.dispatch({ type: 'loaded' }); });
    store.identity = 'e2';
    act(() => { result.current.store.dispatch({ type: 'arrived', identity: 'e2' }); }); // its read fails: no event follows
    expect(doors.reread).toHaveBeenCalledTimes(1);
    act(() => result.current.writeRefused('e1'));
    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(doors.reread).toHaveBeenCalledTimes(2); // one for the refusal: the machine's, not a second from the page
  });
});

describe('US-16 AC2a: this tab\'s erase', () => {
  it('locks while it writes, refusals then are no news, and on success it forgets the record, shows the new erase and says it is done', async () => {
    const { doors, result } = setup();
    let finish!: () => void;
    store.next = () => new Promise(r => { finish = () => { store.identity = 'e2'; r({ success: true, chatErased: true }); }; });
    let done!: Promise<boolean>;
    act(() => { done = result.current.eraseAll(); });
    expect(result.current.erasing).toBe(true);
    act(() => result.current.writeRefused('e1'));
    expect(alerts).toEqual([]);
    await act(async () => { finish(); expect(await done).toBe(true); });
    expect(result.current.erasing).toBe(false);
    expect(doors.forget).toHaveBeenCalledTimes(1);
    expect(result.current.shownErase).toBe('e2');
    expect(store.shown).toBe('e2');
    expect(doors.clearDrafts).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([ERASE_DONE]);
    // A refusal of a save asked before the erase is no news either.
    act(() => result.current.writeRefused('e1'));
    expect(alerts).toEqual([ERASE_DONE]);
    expect(doors.reread).not.toHaveBeenCalled();
  });

  it('a re-read during the write shows nothing; the erase\'s end clears the drafts once and shows it (adversary R1)', async () => {
    const { doors, result } = setup();
    store.next = async () => {
      store.identity = 'e2';
      result.current.store.dispatch({ type: 'read', identity: 'e2' }); // the read loses to this tab's erase
      expect(doors.clearDrafts).not.toHaveBeenCalled();
      return { success: true, chatErased: true };
    };
    await act(async () => { await result.current.eraseAll(); });
    expect(doors.clearDrafts).toHaveBeenCalledTimes(1);
    expect(result.current.shownErase).toBe('e2');
  });

  it('F2: a failed write that still moved the erase forgets the record and shows it; one that moved nothing keeps it', async () => {
    const { doors, result } = setup();
    store.next = async () => ({ success: false });
    await act(async () => { expect(await result.current.eraseAll()).toBe(false); });
    expect(doors.forget).not.toHaveBeenCalled();
    expect(result.current.shownErase).toBe('e1');
    expect(alerts).toEqual([ERASE_FAILED]);
    store.next = async () => { store.identity = 'e2'; return { success: false, error: 'Not saved' }; };
    await act(async () => { await result.current.eraseAll(); });
    expect(doors.forget).toHaveBeenCalledTimes(1);
    expect(result.current.shownErase).toBe('e2');
    expect(alerts).toEqual([ERASE_FAILED, 'Not saved']);
  });

  it('a cancelled confirm erases nothing', async () => {
    vi.stubGlobal('confirm', () => false);
    store.next = vi.fn();
    const { result } = setup();
    await act(async () => { expect(await result.current.eraseAll()).toBe(false); });
    expect(store.next).not.toHaveBeenCalled();
    expect(result.current.erasing).toBe(false);
    expect(alerts).toEqual([]);
  });
});
