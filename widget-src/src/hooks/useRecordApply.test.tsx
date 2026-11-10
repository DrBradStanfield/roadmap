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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LatestMeasurementsResult } from '../lib/api-types';

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

function setup() {
  const fx = {
    setInputs: vi.fn(),
    reloadValues: vi.fn(async () => RESULT),
    applyLists: vi.fn(),
    units: { shown: vi.fn(), offered: vi.fn(), pending: vi.fn((): undefined => undefined) },
    showErase: vi.fn(),
    later: { markSaved: vi.fn(), flushPendingSave: vi.fn(), profileDirty: vi.fn(() => false), clearAnswered: vi.fn() },
  };
  const hook = renderHook(() => useRecordApply({
    setInputs: fx.setInputs, reloadValues: fx.reloadValues, applyLists: fx.applyLists,
    units: fx.units as unknown as Parameters<typeof useRecordApply>[0]['units'],
    showErase: fx.showErase, loaded: true, later: () => fx.later,
  }));
  return { fx, hook };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const counted = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;

interface Seen { reads: number; form: boolean; saved: boolean; lists: boolean; flush: boolean; erase: boolean; cleared: unknown[][]; counted: number; holdLeft: boolean }
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
  await act(async () => { await hook.result.current.signal(reason); });
  await settle();
  const seen = {
    reads: fx.reloadValues.mock.calls.length,
    form: fx.setInputs.mock.calls.length > 0,
    saved: fx.later.markSaved.mock.calls.length > 0,
    lists: fx.applyLists.mock.calls.length > 0,
    flush: fx.later.flushPendingSave.mock.calls.length > 0,
    erase: fx.showErase.mock.calls.length > 0,
    cleared: fx.later.clearAnswered.mock.calls,
    counted: counted(),
  };
  // The save that cleans the profile: a change still held applies now, read and counted once.
  vi.clearAllMocks();
  await act(async () => { hook.result.current.saved(); });
  await settle();
  return { ...seen, holdLeft: counted() === 1 && fx.reloadValues.mock.calls.length === 1 };
}

const FULL = { reads: 1, form: true, saved: true, lists: true, flush: true, erase: true };
const VALUES_ONLY = { reads: 1, form: false, saved: false, lists: false, flush: false, erase: false };
const NONE = { reads: 0, form: false, saved: false, lists: false, flush: false, erase: false };

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
    act(() => { void (hook.result.current.signal('own-save') as Promise<void>).then(() => { done = true; }); });
    await settle();
    expect(done).toBe(false);
    await act(async () => { finish(RESULT); });
    await settle();
    expect(done).toBe(true);
  });

  it('US-34 AC4a (today, fix 4 owns erase events): another device erased between the save and its re-read: the new record\'s values show beside the old form, and nothing is written back', async () => {
    const { fx, hook } = setup();
    erase.now = 'erase-2'; // the store holds the other device's erase; the screen still shows erase-1
    await act(async () => { await hook.result.current.signal('own-save'); });
    await settle();
    // The values, lab rows, matrices and chat mirror are the new record's (reloadValues reads the store).
    expect(fx.reloadValues).toHaveBeenCalledTimes(1);
    // The form, its saved copy and the units stay the old record's, and the erase is not shown:
    // a mixed picture until the erase's own remote signal applies (never held across an erase).
    expect(fx.setInputs).not.toHaveBeenCalled();
    expect(fx.later.markSaved).not.toHaveBeenCalled();
    expect(fx.units.shown).not.toHaveBeenCalled();
    expect(fx.showErase).not.toHaveBeenCalled();
    // Nothing of the old record is written back: no waiting save started, no list or answer change.
    expect(fx.later.flushPendingSave).not.toHaveBeenCalled();
    expect(fx.applyLists).not.toHaveBeenCalled();
    expect(fx.later.clearAnswered).not.toHaveBeenCalled();
    expect(counted()).toBe(0);
  });
});
