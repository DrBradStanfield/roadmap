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
import { createRoot } from 'react-dom/client';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { localDay, rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import { formatDisplayValue, toCanonicalValue } from '@roadmap/health-core/units';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY, VITALS_DRAFT_KEY, loadFromLocalStorage } from '../lib/storage';
import { trackABConversion } from '../lib/server-api';
import { openAboutYou } from '../testing/health-tool-harness';
import { WRITE_REFUSED } from '../lib/erase-copy';
import { press, pressMouse, releaseMouse, typeInto } from '../testing/matrix-gestures';
import { cellText } from '../lib/blood-test-cell';
import { Sentry } from '../lib/sentry';
const { scrubEvent: realScrubEvent } = await vi.importActual<typeof import('../lib/sentry')>('../lib/sentry');

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
// How many times the page re-reads the record (survey R8: a held change applied twice).
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../lib/roadmap-data', async original => {
  const real = await original<typeof import('../lib/roadmap-data')>();
  return {
    ...real,
    loadLatestMeasurements: () => { reads.count++; return real.loadLatestMeasurements(); },
    // The lab read fails on every call when asked: a lasting failure of the first read's mirror (PR 1155 review R1).
    loadLabValues: () => failMirror.always ? Promise.reject(new Error('Synthetic test: lab read failed')) : real.loadLabValues(),
    saveChangedMeasurements: (...args: Parameters<typeof real.saveChangedMeasurements>) => {
      if (refuse.next) { refuse.next = false; return Promise.resolve({ ok: false }); }
      return real.saveChangedMeasurements(...args);
    },
  };
});
// The first read's mirror throws once when asked, as a malformed record would (PR 1155 review F1).
const failMirror = vi.hoisted(() => ({ next: false, threw: false, always: false }));
vi.mock('../hooks/useRecordReads', async original => {
  const real = await original<typeof import('../hooks/useRecordReads')>();
  return {
    ...real,
    mirrorRecord: (...args: Parameters<typeof real.mirrorRecord>) => {
      if (failMirror.next) { Object.assign(failMirror, { next: false, threw: true }); return Promise.reject(new Error('Synthetic test: mirror failed')); }
      return real.mirrorRecord(...args);
    },
  };
});
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
// Run once as a microtask queued in the first commit. Outside act, React runs the commit's
// passive effects as their own scheduler task once the commit's task yields; a first render
// longer than the scheduler's 5 ms slice (a real page's is) makes it yield, so the microtask
// lands between the page's mount read and its effects, as a store re-read resolving there
// would (survey R2). `inGap` records that it did, so a test cannot pass without the gap.
const atMount = vi.hoisted(() => ({ run: null as null | (() => void), effectsRan: false, inGap: false }));
// The modal's hand-back to the page, captured so a test can finish an upload (US-62 AC13).
const upload = vi.hoisted(() => ({ complete: null as null | (() => void | Promise<void>) }));
vi.mock('./UploadModal', async () => {
  const { useEffect, useLayoutEffect } = await import('react');
  return {
    UploadModal: ({ onComplete }: { onComplete: () => void | Promise<void> }) => {
      upload.complete = onComplete;
      if (atMount.run) for (const end = performance.now() + 20; performance.now() < end;) { /* a long first render */ }
      useLayoutEffect(() => {
        const run = atMount.run;
        atMount.run = null;
        if (!run) return;
        queueMicrotask(() => { atMount.inGap = !atMount.effectsRan; run(); });
      }, []);
      useEffect(() => { atMount.effectsRan = true; }, []);
      return null;
    },
  };
});
import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

const TODAY = localDay(new Date());
const calls = (name: string) => tracked.calls.filter(([n]) => n === name).map(([, m]) => m);
const conversions = () => vi.mocked(trackABConversion).mock.calls.length;
const stops: Array<() => void> = [];
const unmounts: Array<() => void> = [];
/** The window's width as the page's media queries read it: a desktop, until a test turns it into a phone. */
const viewport = { mobile: false, listeners: new Set<(e: { matches: boolean }) => void>() };
/** The window resized or turned across 768 px: the page moves its form between the phone's tab and the desktop's column. */
const turn = (mobile: boolean) => act(() => { viewport.mobile = mobile; for (const l of [...viewport.listeners]) l({ matches: mobile }); });

