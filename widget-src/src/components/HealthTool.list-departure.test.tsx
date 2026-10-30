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
import type { RoadmapFile } from '@roadmap/health-core';
import { flushRoadmapStore, initRoadmapStore, loadLatestMeasurements, saveScreening, saveSupplement } from '../lib/roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
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

  it('a hidden page that comes back runs each flushed save once: a stop made after it stays', async () => {
    const view = await page('.supplement-dose');
    fireEvent.change(view.container.querySelector('.supplement-dose')!, { target: { value: '50' } });
    act(() => leave['visibilitychange: hidden']());
    Reflect.deleteProperty(document, 'visibilityState'); // the user is back
    fireEvent.click(view.container.querySelector('.supplement-remove')!);
    await act(async () => { await new Promise(r => setTimeout(r, 400)); await flushRoadmapStore(); });
    expect(onDevice().supplements.find(s => s.supplementKey === 'custom_test_supplement')?.status).toBe('stopped');
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
