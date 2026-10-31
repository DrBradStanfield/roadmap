// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

// Only off-device boundaries are mocked; the form, autosave and store are real.
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
import { HealthTool } from './HealthTool';

const stops: Array<() => void> = [];
const saved = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile;
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1800); });

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 5, unitSystem: 'si' }, {});
  await addMeasurement('weight', 80, '2026-10-01'); // the onboarding done: the birth date shows (US-62 AC13)
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([
  ['birthMonth', '5'], ['birthYear', '1980'], ['heightCm', '178'],
] as const)('US-10 AC9: clearing %s survives autosave and a fresh store/component load', async (field, initial) => {
  const view = render(<HealthTool />);
  const input = await waitFor(() => {
    const el = view.container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${field}`);
    expect(el?.value).toBe(initial);
    return el!;
  });
  fireEvent.change(input, { target: { value: '' } });
  expect(input.value).toBe('');
  await tick();
  await act(async () => { await flushRoadmapStore(); });
  expect(saved().profile[field]).toBeNull();
  view.unmount();
  await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
  const reloaded = render(<HealthTool />);
  await waitFor(() => expect(reloaded.container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${field}`)?.value).toBe(''));
});

it('US-10 AC9: changing Birth Month to another value still survives autosave and a fresh load', async () => {
  const view = render(<HealthTool />);
  const month = await waitFor(() => {
    const el = view.container.querySelector<HTMLSelectElement>('#birthMonth');
    expect(el?.value).toBe('5'); return el!;
  });
  fireEvent.change(month, { target: { value: '6' } });
  await tick();
  await act(async () => { await flushRoadmapStore(); });
  expect(saved().profile.birthMonth).toBe(6);
  view.unmount();
  await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
  const reloaded = render(<HealthTool />);
  await waitFor(() => expect(reloaded.container.querySelector<HTMLSelectElement>('#birthMonth')?.value).toBe('6'));
});
