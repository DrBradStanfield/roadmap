// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryAdapter, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';

// Real form, data layer, session and device storage; no off-device requests.
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
let data: typeof import('../lib/roadmap-data');
let LocalStorageAdapter: typeof import('../storage/local-storage-adapter').LocalStorageAdapter;
let HealthTool: typeof import('./HealthTool').HealthTool;
const stops: Array<() => void> = [];
const saved = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile;

beforeEach(async () => {
  // A fresh page also resets the page-lifetime log-off barrier.
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  data = await import('../lib/roadmap-data');
  ({ LocalStorageAdapter } = await import('../storage/local-storage-adapter'));
  const { RoadmapStore } = await import('../storage/roadmap-store');
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: typeof RoadmapStore.prototype) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  const { registerPageDeparture } = await import('../../standalone/page-departure');
  stops.push(registerPageDeparture(vi.fn()));
  ({ HealthTool } = await import('./HealthTool'));
  await data.initRoadmapStore(new LocalStorageAdapter());
  await data.saveChangedMeasurements({ sex: 'male', heightCm: 178, birthMonth: 5, unitSystem: 'si' }, {});
  await data.flushRoadmapStore();
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function form() {
  const view = render(<HealthTool />);
  await act(async () => {}); // hydration, not the 500 ms autosave
  const year = view.container.querySelector<HTMLInputElement>('#birthYear')!;
  expect(year).toBeTruthy();
  const { trackProductEvent } = await import('../lib/server-api');
  vi.mocked(trackProductEvent).mockClear();
  // An edit can re-render the field, so a blur goes to the one on the page.
  const live = () => view.container.querySelector<HTMLInputElement>('#birthYear')!;
  return { view, year, live };
}

// Entrypoint listeners registered before render; jsdom models delivery only.
// This is not a real browser unload or a live-provider test.
function depart(event: 'beforeunload' | 'visibilitychange' | 'pagehide') {
  act(() => {
    if (event !== 'visibilitychange') window.dispatchEvent(new Event(event));
    else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event(event));
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });
}

it.each(['beforeunload', 'visibilitychange', 'pagehide'] as const)(
  'US-01 AC4: a valid birth year is staged before %s and survives immediate reload', async event => {
    const { view, year, live } = await form();
    fireEvent.change(year, { target: { value: '1975' } });
    fireEvent.blur(live());
    depart(event);
    // Read synchronously before any timer or promise continuation can rescue it.
    expect(saved().profile.birthYear).toBe(1975);
    expect(saved().profile).toMatchObject({ sex: 'male', heightCm: 178, birthMonth: 5 });
    view.unmount();
    await data.initRoadmapStore(new LocalStorageAdapter());
    const reloaded = await form();
    expect(reloaded.year.value).toBe('1975');
  },
);

it('US-01 AC4: hydration and departure without an edit leave the saved bytes and revision unchanged', async () => {
  const before = new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME);
  await form();
  depart('beforeunload');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME)).toEqual(before);
});

it('US-01 AC4: rapid profile edits retain the latest year while persistence remains debounced', async () => {
  const { year } = await form();
  const write = vi.spyOn(LocalStorageAdapter.prototype, 'write');
  fireEvent.change(year, { target: { value: '1975' } });
  fireEvent.change(year, { target: { value: '1976' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1299); });
  expect(write).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(saved().profile.birthYear).toBe(1976);
});

it.each(['1800', '3000', '197'])(
  'US-01 AC4: birth-year validation still refuses or clears %s before departure', async value => {
    const { year, live } = await form();
    fireEvent.change(year, { target: { value } });
    fireEvent.blur(live());
    depart('beforeunload');
    expect(saved().profile.birthYear ?? null).toBeNull();
  },
);

it('US-10 AC9: an explicit birth-year clear is staged before departure', async () => {
  const { year } = await form();
  fireEvent.change(year, { target: { value: '1975' } });
  await act(async () => {});
  depart('beforeunload');
  expect(saved().profile.birthYear).toBe(1975);
  await act(async () => {}); // a later user event follows the prior task's microtasks
  fireEvent.change(year, { target: { value: '' } });
  depart('beforeunload');
  expect(saved().profile.birthYear).toBeNull();
});

it('US-11: departure after an erase here never replays a staged birth year', async () => {
  const { view, year } = await form();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  fireEvent.change(year, { target: { value: '1975' } });
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Delete All My Data' }));
  });
  expect(saved().meta.eraseEpoch).toBe(1);
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    depart('beforeunload');
    depart('visibilitychange');
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(saved().profile.birthYear ?? null).toBeNull();
  expect(saved().profile.heightCm ?? null).toBeNull();
});

