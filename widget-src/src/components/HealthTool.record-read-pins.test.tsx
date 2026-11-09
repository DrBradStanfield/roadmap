// @vitest-environment jsdom
/**
 * Pins of today's record-read path in HealthTool, written before it moves into
 * a hook: the A/B conversion on a first save, the chat mirror kept in step by a
 * lab row added by hand and by another writer's change, and a change held
 * behind an unsaved profile edit when a write is refused (US-07 AC7, US-15
 * AC10, US-34 AC4). Each test reads what the person sees, the chat mirror or
 * what analytics is sent, never HealthTool's state.
 *
 * As HealthTool.onboarding-pins.test.tsx: the whole widget over a real
 * RoadmapStore on localStorage, `trackProductEvent`'s calls recorded, the
 * profile save made to refuse once when asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { localDay } from '@roadmap/health-core/merge';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { loadFromLocalStorage } from '../lib/storage';
import { trackABConversion } from '../lib/server-api';
import { openAboutYou } from '../testing/health-tool-harness';
import { WRITE_REFUSED } from '../lib/erase-copy';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// Every trackProductEvent call, recorded; the A/B calls are stubs this file reads.
const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown> | undefined]> }));
vi.mock('../lib/server-api', async original => {
  const real = await original<typeof import('../lib/server-api')>();
  return {
    ...real,
    trackABImpression: vi.fn(), trackABConversion: vi.fn(),
    trackProductEvent: (...args: Parameters<typeof real.trackProductEvent>) => {
      tracked.calls.push([args[0], args[1] as Record<string, unknown> | undefined]);
    },
  };
});
// The profile save refuses once when asked, as the store refuses a write (US-16 AC2a).
const refuse = vi.hoisted(() => ({ next: false }));
vi.mock('../lib/roadmap-data', async original => {
  const real = await original<typeof import('../lib/roadmap-data')>();
  return {
    ...real,
    saveChangedMeasurements: (...args: Parameters<typeof real.saveChangedMeasurements>) => {
      if (refuse.next) { refuse.next = false; return Promise.resolve({ ok: false }); }
      return real.saveChangedMeasurements(...args);
    },
  };
});
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));
import { HealthTool } from './HealthTool';

const TODAY = localDay(new Date());
const calls = (name: string) => tracked.calls.filter(([n]) => n === name).map(([, m]) => m);
const conversions = () => vi.mocked(trackABConversion).mock.calls.length;
const stops: Array<() => void> = [];

beforeEach(async () => {
  tracked.calls = [];
  refuse.next = false;
  vi.mocked(trackABConversion).mockClear();
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
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

async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}
const activeWeights = async () => (await recordOnDisk()).measurements
  .filter((m) => m.metricType === 'weight' && m.status === 'active').map((m) => [m.value, m.recordedAt.slice(0, 10)]);

/** The tool, once the record has loaded, with About you's rows opened (US-62 AC12). */
async function open(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#heightCm') ?? (openAboutYou(view.container), view.container.querySelector('.about-row'))).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  openAboutYou(view.container);
  return view;
}
const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
}
const leave = (input: Element | null) => act(() => { (input as HTMLElement).blur(); });
const settle = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** A weight typed in its field and left: its save runs 500 ms later. */
async function saveWeight(view: RenderResult, weight: string) {
  type(q(view, '#weightKg'), weight);
  leave(q(view, '#weightKg'));
  await waitFor(async () => expect(await activeWeights()).toContainEqual([Number(weight), TODAY]), { timeout: 2000 });
  await settle(50);
}
/** Another writer changes the record, and the page is told (US-34). */
async function anotherWriter(write: () => Promise<unknown>) {
  await write();
  await flushRoadmapStore();
  await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
}
/** A complete record: About you answered, one weight. */
async function completeRecord() {
  await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
  await addMeasurement('weight', 70, '2026-09-01');
  await flushRoadmapStore();
}
const mirror = () => loadFromLocalStorage();

describe('US-01 AC7: the A/B conversion counts a new visitor\'s first saved value', () => {
  it('US-01 AC7: a new visitor\'s first saved weight sends trackABConversion once; a second save sends none', async () => {
    const view = await open();
    type(q(view, '#heightCm'), '178');
    leave(q(view, '#heightCm'));
    await saveWeight(view, '80');
    expect(conversions()).toBe(1);
    await saveWeight(view, '81');
    expect(conversions()).toBe(1);
  });

  it('US-01 AC7: a returning user whose record holds a measurement at mount sends no conversion on a save', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await saveWeight(view, '72');
    expect(conversions()).toBe(0);
  });
});

describe('US-07 AC7: a lab eGFR added by hand reaches the chat mirror', () => {
  it('US-07 AC7: a lab eGFR saved through "Add a blood test" puts labEgfr in the chat mirror', async () => {
    await completeRecord();
    const view = await open();
    await waitFor(() => expect(mirror()?.inputs.heightCm).toBe(170));
    expect(mirror()?.labEgfr).toBeNull();
    fireEvent.click(await waitFor(() => view.getByRole('button', { name: '+ Add a blood test' })));
    fireEvent.change(view.getByRole('combobox', { name: 'Test' }), { target: { value: 'egfr' } });
    fireEvent.change(view.getByRole('textbox', { name: 'Value' }), { target: { value: '40' } });
    fireEvent.click(view.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mirror()?.labEgfr).toMatchObject({ labEgfr: 40, labEgfrDate: TODAY }));
  });
});

describe('US-15 AC10, US-34: another writer\'s change reaches the chat mirror', () => {
  it('US-15 AC10: a weight another writer adds, applied by the page, is the mirror\'s latest weight', async () => {
    await completeRecord();
    await open();
    await waitFor(() => expect(mirror()?.previousMeasurements.find((m) => m.metricType === 'weight')?.value).toBe(70));
    await anotherWriter(() => addMeasurement('weight', 82, TODAY));
    await waitFor(() => expect(calls('remote_change_applied')).toHaveLength(1));
    await waitFor(() => expect(mirror()?.previousMeasurements.find((m) => m.metricType === 'weight')?.value).toBe(82));
  });
});

describe('US-34 AC4: a change held behind an unsaved profile edit, then a refused write', () => {
  // Current behaviour (2026-11-10), pinned exactly. The refused save's re-read
  // (writeRefused) goes around the relay and counts nothing; the form, clean
  // after it, releases the held change, which re-reads again and counts once.
  // A later change may fold the two re-reads into one; the count stays 1.
  it('US-34 AC4: the held change shows after the refused height save re-reads the record; remote_change_applied is sent once today (current behaviour)', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    await completeRecord();
    const view = await open();
    // An unsaved profile edit: the height typed, still focused, its save on the timer.
    type(q(view, '#heightCm'), '171');
    await anotherWriter(() => saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1981, birthMonth: 3 }, { heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }));
    expect((q(view, '#birthYear') as HTMLInputElement).value).toBe('1980'); // held
    expect(calls('remote_change_applied')).toEqual([]);
    refuse.next = true;
    leave(q(view, '#heightCm'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(WRITE_REFUSED), { timeout: 3000 });
    await waitFor(() => expect((q(view, '#birthYear') as HTMLInputElement).value).toBe('1981'));
    await settle(1200);
    expect(calls('remote_change_applied')).toHaveLength(1);
  });
});