beforeEach(async () => {
  tracked.calls = [];
  refuse.next = false;
  Object.assign(failMirror, { next: false, threw: false, always: false });
  Object.assign(atMount, { run: null, effectsRan: false, inGap: false });
  upload.complete = null;
  vi.mocked(trackABConversion).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
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
  for (const unmount of unmounts.splice(0)) unmount();
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
  await waitFor(() => expect(view.container.querySelector('#heightCm, #heightFeet') ?? (openAboutYou(view.container), view.container.querySelector('.about-row'))).toBeTruthy());
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
/** What the strict scrubber sends for a capture tagged as useRecordApply tags it: the tags kept, the text replaced. */
function scrubbed(error: Error) {
  const [, hint] = vi.mocked(Sentry.captureException).mock.calls.find(([e]) => (e as Error).message === error.message)!;
  const { tags } = hint as { tags: Record<string, string> };
  const event = realScrubEvent({ type: undefined, tags, exception: { values: [{ type: 'Error', value: error.message }] } });
  return { tags: event?.tags, value: event?.exception?.values?.[0].value };
}
/** Another device erases the record, as its deleteUserData writes it, then starts its new record with `profile`; this tab is told. */
async function eraseFromAnotherDevice(profile: Partial<RoadmapFile['profile']> = {}) {
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
  if (Object.keys(profile).length) erased.profile = { ...erased.profile, ...profile, updatedAt: now };
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
}

// First in the file: after other tests here, React's first commit flushed its effects in the
// same task (no gap) in trials, and `inGap` would fail these.
describe('US-34 AC4: a change announced before the page has shown its first read', () => {
  // Survey R2 (2026-11-10, PR 1155 review R1): the page reads the record as it first renders
  // and shows that read in its first passive effects. A change announced between the commit
  // and those effects first found no listener; then, applied at once, it was overwritten by
  // the stale first read, and an empty first read wiped the chat mirror (US-15 AC10). It is
  // held until the first read is shown, then applied.
  /** The tool as a browser renders it: outside act, so the commit's passive effects run in a later task. */
  async function openUnacted(): Promise<HTMLElement> {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const was = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    root.render(<HealthTool />);
    unmounts.push(() => { root.unmount(); host.remove(); env.IS_REACT_ACT_ENVIRONMENT = was; });
    await waitFor(() => expect(atMount.effectsRan).toBe(true));
    expect(atMount.inGap).toBe(true); // the change was announced between the commit and the page's effects
    return host;
  }
  const announceWeight = () => {
    atMount.run = () => {
      void addMeasurement('weight', 82, TODAY); // the store takes it at once
      window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT));
    };
  };
  const mirrorWeight = () => mirror()?.previousMeasurements.find((m) => m.metricType === 'weight')?.value;
  async function endsOn82(host: HTMLElement) {
    await waitFor(() => expect(calls('remote_change_applied')).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(mirrorWeight()).toBe(82));
    await new Promise((r) => setTimeout(r, 800)); // past the first profile check
    expect(mirrorWeight()).toBe(82);
    expect(calls('remote_change_applied')).toHaveLength(1);
    // The page: a first-time weight field holds the saved weight as its value; the vitals matrix shows it as text.
    expect((host.querySelector('#weightKg') as HTMLInputElement | null)?.value ?? host.textContent).toContain('82');
  }

  it('US-34 AC4: a complete record: the weight announced in the gap ends on the page and in the mirror, counted once', async () => {
    await completeRecord();
    announceWeight();
    await endsOn82(await openUnacted());
  });

  it('US-34 AC4: a record with no profile, only a weight: the weight announced in the gap is not overwritten by the first read', async () => {
    await addMeasurement('weight', 80, '2026-09-01');
    await flushRoadmapStore();
    announceWeight();
    await endsOn82(await openUnacted());
  });

  it('US-34 AC4, US-15 AC10: an empty record an assistant writes into in the gap: the mirror is not wiped, and holds the weight', async () => {
    announceWeight();
    await endsOn82(await openUnacted());
  });
});

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
  // Survey R8 (2026-11-10): the refused save's re-read shows the held change. It is the
  // re-read the change waited for, so the record is read once and the change counted as
  // it shows. Before, the refused re-read went around the relay and counted nothing, and
  // the clean form then released the held change into a second re-read.
  it('US-34 AC4: the refused height save\'s re-read shows the held change and counts it as it shows; the record is re-read once', async () => {
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
    reads.count = 0;
    leave(q(view, '#heightCm'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(WRITE_REFUSED), { timeout: 3000 });
    await waitFor(() => expect((q(view, '#birthYear') as HTMLInputElement).value).toBe('1981'));
    expect(calls('remote_change_applied')).toHaveLength(1);
    await settle(800); // past the profile save the clean form runs
    expect(calls('remote_change_applied')).toHaveLength(1);
    expect(reads.count).toBe(1);
  });
});

