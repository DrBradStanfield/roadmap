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
import type { ChatEditTarget } from '../hooks/useChatState';
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
// `unmuted`: run in the chat's passive effect as the four answers first hold. A child's passive
// effects run before HealthTool's, after every layout effect of that commit (R3's frame).
const chat = vi.hoisted(() => ({ proposeEdit: null as null | ((edits: ProposedEdit[]) => void), unmuted: null as null | (() => void) }));
vi.mock('./ChatEmbed', async () => {
  const { useEffect } = await import('react');
  return {
    ChatEmbed: ({ onProposeEdit, muted }: { onProposeEdit: ChatEditTarget; muted: boolean }) => {
      chat.proposeEdit = (edits) => onProposeEdit.take(edits, onProposeEdit.ask(), true); // asked and answered at once
      useEffect(() => { if (!muted) chat.unmuted?.(); }, [muted]);
      return null;
    },
  };
});
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
// The upload modal: its completion, the page's re-read after an upload's save.
const upload = vi.hoisted(() => ({ complete: null as null | (() => Promise<void>) }));
vi.mock('./UploadModal', () => ({
  UploadModal: ({ onComplete }: { onComplete: () => Promise<void> }) => { upload.complete = onComplete; return null; },
}));
import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

// Read at assertion time, not module load: a run that crosses local midnight stamps rows with the new day.
const localToday = () => localDay(new Date());

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
  chat.unmuted = null;
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
  await waitFor(async () => expect(await activeWeights()).toEqual([[Number(weight), localToday()]]), { timeout: 2000 });
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
  // Closing Settings hands the focus to the person button (or a phone's title) a frame
  // after the delete resolves. Wait for it, so it never lands mid-answer, as no person
  // could type that fast (R1: under load it blurred the next weight, which is leaving it).
  await waitFor(() => expect(document.activeElement?.matches('.mh-person-btn, .mh-title')).toBe(true));
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
      await bulkSaveMeasurements([{ metricType: 'weight', value: 80, recordedAt: `${localToday()}T00:00:00.000Z`, source: 'lab_import' }]);
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
  // erase identity, record-session `refuses`), whose re-read starts a new record,
  // where the step count counts nothing anyway. So the state below is unreachable in
  // production today: the refusal is forced on the same record, so the re-read
  // raises the stage and only the cleared answer mark keeps it from counting.
  it('US-62 AC13 (guard): if a refused write\'s re-read ever raised the stage on the same record, nothing would be counted', async () => {
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

});

describe('US-62 AC25: the last answer lands on My health, once per record (D1)', () => {
  /** A record finished here with the weight last (the landing spent), erased
   *  here, then a new record another writer fills to all but the weight, and
   *  its weight typed: the onboarding ends here again. */
  async function weightLastTwice(): Promise<RenderResult> {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    const view = await open();
    expect(sexQuestion(view)).toBeNull(); // stage 1: only the weight is missing
    type(q(view, '#weightKg'), '105');
    await waitFor(() => expect(landed()).toBe(true)); // the first record's landing
    await waitFor(async () => expect(await activeWeights()).toEqual([[105, localToday()]]), { timeout: 2000 });
    await eraseHere(view);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    // The new record: another writer gives height, sex and birth; the weight is missing again.
    await anotherWriter({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 });
    await waitFor(() => expect((q(view, '#heightCm') as HTMLInputElement).value).toBe('170'));
    expect(landed()).toBe(false);
    type(q(view, '#weightKg'), '105');
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy()); // the onboarding did end here again
    return view;
  }

  it('US-62 AC25: weight last, erase, weight last again: the first record lands, and the new record ends with its plan-ready card', async () => {
    await weightLastTwice();
  });

  // D1, fixed 2026-11-10: the #weightKg field's landing was spent per mount,
  // never per record, so after an erase in this tab the next record's
  // last-answer weight did not land. It is now keyed to the record's erase
  // identity. StartingInfoVitals' matrix weight follows the same rule and is
  // not driven here.
  it('US-62 AC25 (D1): Shopify build, weight last, erase, weight last again on the new record: the second landing still happens', async () => {
    await weightLastTwice();
    await waitFor(() => expect(landed()).toBe(true), { timeout: 1000 });
  });
});

