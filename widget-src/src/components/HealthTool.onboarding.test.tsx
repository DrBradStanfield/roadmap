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
import { act, cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { localDay, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, bulkSaveDocuments, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveMedication, saveSupplement } from '../lib/roadmap-data';
import { MIRROR_KEY } from '../lib/storage';
import { openAboutYou } from '../testing/health-tool-harness';
import { formatShortDate } from '../lib/constants';

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
const chat = vi.hoisted(() => ({ muted: [] as boolean[], proposeEdit: null as null | ((edits: unknown[]) => void) }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ muted, onProposeEdit }: { muted?: boolean; onProposeEdit: (edits: unknown[]) => void }) => { chat.muted.push(!!muted); chat.proposeEdit = onProposeEdit; return null; },
}));
// The desktop floating chat's panel: whether it is open and muted.
const floating = vi.hoisted(() => ({ muted: [] as boolean[] }));
vi.mock('./ChatSection', () => ({
  ChatSection: ({ muted }: { muted?: boolean }) => { floating.muted.push(!!muted); return <div className="floating-chat-panel"/>; },
}));
import { HealthTool } from './HealthTool';

const TODAY = localDay(new Date());
const WHY_SEX = 'Used to calculate ideal body weight, kidney function, and screening programs.';
const WHY_BIRTH = 'Used to calculate age-based screening suggestions (cancer, bone density) and kidney function.';

let sent: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
const named = (name: string) => sent.filter((e) => e.eventName === name);
const stops: Array<() => void> = [];
let phone = false;
/** 1200px and up: the inline chat column shows (`useIsWideDesktop`). */
let wide = true;

