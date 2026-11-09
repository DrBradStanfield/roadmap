// @vitest-environment jsdom
/**
 * US-02 AC5, US-34 AC4, US-54 AC5b: the profile's save, its four states
 * (clean, waiting, saving, kept). Page journeys: HealthTool.*profile* and
 * HealthTool.remote-* tests; these check the hook's own rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, useRef, useState } from 'react';
import { renderHook } from '@testing-library/react';
import type { HealthInputs } from '@roadmap/health-core/types';

type SaveResult = { ok: boolean; refused?: Record<string, unknown>; birthRefused?: { birthYear?: number; birthMonth?: number } };
const store = vi.hoisted(() => ({
  saves: [] as Array<{ current: unknown; previous: unknown; erase?: string }>,
  next: { ok: true } as SaveResult,
  erase: 'e1',
  /** Holds the write on its way until the test opens it. */
  gate: null as null | Promise<void>,
}));
vi.mock('../lib/roadmap-data', () => ({
  getBackendKind: () => 'cloud',
  getShownErase: () => store.erase,
  saveChangedMeasurements: async (current: unknown, previous: unknown, erase?: string) => {
    store.saves.push({ current, previous, erase });
    if (store.gate) await store.gate;
    return store.next;
  },
}));
const mirror = vi.hoisted(() => ({ patches: [] as unknown[] }));
vi.mock('../lib/storage', () => ({ localHealthWritesStopped: () => false, patchMirror: (p: unknown) => { mirror.patches.push(p); } }));

import { useProfileSave } from './useProfileSave';

function setup(start: Partial<HealthInputs> = {}) {
  const relay = { saved: vi.fn() };
  const writeRefused = vi.fn();
  const view = renderHook(() => {
    const [inputs, setInputs] = useState<Partial<HealthInputs>>(start);
    const inputsRef = useRef(inputs);
    inputsRef.current = inputs;
    const save = useProfileSave({ inputs, inputsRef, setInputs, loaded: true, onClean: relay.saved, writeRefused });
    return { save, inputs, setInputs };
  });
  return { view, relay, writeRefused };
}

beforeEach(() => {
  store.saves = [];
  store.next = { ok: true };
  store.erase = 'e1';
  store.gate = null;
  mirror.patches = [];
  vi.useRealTimers();
});

describe('US-34 AC4: clean releases a held remote change', () => {
  it('nothing to save: the relay is released and no write is made', async () => {
    const { view, relay } = setup({ heightCm: 170 });
    act(() => view.result.current.save.markSaved({ heightCm: 170 }));
    expect(view.result.current.save.profileDirty()).toBe(false);
    await act(async () => { expect(await view.result.current.save.flushProfile()).toBe(true); });
    expect(store.saves).toEqual([]);
    expect(relay.saved).toHaveBeenCalledTimes(1);
  });

  it('an edit is dirty; its save sends only the profile, against the saved copy, then releases the relay', async () => {
    const { view, relay } = setup({ heightCm: 170 });
    act(() => view.result.current.save.markSaved({ heightCm: 170 }));
    act(() => view.result.current.setInputs(p => ({ ...p, heightCm: 172, weightKg: 80 })));
    expect(view.result.current.save.profileDirty()).toBe(true);
    await act(async () => { await view.result.current.save.flushProfile('e1'); });
    expect(store.saves).toEqual([{ current: { heightCm: 172 }, previous: { heightCm: 170 }, erase: 'e1' }]);
    expect(view.result.current.save.profileDirty()).toBe(false);
    expect(relay.saved).toHaveBeenCalledTimes(1);
  });
});

describe('waiting: the 500 ms timer', () => {
  it('an edit saves after 500 ms with the erase it was made against; cancel drops it', async () => {
    vi.useFakeTimers();
    const { view } = setup({});
    act(() => view.result.current.setInputs({ heightCm: 180 }));
    store.erase = 'e2'; // an erase lands before the timer fires
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(store.saves).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(store.saves).toEqual([{ current: { heightCm: 180 }, previous: {}, erase: 'e1' }]);
    store.erase = 'e1';
    act(() => view.result.current.setInputs({ heightCm: 181 }));
    act(() => view.result.current.save.profileTimer.cancel());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(store.saves).toHaveLength(1);
  });
});