describe('US-62 AC13: another writer\'s change clears an answer given here', () => {
  it('US-62 AC13: a height retyped here, then another device finishing the record, sends no step and shows no plan-ready card', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy()); // stage 2
    // An answer given here that raises nothing: the mark is set and not spent.
    type(q(view, '#heightCm'), '171');
    leave(q(view, '#heightCm'));
    await settle(700);
    await anotherWriter({ sex: 'female', birthYear: 1980, birthMonth: 3 });
    await waitFor(() => expect(fullForm(view)).toBe(true), { timeout: 3000 });
    await settle(50);
    expect(calls('onboarding_step')).toEqual([]);
    expect(calls('onboarding_done')).toEqual([]);
    expect(q(view, '.mh-ready')).toBeNull();
  });
});

describe('US-62 AC12, AC31 (D6, Brad 2026-11-10: keep it): another device fills the last answer', () => {
  it('US-62 AC12: the form opens, About you stays at the top until it is focused and left, and no plan-ready card shows', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female' }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy()); // stage 3
    // An answer given here that raises nothing (the month without the year), so the checks below can fail.
    fireEvent.change(q(view, '#birthMonth')!, { target: { value: '5' } });
    expect(fullForm(view)).toBe(false);
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

describe('US-62 AC25 (D4): one landing per record, kept with the record\'s onboarding', () => {
  /** A desktop that can cross 768px: each cross builds the panels again. */
  function crossablePhone() {
    const heard = new Set<{ query: string; listener: (e: { matches: boolean }) => void }>();
    let phone = false;
    const matches = (query: string) => (query.includes('max-width') ? phone : !phone);
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return matches(query); },
      media: query,
      addEventListener: (_: string, listener: (e: { matches: boolean }) => void) => heard.add({ query, listener }),
      removeEventListener: (_: string, listener: (e: { matches: boolean }) => void) => {
        for (const h of heard) if (h.listener === listener) heard.delete(h);
      },
    }));
    return () => act(() => { phone = !phone; for (const h of [...heard]) h.listener({ matches: matches(h.query) }); });
  }
  /** The vitals matrix's New-column weight cell (mounted, hidden under the rows once About you is low). */
  const matrixWeight = (view: RenderResult) => {
    const row = Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
    return row?.querySelector('.bt-cell-draft input') ?? null;
  };
  /** A record holding a blood test, so the whole form opens with sex and birth both asked (US-01 AC3). */
  async function wholeFormWithoutSexOrBirth(): Promise<RenderResult> {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await addMeasurement('ldl', 3.0, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy());
    expect(fullForm(view)).toBe(true);
    expect(sexQuestion(view)).toBeTruthy();
    return view;
  }

  it('US-62 AC25 (D4): the weight lands, the page crosses 768px, and a weight typed in the matrix on the same record does not land again', async () => {
    const cross = crossablePhone();
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    const view = await open();
    type(q(view, '#weightKg'), '105'); // the last answer (Shopify build)
    await waitFor(() => expect(landed()).toBe(true));
    await waitFor(async () => expect(await activeWeights()).toEqual([[105, localToday()]]), { timeout: 2000 });
    const before = matrixWeight(view);
    cross(); // a phone: the panels are built again
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    const cell = matrixWeight(view)!;
    expect(cell).not.toBe(before); // a new matrix: its own refs started empty
    type(cell, '106');
    await settle(100);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(cell);
  });

  it('US-62 AC25b (R3): an ambiguous last weight, then the page crosses 768px during its wait: a later weight does not land', async () => {
    const cross = crossablePhone();
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    const view = await open();
    type(q(view, '#weightKg'), '25'); // ends the onboarding; may become 250: the wait starts
    cross(); // the focused box unmounts with no blur
    await waitFor(() => expect(q(view, '#weightKg')).toBeTruthy());
    await settle(900);
    expect(landed()).toBe(false);
    type(q(view, '#weightKg'), '82');
    await settle(300);
    expect(landed()).toBe(false);
  });

  it('US-62 AC25 (D4): a record already complete when first shown never lands: a weight typed in the matrix keeps the focus', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    await settle(200); // About you's rows, opened by open(), take their focus first
    const cell = matrixWeight(view)!;
    type(cell, '106'); // Shopify build: a weight would land, were it the last answer
    await settle(100);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(cell);
  });

  it('US-62 AC25 (D4, D6): another device completes the record; a weight then typed here does not land, and About you stays at the top', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female' }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy()); // stage 3
    await anotherWriter({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, { heightCm: 170, sex: 'female' });
    await waitFor(() => expect(fullForm(view)).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    const cell = matrixWeight(view)!;
    type(cell, '106');
    await settle(100);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(cell);
    expect(q(view, '.mh-page .about-card')).toBeTruthy();
  });

  it('US-62 AC25 (D4, R2): an onboarding that ends on sex spends its landing: a later matrix weight does not land', async () => {
    const view = await wholeFormWithoutSexOrBirth();
    birth(view, '5', '1975'); // the year before sex: asked, but not the last answer
    await settle(50);
    const focused = document.activeElement;
    fireEvent.click(view.getByRole('radio', { name: 'Male' })); // sex last: the onboarding ends here, with no landing (AC31)
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy());
    await settle(50);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(focused);
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    await settle(200);
    const cell = matrixWeight(view)!;
    type(cell, '106');
    await settle(100);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(cell);
  });

  it('US-62 AC25 (D4, R3): a matrix weight as the last answer lands though its frame fires before the page\'s passive effects; onboarding_done is sent once', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('waist', 90, '2026-09-01'); // a saved vital: the whole form, the vitals as a matrix
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    await settle(200);
    // Frames held until the chat sees the four answers hold: before the page's passive effects run.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    const runFrames = () => { for (const cb of frames.splice(0)) cb(0); };
    chat.unmuted = runFrames;
    type(matrixWeight(view), '106'); // the weight, the last answer, typed in the matrix (Shopify build)
    await settle(50);
    await waitFor(() => { runFrames(); expect(landed()).toBe(true); }); // the landing's frame, then its focus frame
    expect(calls('onboarding_done')).toHaveLength(1);
  });

  it('US-62 AC25 (D4): a complete year typed before sex lands nothing and leaves the landing for the year that is the last answer', async () => {
    const view = await wholeFormWithoutSexOrBirth();
    birth(view, '5', '1975'); // sex not yet given: not the last answer
    await settle(50);
    expect(landed()).toBe(false);
    type(q(view, '#birthYear'), ''); // cleared to retype
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    await settle(50);
    expect(landed()).toBe(false);
    type(q(view, '#birthYear'), '1976'); // now the last answer
    await waitFor(() => expect(landed()).toBe(true), { timeout: 1000 });
  });

  it('US-62 AC25 (D4): after an erase in this tab the new record lands on its last answer, whatever the record before did', async () => {
    const view = await wholeFormWithoutSexOrBirth();
    birth(view, '5', '1975'); // a year before sex: no landing
    await settle(50);
    expect(landed()).toBe(false);
    await eraseHere(view); // the record never completed
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    await settle(50);
    birth(view); // the year, the new record's last answer
    await waitFor(() => expect(landed()).toBe(true), { timeout: 1000 });
  });
});