beforeEach(async () => {
  phone = false;
  wide = true;
  sent = [];
  chat.muted = [];
  floating.muted = [];
  localStorage.clear(); sessionStorage.clear();
  // Wide desktop: the chat column shows. A phone matches the max-width query;
  // a narrow desktop (`wide` false) matches neither.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone && wide, media: q, addEventListener() {}, removeEventListener() {},
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

/** The tool, once the record has loaded (the profile card shows Height), with
 *  a complete record's About you rows opened, so each field shows (US-62 AC12). */
async function open(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#heightCm, .about-row')).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  openAboutYou(view.container);
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
    expect(tiles(view)).not.toContain('Ideal Body Weight');
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
    await waitFor(() => expect(tiles(view)).toEqual(expect.arrayContaining(['BMI', 'Ideal Body Weight', 'Protein Target'])));
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

describe('US-62 AC12, AC13 (Brad 2026-11-02): boxes while typing, rows after', () => {
  const sectionOrder = (view: RenderResult) =>
    [...view.container.querySelectorAll('.health-input-panel h3')].map(h => h.textContent!.replace('\u25B8', '').trim())
      .filter(t => ['Vitals', 'Blood tests', 'Supplements', 'About you', 'Starting Info'].includes(t));
  const aboutRows = (view: RenderResult) => [...view.container.querySelectorAll('.about-row')]
    .map(r => [r.querySelector('.about-row-label')!.textContent, r.querySelector('.about-row-value, .md-row-add')!.textContent]);

  it('at desktop width a saved weight stays a plain box beside the height, holding its value, never a saved-value row', async () => {
    const view = await open();
    await measurements(view, '185', '90');
    const boxes = q(view, '.sex-height-row')!;
    expect([...boxes.querySelectorAll('input')].map(i => [i.id, i.value])).toEqual([['heightCm', '185'], ['weightKg', '90']]);
    expect(boxes.querySelector('.collapsed-field-row')).toBeNull();
    expect(boxes.children).toHaveLength(2);
  });

  it('the onboarding finished in this visit stays at the top as boxes while the focus is in its card; the next visit shows About you low, as rows, on desktop', async () => {
    const view = await open();
    await measurements(view, '185', '90');
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view, '6', '1985');
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(sectionOrder(view)[0]).toBe('Starting Info');
    expect(q(view, '#weightKg')).toBeTruthy(); // typed here, it stays beside the height for the visit
    expect(q(view, '.about-row')).toBeNull();
    await waitFor(async () => expect((await recordOnDisk()).profile.birthYear).toBe(1985), { timeout: 2000 });
    view.unmount();

    const again = render(<HealthTool />);
    await waitFor(() => expect(q(again, '.about-row')).toBeTruthy());
    expect(sectionOrder(again)).toEqual(['Vitals', 'Blood tests', 'Supplements', 'About you']);
    expect(aboutRows(again)).toEqual([['Height', '185 cm'], ['Sex', 'Male'], ['Birth', 'June 1985'], ['Alcohol', 'Not answered']]); // US-60 AC4
    expect(q(again, '#heightCm')).toBeNull();
    expect(q(again, '.md-about-you #weightKg')).toBeNull(); // the weight lives in the vitals rows
    // A tap opens the field itself, its why-line with it; Done gives the row back.
    fireEvent.click(q(again, '#about-sex')!);
    expect(within(q(again, '[data-about="sex"]') as HTMLElement).getByText(WHY_SEX)).toBeTruthy();
    fireEvent.click(q(again, '#about-height')!);
    expect((q(again, '#heightCm') as HTMLInputElement).value).toBe('185');
    fireEvent.click(within(q(again, '[data-about="height"]') as HTMLElement).getByRole('button', { name: 'Done' }));
    expect(q(again, '#heightCm')).toBeNull();
    expect(q(again, '#about-height')).toBeTruthy();
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

  it('US-62 AC13 (adversary R3, 2026-11-02): a saved weight from another day in the onboarding box says when it was saved; today\'s says nothing', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 90, '2024-03-03');
    await flushRoadmapStore();
    const view = await open();
    const box = await waitFor(() => { const b = q(view, '#weightKg') as HTMLInputElement; expect(b).toBeTruthy(); return b; });
    expect(box.value).toBe('90');
    const line = () => box.closest('.health-field')!.querySelector('.previous-reference')?.textContent;
    expect(line()).toBe(`Saved ${formatShortDate('2024-03-03')}`);
    // Typing a new weight swaps it for the usual reference to the saved one.
    fireEvent.change(box, { target: { value: '88' } });
    expect(line()).toBe(`Previous: 90 kg · ${formatShortDate('2024-03-03')}`);
    view.unmount();

    await addMeasurement('weight', 89, TODAY);
    await flushRoadmapStore();
    const again = await open();
    const today = await waitFor(() => { const b = q(again, '#weightKg') as HTMLInputElement; expect(b?.value).toBe('89'); return b; });
    expect(today.closest('.health-field')!.querySelector('.previous-reference')).toBeNull();
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
    // Read as the tab's description; the name stays "My plan".
    expect(view.getByRole('tab', { name: 'My plan' })).toBe(planTab);
    expect(document.getElementById(planTab.getAttribute('aria-describedby')!)?.textContent).toBe('New');
    fireEvent.click(planTab);
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    fireEvent.click(view.getByRole('tab', { name: /My data/ }));
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    await waitFor(() => expect(planTab.querySelector('.hr-tab-dot')).toBeTruthy());
  });
});

describe('US-62 AC13 review fixes (PR 421)', () => {
  it('R1: a birth year alone answers the step: a year-only record gets the whole form, nothing pinned', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(q(view, '#birthYear')).toBeTruthy();
    expect(q(view, '#birthMonth')!.closest('.field-attention')).toBeNull();
    expect(chat.muted.at(-1)).toBe(false);
  });

  it('R1: a returning record with medications and no birth date gets the whole form, the question pinned', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'male' }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    await saveMedication('statin', 'rosuvastatin', 10, 'mg');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const month = q(view, '#birthMonth')!;
    expect(month.closest('.field-attention')).toBeTruthy();
    expect(month.compareDocumentPosition(q(view, '.bt-timeline-title')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chat.muted.at(-1)).toBe(true);
  });

  it('R2: on a phone, retyping the birth year keeps the field and its focus where they are', async () => {
    phone = true;
    await saveChangedMeasurements({ heightCm: 170, sex: 'male', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(q(view, '.md-about-you #birthYear')).toBeTruthy()); // About you low
    const year = q(view, '#birthYear') as HTMLInputElement;
    act(() => year.focus());
    fireEvent.change(year, { target: { value: '' } });
    fireEvent.change(year, { target: { value: '198' } });
    expect(q(view, '#birthYear')).toBe(year);
    expect(document.activeElement).toBe(year);
    expect(q(view, '.md-about-you #birthYear')).toBe(year);
    fireEvent.change(year, { target: { value: '1981' } });
    expect(q(view, '#birthYear')).toBe(year);
    expect(document.activeElement).toBe(year);
  });

  it('R3: the desktop floating chat button waits for all four answers', async () => {
    wide = false; // under 1200px: no chat column, so the button is the chat
    const view = await open();
    const fab = () => document.querySelector('.chat-fab');
    expect(fab()).toBeNull();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    expect(fab()).toBeNull();
    birth(view);
    await waitFor(() => expect(fab()).toBeTruthy());
    void view;
  });

  it('R4: a returning user resuming mid-onboarding sees the weight once when the form opens (the vitals as a matrix)', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    await flushRoadmapStore();
    seedMatrixMirror();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy());
    fireEvent.click(view.getByRole('radio', { name: 'Female' }));
    birth(view);
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(weightPlaces(view)).toHaveLength(1);
    expect(q(view, '.bt-vitals-card')).toBeTruthy(); // the matrix, not the first-time fields
  });

  it('R5: a jump from another device or tab sends no onboarding events', async () => {
    await saveChangedMeasurements({ heightCm: 170 }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(sexQuestion(view)).toBeTruthy());
    await saveChangedMeasurements({ heightCm: 170, sex: 'male', birthYear: 1980, birthMonth: 3 }, { heightCm: 170 }); // another writer
    await flushRoadmapStore();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await waitFor(() => expect(fullForm(view)).toBe(true), { timeout: 3000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(named('onboarding_step')).toEqual([]);
    expect(named('onboarding_done')).toEqual([]);
  });
});

/** The mirror as the widget writes it with a saved vital: the vitals show as a matrix at mount. */
function seedMatrixMirror() {
  const now = new Date().toISOString();
  localStorage.setItem(MIRROR_KEY, JSON.stringify({
    inputs: {}, previousMeasurements: [{ id: 'm', metricType: 'waist', value: 85, recordedAt: now, createdAt: now }],
  }));
}
/** Every place the weight shows as a field, a saved value or a matrix row. */
const weightPlaces = (view: RenderResult) => Array.from(view.container.querySelectorAll('.collapsed-field-label, .bt-name-label, label[for="weightKg"]'))
  .filter((l) => l.textContent?.trim().startsWith('Weight'));
async function completeRecord(extra: Parameters<typeof saveChangedMeasurements>[0] = {}) {
  await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3, ...extra }, {});
  await addMeasurement('weight', 70, '2026-09-01');
  await flushRoadmapStore();
}

