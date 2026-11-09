// @vitest-environment jsdom
/**
 * Pins of today's onboarding behaviour in HealthTool (US-62 AC12, AC13, AC25,
 * AC31), written before the onboarding moves into a hook. Each test reads what
 * the person sees or what analytics is sent, never the hook's state.
 *
 * As HealthTool.onboarding.test.tsx: the whole widget over a real RoadmapStore
 * on localStorage, the real `trackProductEvent` POSTing to a stubbed fetch.
 * Added here: the upload modal and the chat column are stubbed to hand back
 * their callbacks, `trackProductEvent`'s calls are recorded before its per-tab
 * throttle, and the profile save can be made to refuse once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { parseProposedEdit, type ProposedEdit } from '@roadmap/health-core/chat-edits';
import { localDay } from '@roadmap/health-core/merge';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, bulkSaveMeasurements, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { openAboutYou } from '../testing/health-tool-harness';
import { WRITE_REFUSED } from '../lib/erase-copy';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// Every trackProductEvent call, recorded before the real one (and its per-tab throttle) runs.
const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown> | undefined]> }));
vi.mock('../lib/server-api', async original => {
  const real = await original<typeof import('../lib/server-api')>();
  return {
    ...real,
    trackABImpression: vi.fn(), trackABConversion: vi.fn(),
    trackProductEvent: (...args: Parameters<typeof real.trackProductEvent>) => {
      tracked.calls.push([args[0], args[1] as Record<string, unknown> | undefined]);
      real.trackProductEvent(...args);
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
const chat = vi.hoisted(() => ({ proposeEdit: null as null | ((edits: ProposedEdit[]) => void) }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit }: { onProposeEdit: (edits: ProposedEdit[]) => void }) => { chat.proposeEdit = onProposeEdit; return null; },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
// The upload modal: its completion, the page's re-read after an upload's save.
const upload = vi.hoisted(() => ({ complete: null as null | (() => Promise<void>) }));
vi.mock('./UploadModal', () => ({
  UploadModal: ({ onComplete }: { onComplete: () => Promise<void> }) => { upload.complete = onComplete; return null; },
}));
import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

const TODAY = localDay(new Date());

let sent: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
/** The POSTs analytics received, by name. */
const named = (name: string) => sent.filter((e) => e.eventName === name);
/** The calls HealthTool made, by name, before the per-tab throttle. */
const calls = (name: string) => tracked.calls.filter(([n]) => n === name).map(([, m]) => m);
const stops: Array<() => void> = [];

beforeEach(async () => {
  sent = [];
  tracked.calls = [];
  refuse.next = false;
  chat.proposeEdit = null;
  upload.complete = null;
  localStorage.clear(); sessionStorage.clear();
  // A wide desktop: the chat column shows.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/events')) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{"success":true}');
    }
    throw new Error('Synthetic test: no network');
  }));
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

/** The tool, once the record has loaded, with a complete record's About you rows opened (US-62 AC12). */
async function open(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#heightCm') ?? (openAboutYou(view.container), view.container.querySelector('.about-row'))).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  openAboutYou(view.container);
  return view;
}
const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
const sexQuestion = (view: RenderResult) => view.queryByRole('radiogroup', { name: 'Sex' });
const fullForm = (view: RenderResult) => !!q(view, '.bt-timeline-title');
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
}
const leave = (input: Element | null) => act(() => { (input as HTMLElement).blur(); });
const settle = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** Height and weight typed, the weight field left: its save runs 500 ms later. */
async function measurements(view: RenderResult, height = '178', weight = '80') {
  type(q(view, '#heightCm'), height);
  leave(q(view, '#heightCm'));
  type(q(view, '#weightKg'), weight);
  leave(q(view, '#weightKg'));
  await waitFor(async () => expect(await activeWeights()).toEqual([[Number(weight), TODAY]]), { timeout: 2000 });
}
function birth(view: RenderResult, month = '5', year = '1975') {
  fireEvent.change(q(view, '#birthMonth')!, { target: { value: month } });
  type(q(view, '#birthYear'), year);
}
/** Another writer changes the record, and the page is told (US-34). */
async function anotherWriter(current: Parameters<typeof saveChangedMeasurements>[0], previous: Parameters<typeof saveChangedMeasurements>[1] = {}) {
  await saveChangedMeasurements(current, previous);
  await flushRoadmapStore();
  await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
}
/** This tab's "Delete all my data", confirmed; the onboarding boxes back. */
async function eraseHere(view: RenderResult) {
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => {});
  fireEvent.click(deleteButton());
  await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
  await waitFor(() => expect(fullForm(view)).toBe(false));
}
/** The focus is on the plan-ready heading or My health's title: AC25's landing. */
const landed = () => !!document.activeElement?.matches('.mh-ready-title, .mh-title');