describe('US-62 AC25b: the weight or year that ends the onboarding lands once it is complete, while the person is still in it', () => {
  /** Height, sex and birth on record: the weight in the box is the last answer (Shopify build). */
  async function weightLast(): Promise<RenderResult> {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    const view = await open();
    expect(sexQuestion(view)).toBeNull();
    return view;
  }
  const matrixWeight = (view: RenderResult) => {
    const row = Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
    return row?.querySelector('.bt-cell-draft input') ?? null;
  };

  it('a: "25" backspaced to "2" waits out its 800 ms with no landing; "82" then lands', async () => {
    const view = await weightLast();
    const box = q(view, '#weightKg');
    type(box, '25'); // complete, but may become 250: the wait starts
    type(box, '2');
    await settle(900);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(box);
    type(box, '82');
    await waitFor(() => expect(landed()).toBe(true), { timeout: 500 });
  });

  it('b: "25" cleared to "" waits out its 800 ms with no landing; "82" then lands', async () => {
    const view = await weightLast();
    const box = q(view, '#weightKg');
    type(box, '25');
    type(box, '');
    await settle(900);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(box);
    type(box, '82');
    await waitFor(() => expect(landed()).toBe(true), { timeout: 500 });
  });

  it('c: a kg matrix weight typed digit by digit, "2", "25", "250", lands once, after "250"', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('waist', 90, '2026-09-01'); // the whole form, the vitals as a matrix
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    await settle(200);
    const cell = matrixWeight(view)!;
    type(cell, '2');
    type(cell, '25');
    await settle(100);
    expect(landed()).toBe(false); // "25" may become "250": still waiting
    type(cell, '250');
    await waitFor(() => expect(landed()).toBe(true), { timeout: 500 });
    expect(calls('onboarding_done')).toHaveLength(1);
  });

  it('d: "25", then the focus leaves the box within 800 ms: no landing, then or for a later weight', async () => {
    const view = await weightLast();
    const box = q(view, '#weightKg');
    type(box, '25');
    act(() => { (q(view, '#heightCm') as HTMLElement).focus(); }); // another field, before the wait ends
    await settle(1000);
    expect(landed()).toBe(false);
    type(box, '82');
    await settle(300);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  it('a save refused during the last weight\'s wait spends the landing, though the re-read brings the four answers back', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    const view = await weightLast();
    await addMeasurement('weight', 80, '2026-09-01'); // another device's weight; the page is not told yet
    await flushRoadmapStore();
    refuse.next = true; // the next profile save is refused
    type(q(view, '#heightCm'), '171'); // a profile edit: its save runs 500 ms after the last change
    type(q(view, '#weightKg'), '25'); // the last answer; may become 250: an 800 ms wait
    await waitFor(() => expect(alert).toHaveBeenCalledWith(WRITE_REFUSED), { timeout: 2000 });
    expect(landed()).toBe(false); // refused within the wait
    await settle(900);
    expect(fullForm(view)).toBe(true); // the re-read holds the four answers, with no keystroke here
    expect(landed()).toBe(false);
  });

  it('h: the chat proposing the last weight lands nothing, and a weight typed after does not land', async () => {
    const view = await weightLast();
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: 105, unitSystem: 'si', date: null }]));
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy()); // the onboarding ended here
    await settle(300);
    expect(landed()).toBe(false);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    type(q(view, '#weightKg'), '106');
    await settle(300);
    expect(landed()).toBe(false);
  });

  it('h: an upload completing the record lands nothing, and a weight typed after does not land', async () => {
    const view = await weightLast();
    await waitFor(() => expect(upload.complete).toBeTruthy());
    await act(async () => {
      await bulkSaveMeasurements([{ metricType: 'weight', value: 80, recordedAt: `${localToday()}T00:00:00.000Z`, source: 'lab_import' }]);
      await upload.complete!();
    });
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy());
    await settle(300);
    expect(landed()).toBe(false);
    await waitFor(() => expect(matrixWeight(view)).toBeTruthy());
    const cell = matrixWeight(view)!;
    type(cell, '106');
    await settle(300);
    expect(landed()).toBe(false);
    expect(document.activeElement).toBe(cell);
  });
});