describe('US-62 AC13 review fixes, round 2 (PR 421)', () => {
  it('B1: a complete record whose height is cleared and retyped sends no onboarding events', async () => {
    await completeRecord();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const height = q(view, '#heightCm') as HTMLInputElement;
    type(height, '');
    type(height, '172');
    leave(height);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(named('onboarding_step')).toEqual([]);
    expect(named('onboarding_done')).toEqual([]);
  });

  it('S1: a weight typed beside the height shows there alone once the form opens, the matrix leaving its row out', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    seedMatrixMirror(); // a copy holding a saved vital (another device's, say): the vitals open as a matrix
    const view = await open();
    const weight = q(view, '#weightKg') as HTMLInputElement;
    type(weight, '70.5'); // a decimal: no jump to the email field, so the focus stays (US-62 AC12)
    await waitFor(() => expect(q(view, '.bt-vitals-card')).toBeTruthy());
    expect(q(view, '#weightKg')).toBe(weight);
    expect(weightPlaces(view)).toHaveLength(1);
  });

  it('Codex R1: a year-only record keeps its year field, and focus, while the year is cleared and retyped', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980 }, {});
    await addMeasurement('weight', 70, '2026-09-01');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const year = q(view, '#birthYear') as HTMLInputElement;
    act(() => year.focus());
    fireEvent.change(year, { target: { value: '' } });
    expect(q(view, '#birthYear')).toBe(year);
    expect(document.activeElement).toBe(year);
    fireEvent.change(year, { target: { value: '1981' } });
    expect(q(view, '#birthYear')).toBe(year);
    expect(view.container.querySelector('.prefill-summary')?.textContent).toContain('Born 1981');
  });

  it.each([
    ['supplements', () => saveSupplement('magnesium', 'Magnesium', 200, 'mg')],
    ['documents', () => saveLetter()],
  ] as const)('Codex R3: a record holding only %s opens the whole form', async (_, seed) => {
    await seed();
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(sexQuestion(view)).toBeTruthy(); // the questions pinned above
  });

  it('Codex R4: finishing through the vitals matrix counts the answered step and done', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('ldl', 3.0, '2026-09-01'); // the whole form, the weight in the matrix
    await flushRoadmapStore();
    seedMatrixMirror();
    const view = await open();
    const cell = await waitFor(() => {
      const row = Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row')).find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
      const input = row?.querySelector('.bt-cell-draft input');
      if (!input) throw new Error('no weight draft cell');
      return input as HTMLInputElement;
    });
    type(cell, '70');
    await waitFor(() => expect(named('onboarding_done')).toHaveLength(1));
    expect(named('onboarding_step').map((e) => e.metadata)).toEqual([{ step: 'measurements' }]);
  });

  it('US-62 AC14: with the chat column on screen (1200px and up) there is no floating chat button', async () => {
    await completeRecord();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(chat.muted.at(-1)).toBe(false); // the inline chat is there, unmuted
    expect(document.querySelector('.chat-fab')).toBeNull();
    expect(document.querySelector('.floating-chat-panel')).toBeNull();
  });

  it('Codex R5: the open floating chat stays mounted and goes muted when an answer is cleared', async () => {
    wide = false;
    await completeRecord();
    const view = await open();
    fireEvent.click(await waitFor(() => document.querySelector('.chat-fab') as HTMLElement));
    await waitFor(() => expect(document.querySelector('.floating-chat-panel')).toBeTruthy());
    expect(floating.muted.at(-1)).toBe(false);
    type(q(view, '#heightCm'), '');
    expect(document.querySelector('.floating-chat-panel')).toBeTruthy();
    expect(floating.muted.at(-1)).toBe(true);
  });

  it('N3: an erase starts the tab dot again', async () => {
    phone = true;
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    const view = await open();
    await measurements(view);
    const planTab = view.getByRole('tab', { name: 'My plan' });
    fireEvent.click(planTab); // BMI seen
    fireEvent.click(view.getByRole('tab', { name: 'My data' }));
    expect(planTab.querySelector('.hr-tab-dot')).toBeNull();
    fireEvent.click(view.getByText('Delete All My Data'));
    await waitFor(() => expect(sexQuestion(view)).toBeNull());
    await measurements(view, '165', '60');
    await waitFor(() => expect(planTab.querySelector('.hr-tab-dot')).toBeTruthy());
  });

  it('R7: the vitals matrix weight jumps to the email box only as the last answer', async () => {
    // Sex missing: the weight is not the last answer, so the email box keeps still.
    await saveChangedMeasurements({ heightCm: 170, birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('ldl', 3.0, '2026-09-01');
    await flushRoadmapStore();
    seedMatrixMirror();
    const view = await open();
    const cell = () => {
      const row = Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row')).find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
      return row?.querySelector('.bt-cell-draft input') as HTMLInputElement;
    };
    await waitFor(() => expect(cell()).toBeTruthy());
    type(cell(), '170');
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(q(view, '#guestEmail')).toBeTruthy();
    expect(document.activeElement?.id).not.toBe('guestEmail');
  });

  it('R7: with the other answers in, the matrix weight is the last answer and jumps to the email box', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await addMeasurement('ldl', 3.0, '2026-09-01');
    await flushRoadmapStore();
    seedMatrixMirror();
    const view = await open();
    const cell = await waitFor(() => {
      const row = Array.from(view.container.querySelectorAll('.bt-vitals-card .bt-row')).find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight');
      const input = row?.querySelector('.bt-cell-draft input');
      if (!input) throw new Error('no weight draft cell');
      return input as HTMLInputElement;
    });
    type(cell, '170');
    await waitFor(() => expect(document.activeElement?.id).toBe('guestEmail'));
  });
});

