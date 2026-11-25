// @vitest-environment jsdom
/**
 * US-34 AC4, AC4a: what each re-read of the record does, by its reason. One
 * row per reason and per relay state (nothing held, or another writer's change
 * held behind a dirty profile): what the page reads, what it shows, whether it
 * shows the erase, whether the hold ends, and whether remote_change_applied is
 * counted.
 *
 * 'own-save' is the re-read after the page's own save (the first-time fields'
 * save, a correction, a moved blood test). It refreshes the values only and
 * leaves a held change held: the save that cleans the profile applies it,
 * counted once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ShownCopy } from './useRecordReads';
import type { LatestMeasurementsResult } from '../lib/api-types';
import type { EraseEffect, EraseState } from '../lib/erase-machine';

// The record's erase identity as read now; the screen shows 'erase-1'.
const erase = vi.hoisted(() => ({ now: 'erase-1' }));
vi.mock('../lib/roadmap-data', () => ({
  getBackendKind: () => 'local',
  getEraseIdentity: () => erase.now,
  getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../storage/roadmap-store', () => ({ REMOTE_CHANGED_EVENT: 'hr:remote-changed' }));

import { trackProductEvent } from '../lib/server-api';
import * as recordApply from './useRecordApply';
import { useRecordApply, type ReadReason } from './useRecordApply';

const RESULT = {
  inputs: { heightCm: 170, birthYear: 1981 }, previousMeasurements: [], medications: [], screenings: [], supplements: [],
} as unknown as LatestMeasurementsResult;

function setup(loaded = true) {
  const fx = {
    setInputs: vi.fn(),
    reloadValues: vi.fn(async (_shown?: ShownCopy) => RESULT),
    applyLists: vi.fn(),
    // The lists the page shows: an older statin than the record read's (none).
    lists: { medications: [{ medicationKey: 'statin', doseValue: 20 }], screenings: [] } as unknown as Pick<LatestMeasurementsResult, 'medications' | 'screenings'>,
    units: { shown: vi.fn(), offered: vi.fn(), pending: vi.fn((): undefined => undefined) },
    // The erase machine as apply sees it: the screen shows 'erase-1'; `dispatch` records each read's erase.
    erase: { getSnapshot: () => ({ shown: 'erase-1' }) as EraseState, dispatch: vi.fn((): EraseEffect[] => []) },
    later: {
      markSaved: vi.fn(), flushPendingSave: vi.fn(), flushListSaves: vi.fn(), profileDirty: vi.fn(() => false), clearAnswered: vi.fn(),
      savedProfile: vi.fn(() => ({ heightCm: 170, birthYear: 1980 })),
    },
  };
  const hook = renderHook(() => useRecordApply({
    setInputs: fx.setInputs, reloadValues: fx.reloadValues, applyLists: fx.applyLists, lists: fx.lists,
    units: fx.units as unknown as Parameters<typeof useRecordApply>[0]['units'],
    erase: fx.erase, later: () => fx.later,
  }));
  if (loaded) act(() => { hook.result.current.firstReadShown(); }); // the page's load, as HealthTool's loadData ends
  return { fx, hook };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const counted = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;

interface Seen { reads: number; form: boolean; saved: boolean; lists: boolean; flush: boolean; listFlush: boolean; erase: boolean; cleared: unknown[][]; counted: number; holdLeft: boolean }
/** What the page did on one signal, and whether a held change was still waiting after it. */
async function observe(reason: ReadReason, held: boolean): Promise<Seen> {
  const { fx, hook } = setup();
  if (held) {
    fx.later.profileDirty.mockReturnValue(true); // the profile stays dirty through the signal
    await act(async () => { await hook.result.current.signal('remote'); });
    await settle();
    expect(counted()).toBe(0); // held
  }
  vi.clearAllMocks();
  // own-save goes in where the page calls it (ownSave), so its rows test the page's path through the table.
  await act(async () => { await (reason === 'own-save' ? hook.result.current.ownSave() : hook.result.current.signal(reason)); });
  await settle();
  const seen = {
    reads: fx.reloadValues.mock.calls.length,
    form: fx.setInputs.mock.calls.length > 0,
    saved: fx.later.markSaved.mock.calls.length > 0,
    lists: fx.applyLists.mock.calls.length > 0,
    flush: fx.later.flushPendingSave.mock.calls.length > 0,
    // H52: the waiting list saves start before the read, so the lists it shows hold them.
    listFlush: fx.later.flushListSaves.mock.calls.length > 0
      && fx.later.flushListSaves.mock.invocationCallOrder[0] < fx.reloadValues.mock.invocationCallOrder[0],
    erase: fx.erase.dispatch.mock.calls.length > 0,
    cleared: fx.later.clearAnswered.mock.calls,
    counted: counted(),
  };
  // The save that cleans the profile: a change still held applies now, read and counted once.
  vi.clearAllMocks();
  await act(async () => { hook.result.current.settled(); });
  await settle();
  return { ...seen, holdLeft: counted() === 1 && fx.reloadValues.mock.calls.length === 1 };
}