describe('saving: what a save leaves behind', () => {
  it('US-34 AC4: an edit made while the save is on its way keeps a remote change held', async () => {
    const { view, relay } = setup({});
    act(() => view.result.current.setInputs({ heightCm: 180 }));
    let open!: () => void;
    store.gate = new Promise<void>(r => { open = r; });
    const pending = view.result.current.save.flushProfile();
    act(() => view.result.current.setInputs(p => ({ ...p, heightCm: 181 })));
    await act(async () => { open(); await pending; });
    expect(relay.saved).not.toHaveBeenCalled();
    expect(view.result.current.save.profileDirty()).toBe(true);
  });

  it('US-15 AC10: the chat copy gets the saved profile', async () => {
    const { view } = setup({});
    act(() => view.result.current.setInputs({ heightCm: 180, sex: 'male' }));
    await act(async () => { await view.result.current.save.flushProfile(); });
    expect(mirror.patches).toEqual([{ profile: { heightCm: 180, sex: 'male' } }]);
  });

  it('the timer saves the values of the render that scheduled it; flush runs it at once (a closing tab)', async () => {
    vi.useFakeTimers();
    const { view } = setup({});
    act(() => view.result.current.setInputs({ heightCm: 180 }));
    act(() => view.result.current.save.profileTimer.flush());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(store.saves).toEqual([{ current: { heightCm: 180 }, previous: {}, erase: 'e1' }]);
  });

  it('markSaved keeps its own copy of the record', () => {
    const { view } = setup({ heightCm: 170 });
    const record: Partial<HealthInputs> = { heightCm: 170 };
    act(() => view.result.current.save.markSaved(record));
    record.heightCm = 999;
    expect(view.result.current.save.profileDirty()).toBe(false);
  });
});

describe('kept: what the store refuses', () => {
  it('US-02 AC5: an out-of-range value stays unsaved and dirty, and the relay keeps holding', async () => {
    const { view, relay } = setup({});
    act(() => view.result.current.setInputs({ heightCm: 999 }));
    store.next = { ok: true, refused: { heightCm: 999 } };
    await act(async () => { await view.result.current.save.flushProfile(); });
    expect(view.result.current.save.profileDirty()).toBe(true);
    expect(relay.saved).not.toHaveBeenCalled();
  });

  it('US-54 AC5b: a refused birth pair goes back to the record\'s and says why until the next birth edit', async () => {
    const { view } = setup({ birthYear: 1980, birthMonth: 3 });
    act(() => view.result.current.save.markSaved({ birthYear: 1980, birthMonth: 3 }));
    act(() => view.result.current.setInputs({ birthYear: 2030, birthMonth: 1 }));
    store.next = { ok: true, birthRefused: { birthYear: 2030, birthMonth: 1 } };
    await act(async () => { await view.result.current.save.flushProfile(); });
    expect(view.result.current.inputs).toMatchObject({ birthYear: 1980, birthMonth: 3 });
    expect(view.result.current.save.birthRefused).toEqual(expect.any(String));
    act(() => view.result.current.save.clearBirthRefused());
    expect(view.result.current.save.birthRefused).toBeNull();
  });

  it('US-16 AC2a: a write the store refuses outright is reported and returns false', async () => {
    const { view, writeRefused, relay } = setup({});
    act(() => view.result.current.setInputs({ sex: 'female' }));
    store.next = { ok: false };
    await act(async () => { expect(await view.result.current.save.flushProfile()).toBe(false); });
    expect(writeRefused).toHaveBeenCalledTimes(1);
    expect(relay.saved).not.toHaveBeenCalled();
  });
});