/** A clinic letter on record: a document the Health Records list shows. */
const saveLetter = () => bulkSaveDocuments([{
  documentType: 'clinic_letter', title: 'Clinic letter', documentDate: '2026-09-01', contentMd: 'A letter.', metadata: {}, sourceFileName: 'letter.pdf',
}]);

describe('US-62 AC13 review fixes, round 3 (PR 421)', () => {
  it('1: a chat weight, with the weight beside the height, lands in that field: the BMI matches and no hidden draft', async () => {
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, {});
    await flushRoadmapStore();
    seedMatrixMirror(); // the vitals as a matrix, its weight row hidden
    const view = await open();
    type(q(view, '#weightKg'), '70.5'); // no jump to the email field
    act(() => { (q(view, '#heightCm') as HTMLElement).focus(); }); // the weight left, the focus still in the card (US-62 AC12)
    await waitFor(() => expect(q(view, '.bt-vitals-card')).toBeTruthy());
    act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: 80, unitSystem: 'si', date: null }]));
    await waitFor(() => expect((q(view, '#weightKg') as HTMLInputElement).value).toBe('80'));
    const bmi = Array.from(view.container.querySelectorAll('.stat-card')).find((c) => c.querySelector('.stat-label')?.textContent === 'BMI');
    expect(bmi?.querySelector('.stat-value')?.textContent).toBe('27.7'); // 80 kg at 170 cm
    expect(JSON.parse(localStorage.getItem('health_roadmap_vitals_draft') ?? '{}')?.draft?.values?.weight).toBeUndefined();
    expect(weightPlaces(view)).toHaveLength(1);
  });

  it('2: a whole form a document opened stays open when that document is deleted', async () => {
    await saveLetter();
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    fireEvent.click(view.getByText('Clinic letter'));
    fireEvent.click(view.getByText('Delete Document'));
    fireEvent.click(view.getByText('Confirm Delete'));
    await waitFor(() => expect(view.queryByText('Clinic letter')).toBeNull());
    expect(fullForm(view)).toBe(true);
  });

  it('3: a year-only record opened by a medication keeps its year field while the year is retyped', async () => {
    await saveChangedMeasurements({ heightCm: 170, birthYear: 1980 }, {});
    await saveMedication('statin', 'rosuvastatin', 10, 'mg');
    await flushRoadmapStore();
    const view = await open();
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const year = q(view, '#birthYear') as HTMLInputElement;
    act(() => year.focus());
    fireEvent.change(year, { target: { value: '' } });
    expect(q(view, '#birthYear')).toBe(year);
    expect(document.activeElement).toBe(year);
    fireEvent.change(year, { target: { value: '1981' } });
    expect(q(view, '#birthYear')).toBe(year);
  });

  it('4: About you, collapsed for a complete record, opens when another device clears an answer', async () => {
    await completeRecord();
    const view = await open();
    await waitFor(() => expect(q(view, '.prefill-summary-wrapper.visible')).toBeTruthy());
    await saveChangedMeasurements({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, { heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 });
    await saveChangedMeasurements({ heightCm: undefined }, { heightCm: 170 }); // another writer clears the height
    await flushRoadmapStore();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await waitFor(() => expect(q(view, '.prefill-summary-wrapper.visible')).toBeNull(), { timeout: 3000 });
    expect(named('onboarding_step')).toEqual([]);
  });
});