const FULL = { reads: 1, form: true, saved: true, lists: true, flush: true, listFlush: true, erase: true };
const VALUES_ONLY = { reads: 1, form: false, saved: false, lists: false, flush: false, listFlush: false, erase: false };
const NONE = { reads: 0, form: false, saved: false, lists: false, flush: false, listFlush: false, erase: false };

// reason, a change held before the signal, then what the page does.
const TABLE: Array<[ReadReason, boolean, Seen]> = [
  ['upload', false, { ...FULL, cleared: [], counted: 0, holdLeft: false }],
  ['upload', true, { ...FULL, cleared: [[]], counted: 1, holdLeft: false }],
  ['refused', false, { ...FULL, cleared: [[true]], counted: 0, holdLeft: false }],
  ['refused', true, { ...FULL, cleared: [[true], []], counted: 1, holdLeft: false }],
  ['left', false, { ...FULL, cleared: [], counted: 0, holdLeft: false }],
  ['left', true, { ...FULL, cleared: [[]], counted: 1, holdLeft: false }],
  ['remote', false, { ...FULL, cleared: [[]], counted: 1, holdLeft: false }],
  ['remote', true, { ...NONE, cleared: [], counted: 0, holdLeft: true }],
  ['own-save', false, { ...VALUES_ONLY, cleared: [], counted: 0, holdLeft: false }],
  ['own-save', true, { ...VALUES_ONLY, cleared: [], counted: 0, holdLeft: true }],
];

beforeEach(() => { vi.clearAllMocks(); erase.now = 'erase-1'; });
afterEach(cleanup); // each hook stops listening for REMOTE_CHANGED

