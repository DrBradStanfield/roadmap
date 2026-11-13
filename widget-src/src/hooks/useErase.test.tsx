// @vitest-environment jsdom
/**
 * US-16 AC2a, AC2c, AC2d: the erase the screen shows, and this tab's own
 * erase, through the erase machine (lib/erase-machine.ts). The page-level
 * journeys are in the HealthTool.*erase* tests; these check the hook's own
 * rules: what it dispatches, and what its doors do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderHook, waitFor } from '@testing-library/react';

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
  getBackendKind: () => 'local',
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { useErase } from './useErase';
import { ERASE_DONE, ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';
import { trackProductEvent } from '../lib/server-api';
import { Sentry } from '../lib/sentry';
import { WritesStoppedError } from '../lib/error-diagnostics';

const id = (epoch: number) => JSON.stringify([epoch, `2026-11-0${epoch}T10:00:00.000Z`]);

let alerts: string[];
/** The alert and every door call, in order. */
let order: string[];
beforeEach(() => {
  store.identity = 'e1'; store.shown = 'e1'; store.next = null;
  alerts = [];
  order = [];
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); order.push('alert'); });
  vi.stubGlobal('confirm', () => true);
});

function setup() {
  const doors = {
    clearDrafts: vi.fn(), forget: vi.fn(),
    reread: vi.fn((reason: string) => { order.push(`reread ${reason}`); }),
    shows: vi.fn(() => { order.push('shows'); }),
    spend: vi.fn(() => { order.push('spend'); }),
  };
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
    // The page wires these two (useRecordApply: its loaded effect, its REMOTE_CHANGED listener); dispatched here as it does.
    act(() => { result.current.store.dispatch({ type: 'loaded' }); });
    store.identity = 'e2';
    act(() => { result.current.store.dispatch({ type: 'arrived', identity: 'e2' }); }); // its read fails: no event follows
    expect(doors.shows).toHaveBeenCalledTimes(1);
    act(() => result.current.writeRefused('e1'));
    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(doors.shows).toHaveBeenCalledTimes(2); // one for the refusal: the machine's, not a second from the page
    expect(doors.reread).not.toHaveBeenCalled();
  });

  it('Fable Q3 (2b-3): a refusal says WRITE_REFUSED before its re-read starts, heard erase or not', () => {
    const { result } = setup();
    act(() => { result.current.store.dispatch({ type: 'loaded' }); });
    store.identity = 'e2';
    act(() => result.current.writeRefused('e1')); // nothing heard: the page's re-read
    expect(order).toEqual(['alert', 'reread refused']);
    order.length = 0;
    act(() => { result.current.store.dispatch({ type: 'arrived', identity: 'e2' }); }); // its read fails
    order.length = 0;
    act(() => result.current.writeRefused('e0')); // heard: the machine's re-read
    expect(order[0]).toBe('alert');
    expect(order[1]).toBe('shows');
  });

  it('Fable Q2(b) (2b-3): the machine\'s re-read for a refusal spends the answer mark, as a \'refused\' re-read does; one for a record the screen left does not', () => {
    const { doors, result } = setup();
    act(() => { result.current.store.dispatch({ type: 'loaded' }); });
    store.identity = 'e2';
    act(() => { result.current.store.dispatch({ type: 'arrived', identity: 'e2' }); }); // its read fails
    order.length = 0;
    act(() => result.current.writeRefused('e1')); // asked under the erase shown
    expect(order).toEqual(['alert', 'shows', 'spend']);
    act(() => result.current.writeRefused('e0')); // asked under an erase the screen has left
    expect(order).toEqual(['alert', 'shows', 'spend', 'alert', 'shows']);
    expect(doors.spend).toHaveBeenCalledTimes(1);
  });

  it('2b-3 R2: a repeat refusal (no news) while an erase is heard re-reads but leaves the answer mark unspent', () => {
    const { doors, result } = setup();
    act(() => { result.current.store.dispatch({ type: 'loaded' }); });
    store.identity = 'e2';
    act(() => { result.current.store.dispatch({ type: 'arrived', identity: 'e2' }); }); // its read fails
    act(() => result.current.writeRefused('e1')); // news: said, read, spent
    act(() => result.current.writeRefused('e1')); // a repeat: read only
    expect(doors.shows).toHaveBeenCalledTimes(3);
    expect(doors.spend).toHaveBeenCalledTimes(1);
  });

  it('Codex R1, outside act(): two erases read before one commit: only the one the screen shows counts', async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasAct = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const commits: string[] = [];
    let page!: ReturnType<typeof useErase>;
    const doors = { clearDrafts: () => {}, forget: () => {}, reread: () => {}, shows: () => {}, spend: () => {} };
    function Page() {
      page = useErase(doors);
      useLayoutEffect(() => { commits.push(page.shownErase); });
      return null;
    }
    const counts = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      root.render(<Page />);
      await waitFor(() => expect(commits).toEqual(['e1']));
      vi.mocked(trackProductEvent).mockClear();
      setTimeout(() => {
        page.store.dispatch({ type: 'loaded' });
        page.store.dispatch({ type: 'read', identity: id(1) }); // B
        page.store.dispatch({ type: 'read', identity: id(2) }); // C overtakes it before React commits
      }, 0);
      await waitFor(() => expect(commits[commits.length - 1]).toBe(id(2)));
      await new Promise(r => setTimeout(r, 20));
      expect(commits).not.toContain(id(1)); // B never reached the screen
      expect(counts()).toBe(1); // C only
    } finally {
      root.unmount();
      env.IS_REACT_ACT_ENVIRONMENT = wasAct;
    }
  });

  it('US-16 AC2d, outside act(): a record and its erase set in one async turn commit together, never the mark first', async () => {
    // React's real scheduling, as in the browser: no act() scope batching the renders for the test.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasAct = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const commits: string[] = [];
    let page!: { setRecord: (r: string) => void; erase: ReturnType<typeof useErase> };
    const doors = { clearDrafts: () => {}, forget: () => {}, reread: () => {}, shows: () => {}, spend: () => {} };
    function Page() {
      const [record, setRecord] = useState('e1');
      const erase = useErase(doors);
      page = { setRecord, erase };
      // After useErase's own layout effect: the store's mark as this commit left it.
      useLayoutEffect(() => { commits.push(`record=${record} mark=${store.shown}`); });
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      root.render(<Page />);
      await waitFor(() => expect(commits).toEqual(['record=e1 mark=e1']));
      // As useRecordApply's apply does once its read lands: the record set, then the read dispatched.
      setTimeout(() => {
        page.setRecord('e2');
        page.erase.store.dispatch({ type: 'read', identity: 'e2' });
      }, 0);
      await waitFor(() => expect(commits[commits.length - 1]).toBe('record=e2 mark=e2'));
      // useSyncExternalStore here commits 'record=e1 mark=e2' between: a save asked then would land in the new record.
      // (The commit's own `committed` count re-renders once more at e2: repeats are folded.)
      expect(commits.filter((c, i) => c !== commits[i - 1])).toEqual(['record=e1 mark=e1', 'record=e2 mark=e2']);
    } finally {
      root.unmount();
      env.IS_REACT_ACT_ENVIRONMENT = wasAct;
    }
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

  it('US-16 AC2f: an erase whose write throws ends, unlocked, and says it failed', async () => {
    const { doors, result } = setup();
    const thrown = new Error('network');
    store.next = () => Promise.reject(thrown);
    vi.mocked(Sentry.captureException).mockClear();
    await act(async () => { expect(await result.current.eraseAll()).toBe(false); });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(new Error('Erase failed'), { tags: { area: 'erase', op: 'delete-all' } });
    expect(vi.mocked(Sentry.captureException).mock.calls[0][0]).not.toBe(thrown); // a fresh error: no provider text
    expect(result.current.erasing).toBe(false);
    expect(doors.forget).not.toHaveBeenCalled();
    expect(alerts).toEqual([ERASE_FAILED]);
  });

  it.each([
    { name: 'a log-off refusal', error: () => new WritesStoppedError(), reports: 0 },
    { name: 'any other throw', error: () => new Error('network'), reports: 1 },
  ])('US-09 AC2c, lead A19: an erase whose write throws $name reports $reports time(s) and says the same', async ({ error, reports }) => {
    const { doors, result } = setup();
    store.next = () => Promise.reject(error());
    vi.mocked(Sentry.captureException).mockClear();
    await act(async () => { expect(await result.current.eraseAll()).toBe(false); });
    expect(Sentry.captureException).toHaveBeenCalledTimes(reports);
    expect(result.current.erasing).toBe(false);
    expect(doors.forget).not.toHaveBeenCalled();
    expect(alerts).toEqual([ERASE_FAILED]);
  });

  it('US-16 AC2f: a second erase asked while one writes is refused, asks nothing and leaves the lock to the first', async () => {
    const { result } = setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    let finish!: () => void;
    const next = vi.fn(() => new Promise<Record<string, unknown>>(r => { finish = () => { store.identity = 'e2'; r({ success: true, chatErased: true }); }; }));
    store.next = next;
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = result.current.eraseAll(); second = result.current.eraseAll(); });
    expect(next).toHaveBeenCalledTimes(1);
    expect(await second).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.current.erasing).toBe(true); // the form stays refused (fieldset disabled={isDeleting})
    expect(alerts).toEqual([]);
    await act(async () => { finish(); expect(await first).toBe(true); });
    expect(result.current.erasing).toBe(false);
    expect(alerts).toEqual([ERASE_DONE]);
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
