// @vitest-environment jsdom
/**
 * US-06 AC13 with US-09 AC2c: after another tab logs off, a list change made
 * as the tab goes away writes nothing to the device.
 *
 * Its own file (T7): the heard log-off stops health writes for the page's
 * life (lib/storage.ts), so it would stop every case that ran after it in
 * HealthTool.list-departure.test.tsx. A file is a fresh page.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { WriteResult } from '@roadmap/health-core/adapter';
import {
  addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveMedication,
} from '../lib/roadmap-data';
import { isSyncPending } from '../storage';
import { BACKEND_KEY } from '../storage/web-record-host';
import { useHealthToolLifecycle } from '../testing/health-tool-harness';

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

/** A cloud whose save never answers: the page goes before the request ends. */
class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}

afterEach(async () => {
  Reflect.deleteProperty(document, 'visibilityState');
  // The harness flushes the store after each test: give it one that answers.
  await initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
});

it('US-06 AC13: after another tab logs off, leaving writes nothing to the device (US-09 AC2c)', async () => {
  const cloud = new MemoryCloud();
  // The GLP-1 user, saved in a cloud; the page then runs on a cloud whose saves hang.
  await initRoadmapStore(new MemoryAdapter(cloud));
  await saveChangedMeasurements({ sex: 'female', heightCm: 178, birthYear: 1960, birthMonth: 1 }, {});
  await addMeasurement('weight', 101.4, '2026-09-01');
  await saveMedication('glp1', 'semaglutide_injection', 1, 'mg');
  await flushRoadmapStore();
  const page = new StalledCloud(cloud);
  localStorage.setItem(BACKEND_KEY, page.id); // the page's cloud, as connect.ts remembers it
  await initRoadmapStore(page);
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#glp1-dose')).not.toBeNull());

  window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_signal', newValue: '1' }));
  localStorage.clear(); // the other tab's device wipe
  fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } });
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(localStorage.getItem('health_roadmap_file_v2')).toBeNull();
  expect(isSyncPending()).toBe(false);
});