describe('US-62 AC12 (adversary R5, 2026-11-02): About you rows hold a missing answer open', () => {
  /** The tool with a complete record's About you rows left closed. */
  async function rows() {
    const view = render(<HealthTool />);
    await waitFor(() => expect(q(view, '#about-height')).toBeTruthy());
    return view;
  }
  const editor = (view: RenderResult, key: string) => q(view, `[data-about="${key}"]`) as HTMLElement | null;
  const done = (view: RenderResult, key: string) => fireEvent.click(within(editor(view, key)!).getByRole('button', { name: 'Done' }));

  it('a refused height keeps its editor open through Done; a good one gives the row back', async () => {
    await completeRecord();
    const view = await rows();
    fireEvent.click(q(view, '#about-height')!);
    type(q(view, '#heightCm'), '300');
    expect(view.getByText(/Height must be/)).toBeTruthy();
    done(view, 'height');
    expect(editor(view, 'height')).not.toBeNull(); // still refused: the row cannot close
    expect(q(view, '#about-height')).toBeNull();
    type(q(view, '#heightCm'), '180');
    done(view, 'height');
    expect(editor(view, 'height')).toBeNull();
    expect(q(view, '#about-height')!.textContent).toBe('Height180 cm');
  });

  it('an answer cleared in its editor opens itself and stays open through Done until answered again', async () => {
    await completeRecord();
    const view = await rows();
    fireEvent.click(q(view, '#about-birth')!);
    type(q(view, '#birthYear'), '');
    leave(q(view, '#birthYear'));
    done(view, 'birth');
    await waitFor(() => expect(editor(view, 'birth')).not.toBeNull());
    expect(q(view, '#about-birth')).toBeNull();
    type(q(view, '#birthYear'), '1981');
    leave(q(view, '#birthYear'));
    done(view, 'birth');
    expect(editor(view, 'birth')).toBeNull();
    expect(q(view, '#about-birth')!.textContent).toBe('BirthMarch 1981');
  });

  it('an erase takes About you from rows back to the onboarding boxes', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    await completeRecord();
    const view = await rows();
    expect(q(view, '#heightCm')).toBeNull();
    fireEvent.click(view.getByText('Delete All My Data'));
    await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
    expect(q(view, '.about-row')).toBeNull();
    expect(q(view, '#weightKg')).toBeTruthy(); // the box beside the height again
    expect(fullForm(view)).toBe(false);
  });
});