it('US-11: departure merges an erase in another tab instead of resurrecting the old demographics', async () => {
  const { year } = await form();
  fireEvent.change(year, { target: { value: '1975' } });
  await act(async () => {});
  const { RoadmapStore } = await import('../storage/roadmap-store');
  await act(async () => {
    const other = await RoadmapStore.create(new LocalStorageAdapter());
    expect((await other.deleteAllData()).success).toBe(true);
    depart('beforeunload');
    depart('visibilitychange');
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(saved().meta.eraseEpoch).toBe(1);
  expect(saved().profile.birthYear ?? null).toBeNull();
  expect(saved().profile.heightCm ?? null).toBeNull();
});

it.each([false, true])('US-09 AC2c: log-off followed by lifecycle events cannot recreate demographics (save started=%s)', async started => {
  const { year } = await form();
  vi.stubGlobal('location', { reload: vi.fn(), search: '', href: 'http://localhost/' });
  const { logOff } = await import('../../standalone/connect');
  fireEvent.change(year, { target: { value: '1975' } });
  await act(async () => {
    if (started) vi.advanceTimersByTime(500); // stage, but hold its await continuation
    await logOff('local');
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    depart('beforeunload');
    depart('visibilitychange');
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(saved()).toBeNull();
  expect(localStorage.getItem('health_roadmap_data')).toBeNull();
  expect(location.reload).toHaveBeenCalledTimes(1);
});

// US-01 AC4: app switching need not blur the focused field (notably WebKit).
it.each(['19', '197', '1800'])(
  'US-01 AC4: hiding without blur refuses partial year %s while retaining valid edits', async value => {
    await data.saveChangedMeasurements({ birthYear: 1975 }, {});
    await data.flushRoadmapStore();
    const { view, year } = await form();
    fireEvent.change(year, { target: { value } });
    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '180' } });
    depart('visibilitychange');
    expect(saved().profile.birthYear).toBe(1975);
    expect(saved().profile.heightCm).toBe(180);
  },
);

it('US-01 AC4: hiding without blur refuses partial height without clearing the saved height', async () => {
  const { view, year } = await form();
  fireEvent.change(year, { target: { value: '1975' } });
  fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '17' } });
  depart('visibilitychange');
  expect(saved().profile.heightCm).toBe(178);
  expect(saved().profile.birthYear).toBe(1975);
});

it.each(['departure', 'debounce'] as const)(
  'US-09 AC2c: another tab log-off stops only local copies, not cloud profile saves via %s', async mode => {
    const cloud = new MemoryAdapter();
    await data.initRoadmapStore(cloud);
    await data.saveChangedMeasurements({ sex: 'male', heightCm: 178, birthMonth: 5, unitSystem: 'si' }, {});
    await data.flushRoadmapStore();
    const { year } = await form();
    // The cloud tab receives the real content-free cross-tab signal.
    window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_signal', newValue: '1' }));
    localStorage.clear();
    fireEvent.change(year, { target: { value: '1975' } });
    if (mode === 'departure') depart('visibilitychange');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); await data.flushRoadmapStore(); });
    expect((await cloud.read(ROADMAP_FILE_NAME)).body).toMatchObject({ profile: { birthYear: 1975 } });
    expect(saved()).toBeNull();
    expect(localStorage.getItem('health_roadmap_data')).toBeNull();
  },
);

