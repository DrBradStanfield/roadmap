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
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { localDay, rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import { formatDisplayValue, toCanonicalValue } from '@roadmap/health-core/units';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { loadFromLocalStorage } from '../lib/storage';
import { trackABConversion } from '../lib/server-api';
import { openAboutYou } from '../testing/health-tool-harness';
import { WRITE_REFUSED } from '../lib/erase-copy';
import { press, typeInto } from '../testing/matrix-gestures';

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
import { deleteButton } from '../testing/settings';

const TODAY = localDay(new Date());
const calls = (name: string) => tracked.calls.filter(([n]) => n === name).map(([, m]) => m);
const conversions = () => vi.mocked(trackABConversion).mock.calls.length;
const stops: Array<() => void> = [];
/** The window's width as the page's media queries read it: a desktop, until a test turns it into a phone. */
const viewport = { mobile: false, listeners: new Set<(e: { matches: boolean }) => void>() };
/** The window resized or turned across 768 px: the page moves its form between the phone's tab and the desktop's column. */
const turn = (mobile: boolean) => act(() => { viewport.mobile = mobile; for (const l of [...viewport.listeners]) l({ matches: mobile }); });

beforeEach(async () => {
  tracked.calls = [];
  refuse.next = false;
  vi.mocked(trackABConversion).mockClear();
  localStorage.clear(); sessionStorage.clear();
  viewport.mobile = false;
  viewport.listeners.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q.includes('max-width') ? viewport.mobile : true; }, media: q,
    addEventListener(_: string, l: (e: { matches: boolean }) => void) { if (q.includes('max-width')) viewport.listeners.add(l); },
    removeEventListener(_: string, l: (e: { matches: boolean }) => void) { viewport.listeners.delete(l); },
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

describe('US-01 AC7: the measurement-save conversion counts a new visitor\'s first measurement save', () => {
  it('US-01 AC7: a new visitor\'s profile save sends none; the first saved weight sends trackABConversion once; a second save sends none', async () => {
    const view = await open();
    type(q(view, '#heightCm'), '178');
    leave(q(view, '#heightCm'));
    await settle(700); // the height's profile save has run
    expect(conversions()).toBe(0);
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

  it('US-01 AC7: an erase in the tab does not start it again: the new record\'s first weight sends none', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    const view = await open();
    type(q(view, '#heightCm'), '178');
    leave(q(view, '#heightCm'));
    await saveWeight(view, '80');
    expect(conversions()).toBe(1);
    fireEvent.click(deleteButton());
    await waitFor(async () => expect(await activeWeights()).toEqual([]), { timeout: 3000 });
    await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
    type(q(view, '#heightCm'), '178');
    leave(q(view, '#heightCm'));
    await saveWeight(view, '81');
    expect(conversions()).toBe(1);
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
    await waitFor(() => expect(calls('remote_change_applied')).toHaveLength(1), { timeout: 3000 });
    await settle(300);
    expect(calls('remote_change_applied')).toHaveLength(1);
  });
});

describe('US-34 AC7: a unit system another device chose shows here at once', () => {
  // Brad 2026-11-10 (survey R1): the record's unit system is one fact. The
  // page applied it at load but not on a remote change, so the form held the
  // new system while every value still showed in the old one.
  it('US-34 AC7: the phone switches the record to US units; this page shows the weight in lb without a reload', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3, unitSystem: 'si' }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    const weightRow = () => q(view, '.bt-vitals-card [data-metric="weight"]')?.textContent ?? '';
    await waitFor(() => expect(weightRow()).toContain(formatDisplayValue('weight', 70, 'si')));
    await anotherWriter(() => saveChangedMeasurements({ unitSystem: 'conventional' }, { unitSystem: 'si' }));
    await waitFor(() => expect(weightRow()).toContain(formatDisplayValue('weight', 70, 'conventional')), { timeout: 3000 });
  });
});

describe('US-04 AC1, US-34 AC7: a unit switch from another device never changes the meaning of a number being typed', () => {
  // Brad 2026-11-10: the record's unit system is held while anything is being
  // typed (the focus in a field, or a matrix draft holding text) and applies
  // once the page is clean. PR 1135's reviewers found both scenarios below.
  const weightRow = (view: RenderResult) => q(view, '.bt-vitals-card [data-metric="weight"]')?.textContent ?? '';
  const lb180 = () => toCanonicalValue('weight', 180, 'conventional');
  /** Scenario A: a first-time weight typed in lb; the phone switches the record to SI mid-number. */
  async function weightTypedAcrossASwitch(): Promise<RenderResult> {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3, unitSystem: 'conventional' }, {});
    await flushRoadmapStore();
    const view = render(<HealthTool />); // the onboarding's weight box, beside the height (US-62 AC13)
    await waitFor(() => expect(q(view, '#weightKg')).toBeTruthy());
    type(q(view, '#weightKg'), '18');
    await anotherWriter(() => saveChangedMeasurements({ unitSystem: 'si' }, { unitSystem: 'conventional' }));
    await settle(50);
    type(q(view, '#weightKg'), '180');
    leave(q(view, '#weightKg'));
    await waitFor(async () => expect(await activeWeights()).toHaveLength(1), { timeout: 3000 });
    return view;
  }

  it('US-04 AC1, US-34 AC7: a weight typed in lb across a remote switch to SI saves as lb (scenario A)', async () => {
    await weightTypedAcrossASwitch();
    const [[saved]] = await activeWeights();
    expect(saved).toBeCloseTo(lb180(), 1);
  });

  it('US-34 AC7: the held unit system applies once the field is left: the weight then shows in kg', async () => {
    const view = await weightTypedAcrossASwitch();
    await waitFor(() => expect(weightRow(view)).toContain(formatDisplayValue('weight', lb180(), 'si')), { timeout: 3000 });
  });

  /** The blood-test matrix's LDL row, once it is on the page. */
  const ldlRow = (view: RenderResult) => waitFor(() => {
    const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-timeline .bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'LDL Cholesterol');
    if (!row) throw new Error('no LDL row');
    return row;
  });
  const ldlDraft = async (view: RenderResult) => (await ldlRow(view)).querySelector('.bt-cell-draft input') as HTMLInputElement;
  const activeLdl = async () => toOldShape(await recordOnDisk()).measurements
    .filter((m) => m.metricType === 'ldl' && m.status === 'active').map((m) => m.value);
  /** A complete record in SI units. */
  async function siRecord() {
    await completeRecord();
    await saveChangedMeasurements({ unitSystem: 'si' }, {});
    await flushRoadmapStore();
  }
  const toConventional = () => anotherWriter(() => saveChangedMeasurements({ unitSystem: 'conventional' }, { unitSystem: 'si' }));

  it('US-04 AC1, US-34 AC7: an LDL drafted in mmol/L across a remote switch to US units saves as mmol/L (scenario B)', async () => {
    await siRecord();
    const view = await open();
    typeInto(await ldlDraft(view), '3.5'); // the cell keeps the focus
    await toConventional();
    await settle(50);
    press(q(view, '.alr-add-btn') as HTMLElement); // out of the matrix: the draft commits
    await waitFor(async () => expect(await activeLdl()).toEqual([3.5]), { timeout: 3000 });
    // Clean again: the record's US units show.
    await waitFor(async () => expect((await ldlRow(view)).textContent).toContain('mg/dL'), { timeout: 3000 });
  });

  it('US-04 AC1, US-34 AC7: a draft holding text with the focus elsewhere holds the units too, until it commits', async () => {
    await siRecord();
    const first = await open();
    typeInto(await ldlDraft(first), '3.5');
    first.unmount(); // the draft stays on the device, unsaved
    const view = await open();
    expect((await ldlDraft(view)).value).toBe('3.5');
    expect(document.activeElement?.matches('input, select, textarea')).toBe(false); // no field has the focus
    await toConventional();
    await settle(50);
    expect((await ldlRow(view)).textContent).toContain('mmol/L'); // held
    typeInto(await ldlDraft(view), '3.5');
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toEqual([3.5]), { timeout: 3000 });
    await waitFor(async () => expect((await ldlRow(view)).textContent).toContain('mg/dL'), { timeout: 3000 });
  });

  it('US-04 AC1, US-34 AC7: a draft held across a turn of the phone keeps the units held: the LDL saves as mmol/L (PR 1135 B1)', async () => {
    await siRecord();
    const view = await open();
    typeInto(await ldlDraft(view), '3.5');
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); }); // the focus off, the draft holding text
    await toConventional();
    await settle(50);
    expect((await ldlRow(view)).textContent).toContain('mmol/L'); // held
    turn(true); // the form moves into the phone's tab: InputPanel mounts again
    await settle(50);
    turn(false);
    await settle(50);
    typeInto(await ldlDraft(view), '3.5');
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
    expect(await activeLdl()).toEqual([3.5]);
  });

  it('US-11 AC6: a remote erase while a field is focused still applies at once: the form empties, and the erased record\'s units show', async () => {
    await siRecord();
    const view = await open();
    type(q(view, '#heightCm'), '171'); // focused, unsaved
    // Another device erases the record, as its deleteUserData writes it.
    const adapter = new LocalStorageAdapter();
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const now = new Date(Date.now() + 1000).toISOString();
    const prior = migrateFile(body, { deviceId: 'other-device', now });
    const erased = migrateFile(null, { deviceId: 'other-device', now });
    const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
    erased.schemaVersion = CURRENT_SCHEMA_VERSION;
    erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
    erased.meta.eraseEpoch = epoch;
    erased.meta.erasedAt = now;
    // The erasing device then chose US units in its new record: they show at once, never held.
    erased.profile = { ...erased.profile, unitSystem: 'conventional', updatedAt: now };
    await adapter.write(ROADMAP_FILE_NAME, erased, version);
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    // The saved answers and the weight go. (The focused height box keeps its own typed
    // text, InputPanel's rawInputs, as before this change.)
    await waitFor(() => expect((q(view, '#birthYear') as HTMLInputElement | null)?.value ?? '').toBe(''), { timeout: 3000 });
    expect(view.queryByRole('radio', { name: 'Female', checked: true })).toBeNull();
    expect(await activeWeights()).toEqual([]);
    expect(q(view, '#heightFeet')).toBeTruthy(); // the height in ft/in, though the cm box had the focus
  });
});
