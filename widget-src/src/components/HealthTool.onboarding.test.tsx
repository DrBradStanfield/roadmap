// @vitest-environment jsdom
/**
 * US-62 AC13 (web redesign phase 2b): the form is the onboarding, in Brad's
 * order. Height and weight show the BMI tile; sex adds the healthy weight and
 * the protein target; the birth month and year open the rest of the form, the
 * chat and the embed (US-15 AC10). Each step is required. Weight saves when
 * the person leaves its field, one active row per day. A reload resumes at
 * the first missing answer. A saved blood test opens the whole form with the
 * missing questions pinned at the top.
 *
 * The whole widget renders over a real RoadmapStore on localStorage; the
 * real `trackProductEvent` runs, so the event tests read the POSTs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { localDay, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
// The chat column: what it was told about muting.
const chat = vi.hoisted(() => ({ muted: [] as boolean[] }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ muted }: { muted?: boolean }) => { chat.muted.push(!!muted); return null; },
}));
import { HealthTool } from './HealthTool';

const TODAY = localDay(new Date());
const WHY_SEX = 'Used to calculate ideal body weight, kidney function, and screening programs.';
const WHY_BIRTH = 'Used to calculate age-based screening suggestions (cancer, bone density) and kidney function.';

let sent: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
const named = (name: string) => sent.filter((e) => e.eventName === name);
const stops: Array<() => void> = [];
let phone = false;

beforeEach(async () => {
  phone = false;
  sent = [];
  chat.muted = [];
  localStorage.clear(); sessionStorage.clear();
  // Wide desktop: the chat column shows. A phone matches the max-width query.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
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

/** The tool, once the record has loaded (the profile card shows Height). */
async function open(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#heightCm')).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return view;
}
const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
/** The plan's tiles with a value (not the empty preview's placeholders). */
const tiles = (view: RenderResult) => Array.from(view.container.querySelectorAll('.stat-card:not(.stat-card--awaiting) .stat-label')).map((l) => l.textContent);
const sexQuestion = (view: RenderResult) => view.queryByRole('radiogroup', { name: 'Sex' });
const fullForm = (view: RenderResult) => !!q(view, '.bt-timeline-title');
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
}
const leave = (input: Element | null) => act(() => { (input as HTMLElement).blur(); });
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

describe('US-62 AC13: each step reveals the next', () => {
  it('a new visitor sees height and weight only: no sex, no birth date, no rest of the form', async () => {
    const view = await open();
    expect(q(view, '#heightCm')).toBeTruthy();
    expect(q(view, '#weightKg')).toBeTruthy();
    expect(sexQuestion(view)).toBeNull();
    expect(q(view, '#birthMonth')).toBeNull();
    expect(fullForm(view)).toBe(false);
    expect(view.queryByText(/Skip/)).toBeNull();
  });

  it('height and weight show the BMI tile with no sex, then ask sex with its why-text', async () => {
    const view = await open();
    await measurements(view);
    await waitFor(() => expect(tiles(view)).toContain('BMI'));
    expect(tiles(view)).not.toContain('Ideal Body Weight (IBW)');
    expect(tiles(view)).not.toContain('Protein Target');
    expect(sexQuestion(view)).toBeTruthy();
    expect(view.getByText(WHY_SEX)).toBeTruthy();
    expect(q(view, '#birthMonth')).toBeNull();
    expect(fullForm(view)).toBe(false);
  });

  it('sex adds the healthy weight and protein target, then asks the birth date with its why-text', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Female' }));
    await waitFor(() => expect(tiles(view)).toEqual(expect.arrayContaining(['BMI', 'Ideal Body Weight (IBW)', 'Protein Target'])));
    expect(q(view, '#birthMonth')).toBeTruthy();
    expect(view.getByText(WHY_BIRTH)).toBeTruthy();
    expect(fullForm(view)).toBe(false);
  });

  it('the birth month and year open the rest of the form', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view);
    await waitFor(() => expect(fullForm(view)).toBe(true));
  });

  it('the why-texts are no longer tooltips', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    expect(view.queryByLabelText('Why we ask for your sex')).toBeNull();
    expect(view.queryByLabelText('Why we ask for your birth date')).toBeNull();
  });
});

