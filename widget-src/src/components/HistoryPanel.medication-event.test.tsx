// @vitest-environment jsdom
/**
 * US-06 AC4 usage signal, end to end: `medication_history_viewed` had 0 events
 * in eight weeks (product-health W38-W44, Suspect). This runs the live chain on
 * a real store: a statin saved the way the widget saves it, an LDL value, the
 * history lightbox opened as a "previous value" link opens it, and the real
 * `trackProductEvent` with its Shopify gate and per-tab throttle. Only fetch
 * and the chart library are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, openHistoryLightbox, saveMedication } from '../lib/roadmap-data';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('chart.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('chart.js')>()),
  Chart: class { static register() {} constructor() {} destroy() {} update() {} },
}));
import { HistoryLightboxHost } from '../../standalone/history-lightbox';
// Loaded up front, so the lightbox's lazy import resolves without a bundler.
import './HistoryPanel';

let sent: Array<{ eventName: string; metadata?: unknown }> = [];
const viewed = () => sent.filter((e) => e.eventName === 'medication_history_viewed');
const stops: Array<() => void> = [];

beforeEach(async () => {
  sent = [];
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/events')) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{"success":true}');
    }
    throw new Error('Synthetic test: no network');
  }));
  HTMLDialogElement.prototype.showModal ??= function(this: HTMLDialogElement) { this.open = true; };
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function openHistory(metric: string) {
  act(() => { openHistoryLightbox(metric); });
}

describe('US-06 AC4: medication_history_viewed on a real store', () => {
  it('fires once, with no metadata, when the LDL history opens on a record with a recorded statin start', async () => {
    expect(await addMeasurement('ldl', 3.4, '2026-08-01T00:00:00.000Z')).toMatchObject({ status: 'inserted' });
    expect(await saveMedication('statin', 'atorvastatin', 20, 'mg')).toBe(true);
    await flushRoadmapStore();

    const view = render(<HistoryLightboxHost />);
    openHistory('ldl');
    await waitFor(() => expect(view.getByText(/Recorded start: Atorvastatin 20mg/)).toBeTruthy(), { timeout: 10_000 });
    await waitFor(() => expect(viewed()).toHaveLength(1));
    // Name and visitor id only: no drug, dose, date or value reaches telemetry.
    expect(Object.keys(viewed()[0]).sort()).toEqual(['eventName', 'visitorId']);

    // Reopening in the same tab is throttled: one view per tab.
    view.unmount();
    const again = render(<HistoryLightboxHost />);
    openHistory('ldl');
    await waitFor(() => expect(again.getByText(/Recorded start: Atorvastatin 20mg/)).toBeTruthy(), { timeout: 10_000 });
    expect(viewed()).toHaveLength(1);
  });

  it('stays silent when the opened chart carries no marker (weight with only a statin)', async () => {
    await addMeasurement('weight', 70, '2026-08-01T00:00:00.000Z');
    await saveMedication('statin', 'atorvastatin', 20, 'mg');
    await flushRoadmapStore();

    const view = render(<HistoryLightboxHost />);
    openHistory('weight');
    await waitFor(() => expect(view.getByText('Show recorded medication changes')).toBeTruthy(), { timeout: 10_000 });
    expect(viewed()).toHaveLength(0);
  });
});