it('US-01 AC4: a refused no-blur draft remains editable and the completed year saves normally', async () => {
  const { year } = await form();
  fireEvent.change(year, { target: { value: '197' } });
  depart('visibilitychange');
  expect(saved().profile.birthYear ?? null).toBeNull();
  expect(year.value).toBe('197');
  fireEvent.change(year, { target: { value: '1975' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(saved().profile.birthYear).toBe(1975);
});

// The real relay and reload path stay connected; only the remote transport is
// represented by an already-merged store update and its normal notification.
async function remoteMonth() {
  const { REMOTE_CHANGED_EVENT } = await import('../storage/roadmap-store');
  await act(async () => {
    await data.saveChangedMeasurements({ birthMonth: 6 }, { birthMonth: 5 });
    window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT));
  });
}
async function appliedRemote() {
  const { trackProductEvent } = await import('../lib/server-api');
  return vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;
}

it.each(['1975', '1976', ''])(
  'US-34 AC4: partial save holds remote replay until the year is corrected or cleared (%s)', async correction => {
    await data.saveChangedMeasurements({ birthYear: 1975 }, {});
    const { view, year } = await form();
    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '180' } });
    fireEvent.change(year, { target: { value: '197' } });
    await remoteMonth();
    expect(await appliedRemote()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(saved().profile.heightCm).toBe(180);
    expect(saved().profile.birthYear).toBe(1975);
    const liveYear = view.container.querySelector<HTMLInputElement>('#birthYear')!;
    expect(liveYear.value).toBe('197');
    expect(await appliedRemote()).toBe(0);
    fireEvent.change(liveYear, { target: { value: correction } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(saved().profile.birthYear).toBe(correction ? Number(correction) : null);
    expect(view.container.querySelector<HTMLInputElement>('#birthYear')!.value).toBe(correction);
    expect(view.container.querySelector<HTMLSelectElement>('#birthMonth')!.value).toBe('6');
    expect(await appliedRemote()).toBe(1);
  },
);

it('US-34 AC4: clearing an unsaved refused year releases a held update even with no profile write', async () => {
  const { year } = await form();
  fireEvent.change(year, { target: { value: '197' } });
  await remoteMonth();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(year.value).toBe('197');
  expect(await appliedRemote()).toBe(0);
  fireEvent.change(year, { target: { value: '' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(year.value).toBe('');
  expect(await appliedRemote()).toBe(1);
});

it('US-34 AC4: an edit arriving while a valid save awaits also holds remote replay', async () => {
  await data.saveChangedMeasurements({ birthYear: 1975 }, {});
  const { view, year } = await form();
  const save = data.saveChangedMeasurements;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(data, 'saveChangedMeasurements').mockImplementationOnce(async (...args) => {
    const result = await save(...args);
    await waiting;
    return result;
  });
  fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '180' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  fireEvent.change(year, { target: { value: '197' } });
  await remoteMonth();
  await act(async () => { release(); });
  const liveYear = view.container.querySelector<HTMLInputElement>('#birthYear')!;
  expect(liveYear.value).toBe('197');
  expect(await appliedRemote()).toBe(0);
  fireEvent.change(liveYear, { target: { value: '1976' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(view.container.querySelector<HTMLInputElement>('#birthYear')!.value).toBe('1976');
  expect(saved().profile.birthYear).toBe(1976);
  expect(await appliedRemote()).toBe(1);
});

// A blur refuses an out-of-range year; the refusal is not a clear.
it.each(['beforeunload', 'visibilitychange', 'pagehide', 'debounce'] as const)(
  'US-01 AC4: a refused year blurred before %s keeps the saved year through reload', async mode => {
    await data.saveChangedMeasurements({ birthYear: 1975 }, {});
    await data.flushRoadmapStore();
    const { view, year, live } = await form();
    fireEvent.change(year, { target: { value: '197' } });
    fireEvent.blur(live());
    expect(live().value).toBe('1975');
    if (mode === 'debounce') await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    else depart(mode);
    expect(saved().profile.birthYear).toBe(1975);
    view.unmount();
    await data.initRoadmapStore(new LocalStorageAdapter());
    const reloaded = await form();
    expect(reloaded.year.value).toBe('1975');
  },
);

it('US-09 AC2c: a held remote update released after another tab logs off does not rewrite the device copy', async () => {
  const cloud = new MemoryAdapter();
  await data.initRoadmapStore(cloud);
  await data.saveChangedMeasurements({ sex: 'male', heightCm: 178, birthMonth: 5, unitSystem: 'si' }, {});
  await data.flushRoadmapStore();
  const { year } = await form();
  fireEvent.change(year, { target: { value: '1975' } });
  await remoteMonth();
  expect(await appliedRemote()).toBe(0);
  window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_signal', newValue: '1' }));
  localStorage.clear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); await data.flushRoadmapStore(); });
  expect((await cloud.read(ROADMAP_FILE_NAME)).body).toMatchObject({ profile: { birthYear: 1975, birthMonth: 6 } });
  expect(await appliedRemote()).toBe(1);
  expect(localStorage.getItem('health_roadmap_data')).toBeNull();
});

it('US-10 AC9: an explicit height clear still saves without blur', async () => {
  const { view } = await form();
  fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '' } });
  depart('visibilitychange');
  expect(saved().profile.heightCm).toBeNull();
});
