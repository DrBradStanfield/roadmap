// @vitest-environment jsdom
/**
 * US-05 AC6: the per-field unit toggles this device keeps in localStorage
 * (`health_roadmap_unit_overrides`) are read as a plain object of units.
 * Anything else is read as no toggles, and never written back.
 *
 * Found 2026-11-05 (break-it round): the value `null` threw on every load,
 * so the page showed only "Something went wrong" and a refresh never helped.
 * A string or an array was spread into the next toggle's write as
 * {"0":"m","1":"e",...}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { showTables } from '../testing/health-tool-harness';

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

const KEY = 'health_roadmap_unit_overrides';
const stops: Array<() => void> = [];

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64, waistCm: 80 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** The unit chip on a vitals row, by the row's label. */
async function chipOf(view: RenderResult, label: string): Promise<HTMLElement> {
  return waitFor(() => {
    showTables(view.container);
    const name = [...view.container.querySelectorAll('.bt-cell-name')]
      .find(n => n.querySelector('.bt-name-label')?.textContent === label);
    const chip = name?.querySelector<HTMLElement>('button.bt-unit-chip');
    expect(chip).toBeTruthy();
    return chip!;
  });
}

describe('US-05 AC6: a stored unit toggle that is not a plain object of units is ignored', () => {
  // An array of valid units passes the value filter, so only the array check stops its {"0":...} write.
  it.each([['null'], ['"metric"'], ['[1,2]'], ['["conventional","si"]'], ['7']])('%s: the page loads in the page units, and a toggle writes only that toggle', async (stored) => {
    localStorage.setItem(KEY, stored);
    const view = render(<HealthTool />);
    const weight = await chipOf(view, 'Weight');
    expect(weight.textContent).toBe('kg');
    fireEvent.click(weight);
    await waitFor(() => expect(weight.textContent).toBe('lbs'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ weightKg: 'conventional' });
  });

  it('an entry whose unit is not si or conventional is dropped; the valid entries still apply and are kept', async () => {
    localStorage.setItem(KEY, JSON.stringify({ weightKg: 'conventional', waistCm: 'metric', ldl: 7, lpa: 'si' }));
    const view = render(<HealthTool />);
    expect((await chipOf(view, 'Weight')).textContent).toBe('lbs');
    const waist = await chipOf(view, 'Waist Circumference');
    expect(waist.textContent).toBe('cm');
    fireEvent.click(waist);
    await waitFor(() => expect(waist.textContent).toBe('in'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ weightKg: 'conventional', waistCm: 'conventional', lpa: 'si' });
  });
});
