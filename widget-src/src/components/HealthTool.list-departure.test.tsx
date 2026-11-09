// @vitest-environment jsdom
/**
 * US-06 AC13: a medication, screening or supplement change made just before
 * the tab goes away is saved. Each list change waits 300 ms before it saves;
 * the page-leave events run that wait at once and write the record.
 *
 * The real InputPanel -> HealthTool -> RoadmapStore -> localStorage path, with
 * synthetic data. Page-leave events are simulated in jsdom; no real browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, type WriteResult } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import {
  addMeasurement, flushRoadmapStore, initRoadmapStore, loadAllHistory, loadLatestMeasurements, saveChangedMeasurements, saveMedication, saveScreening,
  saveSupplement,
} from '../lib/roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { isSyncPending } from '../storage';
import { BACKEND_KEY } from '../storage/web-record-host';
import { DropboxAdapter } from '../storage/dropbox';
import { GoogleDriveAdapter } from '../storage/drive';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

/** 178 cm, 101.4 kg (BMI 32), born 1960: the GLP-1 field and the DEXA question both show. */
async function page(selector: string) {
  await seedGuest({ sex: 'female', heightCm: 178, birthYear: 1960, birthMonth: 1 }, [['weight', 101.4]],
    [['glp1', 'semaglutide_injection', 1]]);
  await saveSupplement('custom_test_supplement', 'Test supplement', 25, 'mg');
  await saveScreening('dexa_screening', 'not_yet_started');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
  return view;
}

/** The record as the device holds it now, with no further wait. */
function onDevice(): RoadmapFile {
  const raw = localStorage.getItem('health_roadmap_file_v2');
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as RoadmapFile;
}

const leave: Record<string, () => void> = {
  beforeunload: () => window.dispatchEvent(new Event('beforeunload')),
  pagehide: () => window.dispatchEvent(new Event('pagehide')),
  'visibilitychange: hidden': () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};

/** A fresh page load: a new store over the same device storage. */
async function reloaded() {
  await initRoadmapStore(new LocalStorageAdapter());
  return loadLatestMeasurements();
}

describe('US-06 AC13: a list change made just before the tab goes away is saved', () => {
  afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); });

  describe.each(Object.keys(leave))('%s', event => {
    it('a medication dose change', async () => {
      const view = await page('#glp1-dose');
      fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
      act(() => leave[event]());
      expect(onDevice().medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1.7);
      view.unmount();
      expect((await reloaded())?.medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1.7);
    });

    it('a screening answer', async () => {
      const view = await page('#dexa-screening');
      fireEvent.change(view.container.querySelector('#dexa-screening')!, { target: { value: 'dexa_scan' } });
      act(() => leave[event]());
      expect(JSON.stringify(onDevice().screenings)).toContain('"dexa_scan"');
      view.unmount();
      expect((await reloaded())?.screenings.find(s => s.screeningKey === 'dexa_screening')?.value).toBe('dexa_scan');
    });

    it('a supplement dose change', async () => {
      const view = await page('.supplement-dose');
      fireEvent.change(view.container.querySelector('.supplement-dose')!, { target: { value: '50' } });
      act(() => leave[event]());
      expect(onDevice().supplements.find(s => s.supplementKey === 'custom_test_supplement')?.doseValue).toBe(50);
      view.unmount();
      expect((await reloaded())?.supplements?.find(s => s.supplementKey === 'custom_test_supplement')?.doseValue).toBe(50);
    });
  });

  // One handler for every event: the vitals field the user left is saved too,
  // on hide as well as on unload. Unmounting drops a save still waiting, so
  // only one the handler ran reaches the record.
  it.each(Object.keys(leave))('%s: a first-time weight the user left is saved, not left waiting', async event => {
    await initRoadmapStore(new LocalStorageAdapter());
    await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('#weightKg')).not.toBeNull());
    const weight = view.container.querySelector<HTMLInputElement>('#weightKg')!;
    fireEvent.change(weight, { target: { value: '82' } });
    act(() => { fireEvent.blur(view.container.querySelector('#weightKg')!); });
    act(() => leave[event]());
    view.unmount();
    await act(async () => { await flushRoadmapStore(); });
    await waitFor(async () => expect((await loadAllHistory()).filter(m => m.metricType === 'weight').map(m => m.value)).toEqual([82]));
  });

  it('a hidden page that comes back runs each flushed save once: a stop made after it stays', async () => {
    const view = await page('.supplement-dose');
    fireEvent.change(view.container.querySelector('.supplement-dose')!, { target: { value: '50' } });
    act(() => leave['visibilitychange: hidden']());
    Reflect.deleteProperty(document, 'visibilityState'); // the user is back
    fireEvent.click(view.container.querySelector('.supplement-remove')!);
    await act(async () => { await new Promise(r => setTimeout(r, 400)); await flushRoadmapStore(); });
    expect(onDevice().supplements.find(s => s.supplementKey === 'custom_test_supplement')?.status).toBe('stopped');
  });

  it('a supplement stopped while its dose save waits stays stopped when the page goes', async () => {
    const view = await page('.supplement-dose');
    fireEvent.change(view.container.querySelector('.supplement-dose')!, { target: { value: '50' } });
    fireEvent.click(view.container.querySelector('.supplement-remove')!); // within the 300 ms
    await act(async () => { await flushRoadmapStore(); });
    act(() => leave.pagehide());
    await act(async () => { await flushRoadmapStore(); });
    expect(onDevice().supplements.find(s => s.supplementKey === 'custom_test_supplement')?.status).toBe('stopped');
  });

  it('an unmounted page stops listening: a later hide writes nothing from it', async () => {
    const view = await page('#glp1-dose');
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
    view.unmount();
    const before = localStorage.getItem('health_roadmap_file_v2');
    act(() => leave['visibilitychange: hidden']());
    expect(localStorage.getItem('health_roadmap_file_v2')).toBe(before);
  });

  it('a page that stays visible keeps the 300 ms wait', async () => {
    const view = await page('#glp1-dose');
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); }); // still visible
    expect(onDevice().medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1);
    await act(async () => { await new Promise(r => setTimeout(r, 400)); await flushRoadmapStore(); });
    expect(onDevice().medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1.7);
  });
});