describe('US-62 AC13: the weight saves when its field is left (B10)', () => {
  it('saves on leaving, with no Save button, and a second weight the same day corrects it', async () => {
    const view = await open();
    await measurements(view, '178', '80');
    // Leave the page now: the weight is already on record.
    const field = view.container.querySelector('.collapsed-field-value') as HTMLElement | null;
    if (field) fireEvent.click(field); // the saved weight, clicked open to type today's again
    type(q(view, '#weightKg'), '79');
    leave(q(view, '#weightKg'));
    await waitFor(async () => expect(await activeWeights()).toEqual([[79, TODAY]]), { timeout: 2000 });
    const rows = (await recordOnDisk()).measurements.filter((m) => m.metricType === 'weight');
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'entered-in-error']);
  });
});

describe('US-62 AC13: a reload resumes at the first missing answer', () => {
  it('after step 1, at the sex question', async () => {
    const view = await open();
    await measurements(view);
    view.unmount();
    const again = await open();
    await waitFor(() => expect(sexQuestion(again)).toBeTruthy());
    expect(q(again, '#birthMonth')).toBeNull();
    expect(fullForm(again)).toBe(false);
  });

  it('after step 2, at the birth date', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); // the profile's 500 ms save
    view.unmount();
    const again = await open();
    await waitFor(() => expect(q(again, '#birthMonth')).toBeTruthy());
    expect(fullForm(again)).toBe(false);
  });

  it('a returning user with a saved weight and no sex goes to the sex question', async () => {
    await saveChangedMeasurements({ heightCm: 170, birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy());
    expect(fullForm(view)).toBe(false);
    expect(q(view, '.health-field.field-attention .sex-toggle')).toBeTruthy();
  });
});

describe('US-62 AC13: a saved blood test opens the whole form, the missing questions pinned at the top', () => {
  it('shows the blood tests and asks sex and birth date above them', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('ldl', 3.1, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const sex = sexQuestion(view)!;
    const month = q(view, '#birthMonth')!;
    const grid = q(view, '.bt-timeline-title')!;
    expect(sex.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(month.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sex.closest('.field-attention')).toBeTruthy();
    // Not done: the chat stays muted.
    expect(chat.muted.at(-1)).toBe(true);
  });
});

describe('US-62 AC13 / US-15 AC10: the chat stays muted until all four are known', () => {
  it('muted through steps 1 to 3, unmuted once the birth date lands', async () => {
    const view = await open();
    expect(chat.muted.at(-1)).toBe(true);
    await measurements(view);
    expect(chat.muted.at(-1)).toBe(true);
    fireEvent.click(view.getByRole('radio', { name: 'Female' }));
    expect(chat.muted.at(-1)).toBe(true);
    birth(view);
    await waitFor(() => expect(chat.muted.at(-1)).toBe(false));
  });
});

describe('US-62 AC13: onboarding events (AC1, AC2)', () => {
  it('sends each step once and onboarding_done, with the step word and nothing else', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Female' }));
    fireEvent.click(view.getByRole('radio', { name: 'Male' })); // a re-answer counts once
    birth(view);
    await waitFor(() => expect(named('onboarding_done')).toHaveLength(1));
    expect(named('onboarding_step').map((e) => e.metadata)).toEqual([
      { step: 'measurements' }, { step: 'sex' }, { step: 'birth' },
    ]);
    expect(named('onboarding_done')[0].metadata ?? {}).toEqual({});
  });

  it('a returning user who is already done sends none', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(named('onboarding_step')).toEqual([]);
    expect(named('onboarding_done')).toEqual([]);
  });
});

describe('US-62 AC13: on a phone, the My plan tab shows a dot when a new tile appears', () => {
  it('dots on the BMI tile, clears on opening My plan, dots again on the next tiles', async () => {
    phone = true;
    const view = await open();
    const planTab = view.getByRole('tab', { name: /My plan/ });
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    await measurements(view);
    await waitFor(() => expect(planTab.querySelector('.hr-tab-dot')).toBeTruthy());
    fireEvent.click(planTab);
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    fireEvent.click(view.getByRole('tab', { name: /My data/ }));
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    await waitFor(() => expect(planTab.querySelector('.hr-tab-dot')).toBeTruthy());
  });
});