describe('US-34 AC4, AC4a: the re-read policy, by reason', () => {
  it.each(TABLE)('US-34 AC4a: %s, a change held before it: %s', async (reason, held, expected) => {
    expect(await observe(reason, held)).toEqual(expected);
  });

  it('US-34 AC4a: the policy is one table the code reads, a row per reason', () => {
    expect((recordApply as Record<string, unknown>).READ_POLICY).toEqual({
      upload: { read: 'record', relay: 'reread', spends: false },
      remote: { read: 'record', relay: 'arrive', spends: false },
      refused: { read: 'record', relay: 'reread', spends: true },
      left: { read: 'record', relay: 'reread', spends: false },
      'own-save': { read: 'values' },
    });
  });

  it('US-34 AC4a: an own-save re-read hands back the read, so the save waits for it before clearing its fields', async () => {
    const { fx, hook } = setup();
    let finish!: (r: LatestMeasurementsResult) => void;
    fx.reloadValues.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    let done = false;
    act(() => { void hook.result.current.ownSave().then(() => { done = true; }); });
    await settle();
    expect(done).toBe(false);
    await act(async () => { finish(RESULT); });
    await settle();
    expect(done).toBe(true);
  });

  it('US-34 AC9 (H15), AC10 (H16b): an own save\'s read mirrors the profile and lists the page shows while a change is held, the record\'s otherwise; the read that ends the hold mirrors the record', async () => {
    const { fx, hook } = setup();
    /** The profile each read hands the chat mirror, asked now (useRecordReads asks it as the mirror is written). */
    const mirrored = () => fx.reloadValues.mock.calls.map(([shown]) => shown?.());
    await act(async () => { await hook.result.current.ownSave(); });
    expect(mirrored()).toEqual([undefined]); // nothing held
    fx.later.profileDirty.mockReturnValue(true);
    await act(async () => { await hook.result.current.signal('remote'); }); // held
    fx.reloadValues.mockClear();
    await act(async () => { await hook.result.current.ownSave(); });
    expect(mirrored()).toEqual([{ inputs: { heightCm: 170, birthYear: 1980 }, ...fx.lists }]);
    fx.reloadValues.mockClear();
    await act(async () => { hook.result.current.settled(); });
    await settle();
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    expect(mirrored()).toEqual([undefined]); // the hold's read: the record's
  });

  it('US-34 AC4a: ownSave keeps its identity across renders, so a save built on it is not rebuilt each render', () => {
    const { hook } = setup();
    const first = hook.result.current.ownSave;
    hook.rerender();
    expect(hook.result.current.ownSave).toBe(first);
  });

  it('US-34 AC4a: ownSave reads what READ_POLICY[\'own-save\'] says, so a record policy there gives the full read', async () => {
    const kept = recordApply.READ_POLICY['own-save'];
    recordApply.READ_POLICY['own-save'] = { read: 'record', relay: 'reread', spends: false };
    try {
      const { fx, hook } = setup();
      await act(async () => { await hook.result.current.ownSave(); });
      await settle();
      expect(fx.later.flushPendingSave).toHaveBeenCalledTimes(1);
      expect(fx.setInputs).toHaveBeenCalledTimes(1);
      expect(fx.later.markSaved).toHaveBeenCalledWith(RESULT.inputs);
    } finally {
      recordApply.READ_POLICY['own-save'] = kept;
    }
  });

  it('US-11 AC6, US-34 AC4 (fix 4 2b-3): held, another device\'s erase arrives with the profile still dirty: it goes to the erase machine, whose read ends the hold, uncounted here', async () => {
    const { fx, hook } = setup();
    fx.later.profileDirty.mockReturnValue(true);
    await act(async () => { await hook.result.current.signal('remote'); });
    await settle();
    expect(counted()).toBe(0); // held
    erase.now = 'erase-2';
    fx.erase.dispatch.mockClear();
    await act(async () => { window.dispatchEvent(new CustomEvent('hr:remote-changed', { detail: { erase: 'erase-2' } })); });
    await settle();
    expect(fx.erase.dispatch.mock.calls).toEqual([[{ type: 'arrived', identity: 'erase-2' }]]); // never the relay
    expect(fx.reloadValues).not.toHaveBeenCalled();
    // The machine's read door (useErase): the record shows, the answer mark is cleared, nothing counted here.
    await act(async () => { hook.result.current.shows(1); });
    await settle();
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    expect(fx.erase.dispatch).toHaveBeenCalledWith({ type: 'read', identity: 'erase-2' });
    expect(fx.later.clearAnswered.mock.calls).toEqual([[]]);
    expect(counted()).toBe(0); // the machine counts the erase
    // The hold is over: the save that cleans the profile reads nothing more.
    await act(async () => { hook.result.current.settled(); });
    await settle();
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    expect(counted()).toBe(0);
  });

  it('fix 4 2b-3: a remote change with no erase stays the relay\'s, and the loaded page tells the machine before the relay', async () => {
    const { fx, hook } = setup(false);
    expect(fx.erase.dispatch).not.toHaveBeenCalled(); // not loaded
    await act(async () => { window.dispatchEvent(new CustomEvent('hr:remote-changed', { detail: { erase: null } })); });
    await settle();
    expect(fx.erase.dispatch).not.toHaveBeenCalled();
    expect(fx.reloadValues).not.toHaveBeenCalled(); // loading-held, in the relay
    act(() => { hook.result.current.firstReadShown(); });
    await settle();
    expect(fx.erase.dispatch.mock.calls[0]).toEqual([{ type: 'loaded', shown: true }]);
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    expect(counted()).toBe(1);
  });

  it('fix 4 2b-3 (L2, H37): a first read that fails tells the machine it failed, and a change waiting on it applies', async () => {
    const { fx, hook } = setup(false);
    await act(async () => { window.dispatchEvent(new CustomEvent('hr:remote-changed', { detail: { erase: null } })); });
    await settle();
    expect(fx.reloadValues).not.toHaveBeenCalled(); // loading-held
    act(() => { hook.result.current.firstReadFailed(new Error('first read failed (test)')); });
    await settle();
    expect(fx.erase.dispatch.mock.calls[0]).toEqual([{ type: 'loaded', shown: false }]);
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
  });

  it('US-34 AC4: before the first read is shown, a reread leaves a waiting change for that read, then it applies once', async () => {
    const { fx, hook } = setup(false);
    await act(async () => { await hook.result.current.signal('remote'); });
    await settle();
    expect(fx.reloadValues).not.toHaveBeenCalled(); // loading-held
    await act(async () => { await hook.result.current.signal('upload'); });
    await settle();
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    expect(counted()).toBe(0); // the upload's read is not the one the change waits for
    act(() => { hook.result.current.firstReadShown(); });
    await settle();
    expect(fx.reloadValues).toHaveBeenCalledTimes(2);
    expect(counted()).toBe(1);
  });

  it('US-34 AC10 (H16): a read under an earlier erase than the page shows, or one the store moved away from, writes nothing, and the form stays', async () => {
    const { fx, hook } = setup();
    const at = (epoch: number) => JSON.stringify([epoch, `2026-11-0${epoch}T10:00:00.000Z`]);
    fx.erase.getSnapshot = () => ({ shown: at(2) }) as EraseState; // the page shows a later erase than the store's read
    erase.now = at(1);
    await act(async () => { await hook.result.current.signal('own-save'); });
    await settle();
    // One values read, told to write nothing (useRecordReads: a null copy replaces and writes nothing).
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    const shown = fx.reloadValues.mock.calls[0][0]!;
    expect(shown()).toBeNull();
    // A read of the erase shown writes the record's (nothing held); the store moves while it is on its way: nothing.
    erase.now = at(2);
    await act(async () => { await hook.result.current.signal('own-save'); });
    const moved = fx.reloadValues.mock.calls[1][0]!;
    expect(moved()).toBeUndefined();
    erase.now = at(3);
    expect(moved()).toBeNull();
    // The form, its saved copy and the units stay the old record's, and the erase is not shown here.
    expect(fx.setInputs).not.toHaveBeenCalled();
    expect(fx.later.markSaved).not.toHaveBeenCalled();
    expect(fx.units.shown).not.toHaveBeenCalled();
    expect(fx.erase.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'read' })); // (its one call: the loaded page, 2b-3)
    // Nothing of the old record is written back: no waiting save started, no list or answer change.
    expect(fx.later.flushPendingSave).not.toHaveBeenCalled();
    expect(fx.later.flushListSaves).not.toHaveBeenCalled();
    expect(fx.applyLists).not.toHaveBeenCalled();
    expect(fx.later.clearAnswered).not.toHaveBeenCalled();
    expect(counted()).toBe(0);
  });
});