describe('US-62 AC13: a step answered in this tab by an upload or the chat counts', () => {
  it('US-62 AC13: an upload whose save completes a step sends onboarding_step for that step (N5)', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await flushRoadmapStore();
    const view = await open();
    expect(sexQuestion(view)).toBeNull(); // stage 1: the weight is missing
    await waitFor(() => expect(upload.complete).toBeTruthy());
    // The upload's save writes a weight, then the modal hands back to the page.
    await act(async () => {
      await bulkSaveMeasurements([{ metricType: 'weight', value: 80, recordedAt: `${TODAY}T00:00:00.000Z`, source: 'lab_import' }]);
      await upload.complete!();
    });
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy());
    await waitFor(() => expect(named('onboarding_step').map((e) => e.metadata)).toEqual([{ step: 'measurements' }]));
    expect(named('onboarding_done')).toEqual([]);
  });

  it('US-62 AC13: the chat\'s profile proposal, saved from its banner, sends onboarding_step for the step it completes', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy()); // stage 2: sex is asked
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    act(() => chat.proposeEdit!([parseProposedEdit('propose_profile_edit', { sex: 'female' })!]));
    const banner = await waitFor(() => { const b = document.body.querySelector('.chat-profile-proposal[role="status"]'); expect(b).toBeTruthy(); return b!; });
    fireEvent.click(Array.from(banner.querySelectorAll('button')).find((b) => b.textContent === 'Save')!);
    await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy()); // stage 3: the birth date is asked
    await waitFor(() => expect(named('onboarding_step').map((e) => e.metadata)).toEqual([{ step: 'sex' }]));
    expect(named('onboarding_done')).toEqual([]);
  });
});

describe('US-62 AC13: what a refused write\'s re-read raises is not counted', () => {
  // A real refusal comes with an erase (the store refuses a write under another
  // erase identity, record-session `refuses`), whose re-read starts a new record.
  // The refusal is forced here, on the same record, so the re-read raises the
  // stage and only the cleared answeredHere keeps it from counting.
  it('US-62 AC13: a refused height save re-reads a record another writer completed: the form opens, no onboarding_step, no onboarding_done, no plan-ready card', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy());
    // Another writer completes the record; the page is not told yet.
    await saveChangedMeasurements({ heightCm: 170, sex: 'male', birthYear: 1980, birthMonth: 3 }, { heightCm: 170 });
    await flushRoadmapStore();
    expect(fullForm(view)).toBe(false);
    // The person retypes the height (an onboarding answer given here); its save is refused.
    refuse.next = true;
    type(q(view, '#heightCm'), '171');
    leave(q(view, '#heightCm'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(WRITE_REFUSED), { timeout: 3000 });
    await waitFor(() => expect(fullForm(view)).toBe(true)); // the re-read raised the stage to 4
    await settle(50);
    expect(calls('onboarding_step')).toEqual([]);
    expect(calls('onboarding_done')).toEqual([]);
    expect(q(view, '.mh-ready')).toBeNull();
  });
});

describe('US-62 AC13, AC31: an erase in this tab starts the onboarding again', () => {
  it('US-62 AC13: after an erase, step 1 answered again is counted again by HealthTool; the per-tab throttle sends its POST only once', async () => {
    const view = await open();
    await measurements(view);
    await waitFor(() => expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]));
    await eraseHere(view);
    await measurements(view);
    await waitFor(() => expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }, { step: 'measurements' }]));
    // trackProductEvent's sessionStorage throttle (once per event and step per tab) swallows the second.
    expect(named('onboarding_step').map((e) => e.metadata)).toEqual([{ step: 'measurements' }]);
  });

  it('US-62 AC31: the plan-ready card shown for a record is hidden after an erase in this tab', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view);
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy());
    await eraseHere(view);
    expect(q(view, '.mh-ready')).toBeNull();
  });

  // KNOWN LATENT BUG D1: the weight's once-only landing (InputPanel's
  // hasLandedOnMyHealth; StartingInfoVitals' landedRef for the matrix) is spent
  // per mount, never reset per record, so after an erase in this tab the next
  // record's last-answer weight does not land. Flip to `it` once fixed.
  it.fails('US-62 AC25 (D1): Shopify build, weight last, erase, weight last again on the new record: the second landing still happens', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    const view = await open();
    expect(sexQuestion(view)).toBeNull(); // stage 1: only the weight is missing
    type(q(view, '#weightKg'), '105');
    await waitFor(() => expect(landed()).toBe(true)); // the first record's landing
    await waitFor(async () => expect(await activeWeights()).toEqual([[105, TODAY]]), { timeout: 2000 });
    await eraseHere(view);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    // The new record: another writer gives height, sex and birth; the weight is missing again.
    await anotherWriter({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 });
    await waitFor(() => expect((q(view, '#heightCm') as HTMLInputElement).value).toBe('170'));
    expect(landed()).toBe(false);
    type(q(view, '#weightKg'), '105');
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy()); // the onboarding did end here again
    await waitFor(() => expect(landed()).toBe(true), { timeout: 1000 });
  });
});

describe('US-62 AC12, AC31 (D6, a product question): another device fills the last answer', () => {
  it('US-62 AC12: the form opens, About you stays at the top until it is focused and left, and no plan-ready card shows', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female' }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy()); // stage 3
    await anotherWriter({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, { heightCm: 170, sex: 'female' });
    await waitFor(() => expect(fullForm(view)).toBe(true), { timeout: 3000 });
    await settle(50);
    // About you, as the onboarding's card, still above the sections.
    const about = q(view, '.mh-page .about-card');
    expect(about).toBeTruthy();
    expect(about!.compareDocumentPosition(q(view, '.mh-sections')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q(view, '.mh-ready')).toBeNull();
    expect(calls('onboarding_step')).toEqual([]);
    expect(calls('onboarding_done')).toEqual([]);
    // Focused and left: About you goes low (to Settings).
    act(() => { (q(view, '#heightCm') as HTMLElement).focus(); });
    leave(q(view, '#heightCm'));
    await waitFor(() => expect(q(view, '.mh-page .about-card')).toBeNull());
    expect(q(view, '.mh-ready')).toBeNull();
  });
});