describe('US-02 AC9: a range error waits while the number is still being typed', () => {
  const shown = (view: RenderResult) => Array.from(view.container.querySelectorAll('.error-message')).map((e) => e.textContent);

  it('"19" on the way to 190 says nothing until the height field is left, and is never written (US-02 AC5), left or not', async () => {
    const view = await open();
    const height = q(view, '#heightCm');
    type(height, '1');
    type(height, '19');
    expect(shown(view)).toEqual([]);
    expect(height?.className).not.toContain('error');
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); // the profile's 500 ms save, the field still focused
    expect((await recordOnDisk()).profile?.heightCm ?? null).toBeNull();
    leave(height);
    expect(shown(view)).toEqual(['Height must be at least 50 cm']);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect((await recordOnDisk()).profile?.heightCm ?? null).toBeNull();
    expect((height as HTMLInputElement).value).toBe('19'); // kept, with its error
  });

  it('a number already wrong says so while typing: too big, or no digit can fix it', async () => {
    const view = await open();
    type(q(view, '#heightCm'), '300');
    expect(shown(view)).toEqual(['Height must be at most 250 cm']);
    type(q(view, '#heightCm'), '190');
    type(q(view, '#weightKg'), '9');
    expect(shown(view)).toEqual([]);
    act(() => { fireEvent.keyDown(q(view, '#weightKg')!, { key: 'Enter' }); });
    expect(shown(view)).toEqual(['Weight must be at least 20 kg']);
  });
});