/** A cloud whose save never answers: the page goes before the request ends. */
class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}

/** Dropbox's and Drive's own adapter classes, so the page builds the host it
 *  builds for them; their requests go to `cloud`, and every save hangs, as a
 *  request the closing page kills (Brad's agent, 2026-11-02). */
const PROVIDERS = {
  Dropbox: () => new DropboxAdapter({ clientId: 'synthetic', redirectUri: 'https://example.test/' }),
  'Google Drive': () => new GoogleDriveAdapter({
    clientId: 'synthetic', scope: 'synthetic', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/token',
  }),
};
function stalledProvider(provider: keyof typeof PROVIDERS, cloud: MemoryCloud) {
  const adapter = PROVIDERS[provider]();
  const transport = new StalledCloud(cloud);
  const calls = transport as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  for (const method of ['connect', 'isConnected', 'disconnect', 'read', 'write', 'readDocument', 'writeDocument', 'list', 'remove', 'watch']) {
    Object.assign(adapter, { [method]: calls[method]?.bind(transport) });
  }
  return adapter;
}

describe('US-06 AC13: a cloud page keeps a change its stalled save had not landed', () => {
  afterEach(async () => {
    Reflect.deleteProperty(document, 'visibilityState');
    // The harness flushes the store after each test: give it one that answers.
    await initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
  });

  /** The same GLP-1 user, saved in a cloud; the page then runs on a cloud whose saves hang. */
  async function cloudPage(cloud: MemoryCloud, stalled: () => Parameters<typeof initRoadmapStore>[0] = () => new StalledCloud(cloud)) {
    await initRoadmapStore(new MemoryAdapter(cloud));
    await saveChangedMeasurements({ sex: 'female', heightCm: 178, birthYear: 1960, birthMonth: 1 }, {});
    await addMeasurement('weight', 101.4, '2026-09-01');
    await saveMedication('glp1', 'semaglutide_injection', 1, 'mg');
    await flushRoadmapStore();
    const page = stalled();
    localStorage.setItem(BACKEND_KEY, page.id); // the page's cloud, as connect.ts remembers it
    await initRoadmapStore(page);
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('#glp1-dose')).not.toBeNull());
    return view;
  }
  const cloudDose = (cloud: MemoryCloud) =>
    (JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile).medications.find(m => m.medicationKey === 'glp1')?.doseValue;

  it.each(Object.keys(leave))('%s: the device copy holds it at once, marked for sync, and the next load sends it up', async event => {
    const cloud = new MemoryCloud();
    const view = await cloudPage(cloud);
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
    act(() => leave[event]());
    expect(onDevice().medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1.7);
    expect(isSyncPending()).toBe(true);
    expect(cloudDose(cloud)).toBe(1);
    view.unmount();
    // The next page load reaches the cloud, and the marked device copy goes up.
    await initRoadmapStore(new MemoryAdapter(cloud));
    await flushRoadmapStore();
    expect(cloudDose(cloud)).toBe(1.7);
    expect(isSyncPending()).toBe(false);
  });

  it.each(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)('%s: pagehide puts the change on the device at once, marked, and the next load sends it up', async provider => {
    const cloud = new MemoryCloud();
    const view = await cloudPage(cloud, () => stalledProvider(provider, cloud));
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
    act(() => leave.pagehide());
    view.unmount(); // the page is gone: no timer or later turn can rescue the save
    expect(onDevice().medications.find(m => m.medicationKey === 'glp1')?.doseValue).toBe(1.7);
    expect(isSyncPending()).toBe(true);
    expect(cloudDose(cloud)).toBe(1);
    await initRoadmapStore(new MemoryAdapter(cloud));
    await flushRoadmapStore();
    expect(cloudDose(cloud)).toBe(1.7);
    expect(isSyncPending()).toBe(false);
  });

  it('after another tab logs off, leaving writes nothing to the device (US-09 AC2c)', async () => {
    const cloud = new MemoryCloud();
    const view = await cloudPage(cloud);
    window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_signal', newValue: '1' }));
    localStorage.clear(); // the other tab's device wipe
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
    act(() => leave['visibilitychange: hidden']());
    expect(localStorage.getItem('health_roadmap_file_v2')).toBeNull();
    expect(isSyncPending()).toBe(false);
  });
});
