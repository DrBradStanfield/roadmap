// @vitest-environment jsdom
/**
 * US-75 AC8, the widgets page and a newer erase: another device's erase reaches this page only by a re-read (the
 * live refresh, or the flush inside a save). The page then marks it shown and starts every widget over, so nothing
 * typed under the old erase stays on screen or lands in the erased record. Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { migrateFile } from '@roadmap/health-core/migrate';
import { rowRootIds } from '@roadmap/health-core/merge';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { BloodPressureWidget } from './BloodPressure';
import { WaistToHeightWidget } from './WaistToHeight';
import { FollowErase } from './FollowErase';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

let cloud: MemoryCloud;
let store: RoadmapStore;
const persisted = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
const active = (metric: string) => persisted().measurements.filter((m) => m.metricType === metric && m.status === 'active').map((m) => m.value);
const reading = (n: 1 | 2) => within(screen.getByRole('group', { name: new RegExp(`^Reading ${n}`) }));
const bpBox = (n: 1 | 2, half: 'top' | 'bottom') => reading(n).getByLabelText(half === 'top' ? /^Systolic/ : /^Diastolic/) as HTMLInputElement;
const enterPair = (n: 1 | 2, sys: string, dia: string) => {
  fireEvent.change(bpBox(n, 'top'), { target: { value: sys } });
  fireEvent.change(bpBox(n, 'bottom'), { target: { value: dia } });
};
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
/** Leave the readings, as a tap elsewhere does (useSaveOnLeave), and let the save land. */
const leave = async () => {
  fireEvent.pointerDown(bpBox(1, 'top'));
  fireEvent.pointerDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.focusIn(document.body);
  await pause(20);
};

/** Another device erases the record in the cloud, as its deleteUserData writes it. This page has not heard yet. */
async function anotherDeviceErases() {
  await act(() => data.flushRoadmapStore());
  const adapter = new MemoryAdapter(cloud);
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  const prior = migrateFile(body, { deviceId: 'other-device', now });
  const erased = migrateFile(null, { deviceId: 'other-device', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = now;
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
}
/** The live refresh's re-read (RoadmapStore.startLiveRefresh's `reread`), as it runs on the page. */
const reread = async () => { await act(async () => { await store.refreshFromRemote(); }); await pause(0); };

beforeEach(async () => {
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) { store = this; return () => {}; });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no HTTP')));
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  localStorage.setItem('health_roadmap_unit_system', 'si');
  cloud = new MemoryCloud();
  await data.initRoadmapStore(new MemoryAdapter(cloud));
  await data.addMeasurement('weight', 70, undefined, data.getShownErase()); // the record has something to erase
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await data.flushRoadmapStore();
  vi.unstubAllGlobals();
});

describe('US-75 AC8: the widgets page follows a newer erase by starting over', () => {
  it('a re-read brings an erase: the readings on screen go; one typed afterwards is kept and the next step follows', async () => {
    const navigate = vi.fn();
    render(<FollowErase><BloodPressureWidget nextUrl="/next" navigate={navigate} /></FollowErase>);
    enterPair(1, '128', '82');
    const before = data.getEraseIdentity();
    await anotherDeviceErases();
    await reread();
    expect(data.getEraseIdentity()).not.toBe(before);
    expect(data.getShownErase()).toBe(data.getEraseIdentity());
    expect([bpBox(1, 'top').value, bpBox(1, 'bottom').value]).toEqual(['', '']);
    enterPair(1, '130', '84');
    fireEvent.click(screen.getByRole('link'));
    await pause(20);
    expect(active('systolic_bp')).toEqual([130]);
    expect(navigate).toHaveBeenCalledWith('/next');
  });

  it('a reading typed before an erase never lands in the erased record, a second reading typed after it included', async () => {
    render(<FollowErase><BloodPressureWidget /></FollowErase>);
    enterPair(1, '128', '82');
    await anotherDeviceErases();
    await reread();
    enterPair(2, '140', '90');
    await leave();
    expect(active('systolic_bp')).toEqual([140]);
    expect(active('diastolic_bp')).toEqual([90]);
  });

  it('a save asked after the store took the erase in, before the page shows it, writes nothing', async () => {
    render(<BloodPressureWidget />); // no FollowErase: the shown erase stays the one the reading was typed under
    enterPair(1, '128', '82');
    await anotherDeviceErases();
    await reread();
    expect(data.getShownErase()).not.toBe(data.getEraseIdentity());
    await leave();
    expect(active('systolic_bp')).toEqual([]);
  });

  it('the waist widget on the same page starts over too: its typed values go', async () => {
    render(<>
      <FollowErase><WaistToHeightWidget /></FollowErase>
      <FollowErase><BloodPressureWidget /></FollowErase>
    </>);
    const waist = screen.getByLabelText(/^Waist/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.input(waist, { target: { value: '88' } });
    enterPair(1, '128', '82');
    await anotherDeviceErases();
    await reread();
    expect((screen.getByLabelText(/^Waist/, { selector: 'input' }) as HTMLInputElement).value).toBe('');
    expect(bpBox(1, 'top').value).toBe('');
  });
});