describe('US-62 AC12: About you goes low once the onboarding is done and its card is left', () => {
  const cards = (view: RenderResult) => Array.from(view.container.querySelectorAll('.health-input-panel > .section-card'));
  const aboutLow = (view: RenderResult) => q(view, '.md-about-you');

  it.each([['desktop', false], ['phone', true]])('on %s: "199" on the way to 1990 moves nothing; leaving the card moves About you, as rows, to the foot', async (_, onPhone) => {
    phone = onPhone;
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    fireEvent.change(q(view, '#birthMonth')!, { target: { value: '5' } });
    const year = q(view, '#birthYear') as HTMLInputElement;
    type(year, '199');
    type(year, '1990'); // all four answers: the whole form opens, About you stays put
    await waitFor(() => expect(fullForm(view)).toBe(true));
    expect(aboutLow(view)).toBeNull();
    expect(q(view, '#birthYear')).toBe(year);
    expect(cards(view)[0].querySelector('#birthYear')).toBe(year);
    act(() => { year.focus(); }); // the stage's reveal may have taken the focus to the month

    leave(year);
    await waitFor(() => expect(aboutLow(view)).toBeTruthy());
    expect(cards(view).at(-1)).toBe(aboutLow(view)); // the column's foot
    expect(Array.from(aboutLow(view)!.querySelectorAll('.about-row-label')).map((l) => l.textContent)).toEqual(['Height', 'Sex', 'Birth', 'Alcohol']);
    expect(aboutLow(view)!.querySelector('h3')?.textContent).toContain('About you');
    expect(weightPlaces(view)).toHaveLength(1); // the weight joins the vitals, shown once
    // The returning layout: the vitals as rows, the grids hidden but mounted.
    const vitals = cards(view)[0];
    await waitFor(() => expect(Array.from(vitals.querySelectorAll('.md-row-label')).map((l) => l.textContent)).toEqual(['Weight', 'Waist', 'Blood Pressure']));
    expect(vitals.querySelector('#waistCm, .collapsed-field-row')).toBeNull();
    expect(vitals.querySelector('.md-table[hidden] .bt-vitals-card')).toBeTruthy();
    fireEvent.click(Array.from(vitals.querySelectorAll('.md-row')).find((r) => r.textContent?.includes('Waist'))!);
    await waitFor(() => expect(within(q(view, '.md-page') as HTMLElement).getByRole('heading', { name: 'Waist' })).toBeTruthy());
  });

  it('the focus going from the birth year into the waist field keeps that field until the vitals card is left', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view);
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const year = q(view, '#birthYear') as HTMLElement;
    act(() => { year.focus(); });
    const waist = q(view, '#waistCm') as HTMLElement;
    act(() => { waist.focus(); }); // Tab: the profile card is left, into the vitals
    await waitFor(() => expect(aboutLow(view)).toBeTruthy());
    expect(q(view, '#waistCm')).toBe(waist);
    expect(document.activeElement).toBe(waist);
    leave(waist);
    await waitFor(() => expect(q(view, '#waistCm')).toBeNull());
    expect(Array.from(cards(view)[0].querySelectorAll('.md-row-label')).map((l) => l.textContent)).toContain('Waist');
  });

  it('a stage short of four moves nothing when the card is left', async () => {
    const view = await open();
    await measurements(view);
    const male = view.getByRole('radio', { name: 'Male' });
    fireEvent.click(male);
    act(() => { male.focus(); });
    act(() => { male.blur(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(aboutLow(view)).toBeNull();
  });

  it('the vitals are their own card, never inside Starting Info or About you', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view);
    await waitFor(() => expect(fullForm(view)).toBe(true));
    const vitalsCard = (q(view, '#waistCm') as HTMLElement).closest('.section-card')!;
    expect(vitalsCard.querySelector('#birthYear, #heightCm')).toBeNull();
    expect(vitalsCard.querySelector('h3')?.textContent).toBe('Vitals');
    act(() => { (q(view, '#birthYear') as HTMLElement).focus(); });
    leave(q(view, '#birthYear'));
    await waitFor(() => expect(aboutLow(view)).toBeTruthy());
    expect(aboutLow(view)!.querySelector('#waistCm, .md-section-title')).toBeNull();
  });
});

describe('US-02 AC5: an out-of-range first-time value stays in its field, its error shown, and is never written', () => {
  const shown = (view: RenderResult) => Array.from(view.container.querySelectorAll('.error-message')).map((e) => e.textContent);

  it('a systolic of 5, left: kept, "Systolic BP must be at least 60 mmHg", no row', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    birth(view);
    await waitFor(() => expect(q(view, '#systolicBp')).toBeTruthy());
    const sys = q(view, '#systolicBp') as HTMLInputElement;
    type(sys, '5');
    leave(sys);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); // the fields' 500 ms save
    expect(sys.value).toBe('5');
    expect(shown(view)).toContain('Systolic BP must be at least 60 mmHg');
    expect((await recordOnDisk()).measurements.filter((m) => m.metricType === 'systolic_bp')).toEqual([]);
  });

  it('a birth year of 1850, left: kept, its error shown, not written', async () => {
    const view = await open();
    await measurements(view);
    fireEvent.click(view.getByRole('radio', { name: 'Male' }));
    fireEvent.change(q(view, '#birthMonth')!, { target: { value: '5' } });
    const year = q(view, '#birthYear') as HTMLInputElement;
    type(year, '1850');
    leave(year);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); // the profile's 500 ms save
    expect(year.value).toBe('1850');
    expect(shown(view)).toContain('Birth year must be after 1900');
    expect((await recordOnDisk()).profile.birthYear ?? null).toBeNull();
  });
});