describe('US-62 AC13, AC25b: the matrix weight and its frames', () => {
  /** Frames held until run; `syncNext` runs the next one at once, inside the keystroke, before its commit. */
  function heldFrames() {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    let sync = false;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      if (sync) { sync = false; cb(0); return 0; }
      frames.set(++id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (h: number) => { frames.delete(h); });
    return {
      syncNext: () => { sync = true; },
      run: () => { const all = [...frames.values()]; frames.clear(); for (const cb of all) cb(0); },
    };
  }
  const weightRow = (view: RenderResult) => Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
  /** Height, sex and birth, a waist saved on 2026-09-01, no weight: the vitals as a matrix, the weight the last answer. */
  async function matrixWeightLast(): Promise<RenderResult> {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('waist', 90, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(weightRow(view)?.querySelector('.bt-cell-draft input')).toBeTruthy());
    await settle(200);
    return view;
  }

  it('US-62 AC13, AC31 (R2): a weight typed into the empty 09-01 cell and saved counts as the last step, and lands nothing', async () => {
    const view = await matrixWeightLast();
    const cell = weightRow(view)!.querySelector('.bt-cell-backfill input')!;
    type(cell, '80');
    fireEvent.keyDown(cell, { key: 'Enter' });
    await waitFor(() => expect(q(view, '.mh-ready')).toBeTruthy(), { timeout: 3000 });
    expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]);
    expect(calls('onboarding_done')).toHaveLength(1);
    await settle(300);
    expect(landed()).toBe(false);
  });

  it('US-62 AC25b (R5): the matrix weight\'s rest heard before the commit that ends the onboarding still lands', async () => {
    const view = await matrixWeightLast();
    const frames = heldFrames();
    frames.syncNext(); // the rest's frame fires inside the keystroke, before the stage reaches 4
    type(weightRow(view)!.querySelector('.bt-cell-draft input'), '106');
    await waitFor(() => { frames.run(); expect(landed()).toBe(true); }); // the landing's frame, then its focus frame
  });

  it('US-62 AC25b (R4): "72" ends it, cleared, "72" again with its rest before its commit: lands', async () => {
    const view = await matrixWeightLast();
    const frames = heldFrames();
    const cell = () => weightRow(view)!.querySelector('.bt-cell-draft input');
    type(cell(), '72'); // ends the onboarding; its rest's frame held
    type(cell(), ''); // cancels that rest; the stage falls
    frames.syncNext();
    type(cell(), '72'); // its rest fires before the stage is 4 again
    await waitFor(() => { frames.run(); expect(landed()).toBe(true); });
    expect(calls('onboarding_done')).toHaveLength(1);
  });

  describe('US-62 AC31a: the chat\'s weight is an answer given here, in the box or the grid (AC13 Events, AC31)', () => {
    const chatWeight = (date: string | null = null) =>
      act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: 105, unitSystem: 'si', date }]));
    const ready = (view: RenderResult) => q(view, '.mh-ready-title')?.textContent ?? null;
    /** Height, sex and birth saved, less `missing`; `waist` opens the whole form, so the weight row is in the grid. */
    async function chatReady({ waist = true, missing = null as 'sex' | 'birth' | null, weight = false } = {}): Promise<RenderResult> {
      await saveChangedMeasurements({ heightCm: 170, ...(missing === 'sex' ? {} : { sex: 'female' as const }), ...(missing === 'birth' ? {} : { birthYear: 1980, birthMonth: 3 }) }, {});
      if (waist) await addMeasurement('waist', 90, '2026-09-01');
      if (weight) await addMeasurement('weight', 80, '2026-09-01');
      await flushRoadmapStore();
      const view = await open();
      if (waist) await waitFor(() => expect(weightRow(view)?.querySelector('.bt-cell-draft input')).toBeTruthy());
      await settle(200);
      await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
      return view;
    }

    it.each([['the box beside the height', false], ['the grid\'s New cell', true]])('%s: the last answer sends onboarding_step and onboarding_done once, shows the card, and lands nothing', async (_where, waist) => {
      const view = await chatReady({ waist });
      chatWeight();
      if (waist) expect((weightRow(view)!.querySelector('.bt-cell-draft input') as HTMLInputElement).value).toBe('105');
      await waitFor(() => expect(ready(view)).toBe('Your plan is ready.'));
      await settle(300);
      expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]);
      expect(calls('onboarding_done')).toHaveLength(1);
      expect(landed()).toBe(false); // AC25b: an answer from the chat never jumps
    });

    it('the grid\'s empty 2026-09-01 cell: the chat\'s dated weight, saved, is the last answer', async () => {
      const view = await chatReady();
      chatWeight('2026-09-01');
      const cell = weightRow(view)!.querySelector('.bt-cell-backfill input') as HTMLInputElement;
      expect(cell.value).toBe('105');
      fireEvent.keyDown(cell, { key: 'Enter' });
      await waitFor(() => expect(ready(view)).toBe('Your plan is ready.'), { timeout: 3000 });
      expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]);
      expect(calls('onboarding_done')).toHaveLength(1);
      await settle(300);
      expect(landed()).toBe(false);
    });

    it('a weight typed into the New cell after the chat\'s ended it neither lands nor counts again', async () => {
      const view = await chatReady();
      chatWeight();
      await waitFor(() => expect(ready(view)).toBe('Your plan is ready.'));
      type(weightRow(view)!.querySelector('.bt-cell-draft input'), '106');
      await settle(1000);
      expect(landed()).toBe(false);
      expect(calls('onboarding_step')).toHaveLength(1);
      expect(calls('onboarding_done')).toHaveLength(1);
    });

    it.each(['sex', 'birth'] as const)('%s still missing: the chat\'s grid weight counts the measurements step only, with no card', async (missing) => {
      const view = await chatReady({ missing });
      chatWeight();
      await waitFor(() => expect(calls('onboarding_step')).toEqual([{ step: 'measurements' }]));
      await settle(300);
      expect(calls('onboarding_done')).toHaveLength(0);
      expect(q(view, '.mh-ready')).toBeNull();
    });

    it('a waist from the chat is no answer: the last weight typed in the grid still lands after its wait', async () => {
      const view = await chatReady();
      type(weightRow(view)!.querySelector('.bt-cell-draft input'), '25'); // may become 250: an 800 ms wait
      act(() => chat.proposeEdit!([{ kind: 'field', field: 'waistCm', displayValue: 91, unitSystem: 'si', date: null }]));
      await waitFor(() => expect(landed()).toBe(true), { timeout: 2000 });
    });

    it('a record already holding a weight: the chat\'s grid weight sends nothing and shows no card', async () => {
      const view = await chatReady({ weight: true });
      chatWeight();
      await waitFor(() => expect((weightRow(view)!.querySelector('.bt-cell-draft input') as HTMLInputElement).value).toBe('105'));
      await settle(300);
      expect(calls('onboarding_step')).toEqual([]);
      expect(calls('onboarding_done')).toEqual([]);
      expect(q(view, '.mh-ready')).toBeNull();
    });
  });
});
