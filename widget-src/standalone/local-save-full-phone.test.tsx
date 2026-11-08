// @vitest-environment jsdom
/**
 * US-01 AC5 on a phone (768px or narrower): a measurement is added through the
 * store's addMeasurement while the Input tab is open (the default) and the
 * plan's tab is hidden. No form field is typed into. The alert must be on the
 * open tab: atop My health (US-62 AC34), not in the hidden Account tab beside the storage button.
 * The whole widget is mounted as standalone/app.tsx mounts it (the top bar's
 * StorageBar and the plan's SyncControl), on the real store and device
 * adapter. The storage is a uniform byte budget, as in
 * local-save-full.test.tsx; no real browser quota is claimed. Layout is
 * checked by DOM position and the `hidden` attribute only; jsdom applies no
 * CSS. Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', async original => ({
  ...(await original<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../src/lib/chat-api', async original => ({
  ...(await original<typeof import('../src/lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

import { HealthTool } from '../src/components/HealthTool';
import { LocalSaveAlert, StorageBar, SyncControl } from './sync-control';
import { RoadmapStore } from '../src/storage/roadmap-store';
import { LocalStorageAdapter } from '../src/storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../src/lib/roadmap-data';

const FULL_LINE = 'Could not save on this device (local storage may be full).';

class ByteBudgetStorage implements Storage {
  private entries = new Map<string, string>();
  limit = Number.POSITIVE_INFINITY;
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(k: string) { return this.entries.get(String(k)) ?? null; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  removeItem(k: string) { this.entries.delete(String(k)); }
  get used() { return [...this.entries].reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0); }
  setItem(k: string, v: string) {
    k = String(k); v = String(v);
    const old = this.entries.get(k);
    const after = this.used - (old === undefined ? 0 : 2 * (k.length + old.length)) + 2 * (k.length + v.length);
    if (after > this.limit) throw new DOMException('Synthetic uniform byte budget exceeded', 'QuotaExceededError');
    this.entries.set(k, v);
  }
}

const PROFILE = { sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64 } as const;
const stops: Array<() => void> = [];
let storage: ByteBudgetStorage;

beforeEach(async () => {
  storage = new ByteBudgetStorage();
  vi.stubGlobal('localStorage', storage);
  sessionStorage.clear();
  // A phone: every max-width query matches, every min-width one does not.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements(PROFILE, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  storage.limit = Number.POSITIVE_INFINITY;
  await flushRoadmapStore(); // a save that lands clears the refusal for the next file
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('US-01 AC5 on a phone: the alert is on the My health title line while the guest is on that tab', () => {
  it('shows and is in the accessibility tree once, outside every hidden tab', async () => {
    const view = render(
      <HealthTool
        storageBar={<StorageBar backend="local" />}
        saveAlert={<LocalSaveAlert backend="local" />}
        syncControl={({ hasData, attention }) => <SyncControl backend="local" hasData={hasData} attention={attention} />}
      />,
    );
    const inputTab = await waitFor(() => {
      const el = view.container.querySelector('.hr-tabpanel:not([hidden]) .health-input-panel');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(inputTab).not.toBeNull(); // the guest is on the Input tab, the plan's tab is hidden
    expect(view.container.querySelector('[role="alert"]')).toBeNull();

    storage.limit = storage.used; // full: nothing more fits
    await act(async () => {
      expect((await addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z')).status).toBe('inserted');
      // The debounced save may already have run and been refused; either way the flush settles.
      await flushRoadmapStore().catch(() => {});
    });
    const stored = JSON.parse(storage.getItem('health_roadmap_file_v2')!) as { measurements: Array<{ value: number }> };
    expect(stored.measurements.map((m) => m.value)).not.toContain(93); // the save was refused

    const alerts = [...view.container.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain(FULL_LINE);
    // Atop My health, though the storage button sits in the Account tab (US-62 AC34).
    expect(alerts[0].closest('.mh-header')).not.toBeNull();
    expect(alerts[0].closest('[hidden]')).toBeNull();
  });
});