describe('US-34 AC4, US-62 AC13: an upload finishes while a change is held', () => {
  // PR 1155 review R2: the upload's re-read takes the held change in, so the record is read
  // once and the change counted once; the upload still answers the step it completes.
  it('US-34 AC4, US-62 AC13: one re-read, remote_change_applied once, and onboarding_step for the measurements the upload saved', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(upload.complete).toBeTruthy());
    type(q(view, '#heightCm'), '171'); // an unsaved profile edit, still focused
    await anotherWriter(() => saveChangedMeasurements({ heightCm: 170, sex: 'female' }, { heightCm: 170 }));
    expect(calls('remote_change_applied')).toEqual([]); // held
    reads.count = 0;
    await act(async () => {
      await addMeasurement('weight', 80, TODAY); // the upload's save
      await upload.complete!();
    });
    await waitFor(() => expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]));
    expect(calls('remote_change_applied')).toHaveLength(1);
    await settle(800); // past the profile save the edit scheduled
    expect(calls('remote_change_applied')).toHaveLength(1);
    expect(reads.count).toBe(1);
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
  // Brad 2026-11-10: the record's unit system is held while a field has the
  // focus, and applies once it is left. A matrix draft cell carries the unit
  // it was typed in, so it keeps its quantity, shown in the new unit, with no
  // hold. PR 1135's reviewers found both scenarios below.
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

  it('US-04 AC1, US-34 AC7: a draft holding text with the focus elsewhere keeps its quantity: US units show at once, and it saves as mmol/L', async () => {
    await siRecord();
    const first = await open();
    typeInto(await ldlDraft(first), '3.5');
    first.unmount(); // the draft stays on the device, unsaved
    const view = await open();
    expect((await ldlDraft(view)).value).toBe('3.5');
    expect(document.activeElement?.matches('input, select, textarea')).toBe(false); // no field has the focus
    await toConventional();
    await settle(50);
    expect((await ldlDraft(view)).value).toBe(cellText('ldl', 3.5, 'conventional')); // US units at once, the quantity kept
    press(await ldlDraft(view)); // into the cell, nothing typed: a number typed now would be in mg/dL
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toEqual([3.5]), { timeout: 3000 });
    await waitFor(async () => expect((await ldlRow(view)).textContent).toContain('mg/dL'), { timeout: 3000 });
  });

  it('US-04 AC1, US-34 AC7: a draft across a remote switch and a turn of the phone keeps its quantity: the LDL saves as mmol/L (PR 1135 B1)', async () => {
    await siRecord();
    const view = await open();
    await settle(50); // About you's opened rows take the focus a frame later (AboutYou's open); a leave would commit the draft
    typeInto(await ldlDraft(view), '3.5');
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); }); // the focus off, the draft holding text
    await toConventional();
    await settle(50);
    expect((await ldlDraft(view)).value).toBe(cellText('ldl', 3.5, 'conventional')); // US units at once, the quantity kept
    turn(true); // the form moves into the phone's tab: InputPanel mounts again
    await settle(50);
    turn(false);
    await settle(50);
    press(await ldlDraft(view)); // into the cell, nothing typed
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
    expect(await activeLdl()).toEqual([3.5]);
  });

  it('US-04 AC1, US-34 AC7: a draft this tab holds keeps its quantity after another tab empties the kept copy (PR 1135 Codex R2)', async () => {
    await siRecord();
    const first = await open();
    typeInto(await ldlDraft(first), '3.5');
    first.unmount(); // the draft stays on the device, unsaved
    const view = await open(); // this tab restores it
    await settle(50); // About you's opened rows take the focus a frame later; a leave would commit the draft
    expect((await ldlDraft(view)).value).toBe('3.5');
    localStorage.removeItem(BT_TIMELINE_DRAFT_KEY); // another tab emptied its copy, which shares the key
    await toConventional();
    await settle(50);
    expect((await ldlDraft(view)).value).toBe(cellText('ldl', 3.5, 'conventional')); // US units at once, the quantity kept
    press(await ldlDraft(view)); // into the cell, nothing typed: a number typed now would be in mg/dL
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
    expect(await activeLdl()).toEqual([3.5]);
  });

  // Brad 2026-10-13: a unit chosen here says what the numbers typed are in
  // (useUnits counts the choice; the matrix re-reads its typed cells).
  it('US-05 AC2: 3.5 typed into LDL, then its own chip to mg/dL: it reads 3.5 mg/dL and saves so', async () => {
    await siRecord();
    const view = await open();
    await settle(50); // About you's opened rows take the focus a frame later; a leave would commit the draft
    typeInto(await ldlDraft(view), '3.5');
    const chip = (await ldlRow(view)).querySelector('.bt-unit-chip') as HTMLElement;
    pressMouse(chip); releaseMouse(chip);
    expect((await ldlDraft(view)).value).toBe('3.5');
    press(await ldlDraft(view));
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
    expect((await activeLdl())[0]).toBeCloseTo(toCanonicalValue('ldl', 3.5, 'conventional'), 6);
  });

  // Brad 2026-11-10 (PR 1147 re-check R1, option a): the page's Units pill
  // re-reads a hand-typed cell its press could not commit.
  it('US-05 AC2: "135" typed into LDL in mmol/L, refused, then the Units pill: it saves 135 mg/dL', async () => {
    await siRecord();
    const view = await open();
    await settle(50); // About you's opened rows take the focus a frame later; a leave would commit the draft
    typeInto(await ldlDraft(view), '135');
    const pill = await waitFor(() => {
      const el = q(view, '.unit-toggle-pill');
      if (!el) throw new Error('no unit pill');
      return el as HTMLElement;
    });
    pressMouse(pill); releaseMouse(pill);
    await waitFor(async () => expect((await ldlDraft(view)).getAttribute('aria-invalid')).toBe('false'));
    expect((await ldlDraft(view)).value).toBe('135');
    press(await ldlDraft(view));
    press(q(view, '.alr-add-btn') as HTMLElement);
    await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
    expect((await activeLdl())[0]).toBeCloseTo(toCanonicalValue('ldl', 135, 'conventional'), 6);
  });

  // A draft kept from an earlier visit carries the unit it was typed in. The
  // record's system at load, and a preference another tab set, never re-read it.
  describe('US-04 AC1, US-34 AC7: a kept LDL draft typed in mmol/L saves as mmol/L, whatever the units at load', () => {
    const keptDraft = () => localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({
      draft: { values: { ldl: '3.5' } }, backfills: {}, meta: { 'new|ldl': { unit: 'si', typedOn: 'an earlier load' } },
    }));
    async function loadAndCommit(preference: 'si' | 'conventional', recorded: 'si' | 'conventional') {
      await completeRecord();
      await saveChangedMeasurements({ unitSystem: recorded }, {});
      await flushRoadmapStore();
      keptDraft();
      localStorage.setItem('health_roadmap_unit_system', preference);
      const view = await open();
      await settle(50); // About you's opened rows take the focus a frame later; a leave would commit the draft
      press(await ldlDraft(view)); // into the cell, nothing typed
      press(q(view, '.alr-add-btn') as HTMLElement); // and out: the draft commits
      await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
      return view;
    }
    it('the record switched to US units since: it shows in mg/dL and saves 3.5 mmol/L', async () => {
      const view = await loadAndCommit('si', 'conventional');
      expect((await ldlRow(view)).textContent).toContain('mg/dL');
      expect(await activeLdl()).toEqual([3.5]);
    });
    it('another tab set this device to US units too (Codex): it saves 3.5 mmol/L', async () => {
      await loadAndCommit('conventional', 'conventional');
      expect(await activeLdl()).toEqual([3.5]);
    });
    it('another tab set this device to US units, the record still SI: it saves 3.5 mmol/L', async () => {
      await loadAndCommit('conventional', 'si');
      expect(await activeLdl()).toEqual([3.5]);
    });
    // Adversary R4 (PR 1147): a cell kept before cells carried their unit is
    // read in the units this device showed before the record applied, not
    // the record's, which the matrix may mount after.
    it('kept with no unit, this device in SI, the record in US units: it saves 3.5 mmol/L', async () => {
      await completeRecord();
      await saveChangedMeasurements({ unitSystem: 'conventional' }, {});
      await flushRoadmapStore();
      localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: {} }));
      localStorage.setItem('health_roadmap_unit_system', 'si');
      const view = await open();
      await settle(50); // About you's opened rows take the focus a frame later; a leave would commit the draft
      press(await ldlDraft(view));
      press(q(view, '.alr-add-btn') as HTMLElement);
      await waitFor(async () => expect(await activeLdl()).toHaveLength(1), { timeout: 3000 });
      expect(await activeLdl()).toEqual([3.5]);
    });
    // Adversary R3 (PR 1147): the vitals too. A weight kept before 2026-09-24 has no unit.
    it('a weight kept with no unit, this device in US units, the record in SI: 180 saves as 180 lb', async () => {
      await completeRecord();
      await saveChangedMeasurements({ unitSystem: 'si' }, {});
      await flushRoadmapStore();
      localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { weight: '180' } }, backfills: {}, meta: {} }));
      localStorage.setItem('health_roadmap_unit_system', 'conventional');
      const view = await open();
      await settle(50);
      const cell = await waitFor(() => {
        const input = q(view, '.bt-vitals-card [data-metric="weight"] .bt-cell-draft input');
        if (!input) throw new Error('no weight draft cell');
        return input as HTMLElement;
      });
      press(cell);
      press(q(view, '.alr-add-btn') as HTMLElement);
      await waitFor(async () => expect(await activeWeights()).toHaveLength(2), { timeout: 3000 });
      const today = (await activeWeights()).find(([, day]) => day === TODAY)!;
      expect(today[0]).toBeCloseTo(toCanonicalValue('weight', 180, 'conventional'), 1);
    });
  });

  it('US-11 AC6: a remote erase while a field is focused still applies at once: the form empties, and the erased record\'s units show', async () => {
    await siRecord();
    const view = await open();
    type(q(view, '#heightCm'), '171'); // focused, unsaved
    // The erasing device then chose US units in its new record: they show at once, never held.
    await eraseFromAnotherDevice({ unitSystem: 'conventional' });
    // The saved answers and the weight go. (The focused height box keeps its own typed
    // text, InputPanel's rawInputs, as before this change.)
    await waitFor(() => expect((q(view, '#birthYear') as HTMLInputElement | null)?.value ?? '').toBe(''), { timeout: 3000 });
    expect(view.queryByRole('radio', { name: 'Female', checked: true })).toBeNull();
    expect(await activeWeights()).toEqual([]);
    expect(q(view, '#heightFeet')).toBeTruthy(); // the height in ft/in, though the cm box had the focus
  });

  it('US-34 AC4, US-11 AC6 (PR 1155 review F1): the first read fails part-way; a remote erase still applies, and the failure is reported', async () => {
    await completeRecord();
    failMirror.next = true; // the first read throws after it has shown the record
    const view = await open();
    await waitFor(() => expect(failMirror.threw).toBe(true));
    await settle(50);
    await eraseFromAnotherDevice();
    await waitFor(() => expect((q(view, '#birthYear') as HTMLInputElement | null)?.value ?? '').toBe(''), { timeout: 3000 });
    expect(view.queryByRole('radio', { name: 'Female', checked: true })).toBeNull();
    // Reported as the unhandled rejection reached Sentry before, tagged so the strict scrubber strips its text (PR 1155 review R4).
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(new Error('Synthetic test: mirror failed'), { tags: { area: 'cloud-sync', op: 'load' } });
    expect(scrubbed(new Error('Synthetic test: mirror failed'))).toEqual({ tags: { area: 'cloud-sync', op: 'load' }, value: 'Health record operation failed' });
  });

  it('US-34 AC4 (PR 1155 review R1): the first read fails for a lasting reason; a remote change then fails too: reported, never unhandled, and not shown', async () => {
    await completeRecord();
    failMirror.always = true; // every mirror of the record fails: the first read's, and each re-read's
    const view = await open();
    await waitFor(() => expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1));
    await anotherWriter(() => saveChangedMeasurements({ birthYear: 1975 }, { birthYear: 1980 }));
    await waitFor(() => expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(Sentry.captureException).mock.calls.map(([e, hint]) => [(e as Error).message, hint])).toEqual([
      ['Synthetic test: lab read failed', { tags: { area: 'cloud-sync', op: 'load' } }],
      ['Synthetic test: lab read failed', { tags: { area: 'cloud-sync', op: 'load' } }],
    ]);
    await settle(50);
    // The re-read failed before it showed the record: the page keeps the first read's answer.
    expect((q(view, '#birthYear') as HTMLInputElement).value).toBe('1980');
  });
});
