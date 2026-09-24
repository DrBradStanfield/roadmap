// @vitest-environment jsdom
/**
 * The feedback of 2026-09-22, replayed as the guest lived it (US-03, US-04,
 * US-21, US-34). "After putting some bloodtests in on the wrong day it became
 * impossible to remove or change the date they are for. It also is impossible
 * to edit a mistyped 'add a blood test' or to at least delete it and enter a
 * new one. When trying to edit things I repeatedly accidentally added new
 * things that also became impossible to edit or remove."
 *
 * The record is append-only: nothing here removes a value. A value reaches it
 * only when the user commits one. Moving a value to another day is a later
 * batch.
 *
 * The whole widget renders over a REAL RoadmapStore on this browser's
 * localStorage, the guest's own backend. Only the network edges and the chat's
 * own UI are stubbed, and one test holds a correction in flight. Every
 * assertion reads the record file itself, through the adapter that stores it,
 * or what the page shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within, act, type RenderResult } from '@testing-library/react';
import {
  formatDisplayValue,
  localDay,
  MemoryAdapter,
  MemoryCloud,
  ROADMAP_FILE_NAME,
  toCanonicalValue,
  type FileLabValue,
  type FileMeasurement,
  type ProposedEdit,
  type RoadmapFile,
} from '@roadmap/health-core';
import { REMOTE_CHANGED_EVENT, RoadmapStore, type CorrectStatus } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement,
  bulkSaveLabValues,
  correctValue,
  flushRoadmapStore,
  initRoadmapStore,
  loadAllHistory,
  saveChangedMeasurements,
} from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY, VITALS_DRAFT_KEY } from '../lib/storage';
import { trackProductEvent } from '../lib/server-api';
import { hidePage, pickDraftDate, press, showPage, typeInto, typeWithoutTap } from '../testing/matrix-gestures';
import { SAME_SLOT, SAVE_ERRORS } from './BloodTestTimeline';

// What the chat is told: the context the page hands the chat column. And how
// the chat proposes an edit to the form.
const chat = vi.hoisted(() => ({
  context: null as Record<string, unknown> | null,
  proposeEdit: null as null | ((edits: ProposedEdit[]) => void),
}));
// What the page does as a lab upload starts, before any file is read, and
// once its values are saved.
const upload = vi.hoisted(() => ({
  onStart: null as null | (() => Promise<void>),
  onComplete: null as null | (() => Promise<void>),
}));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ guestInputs, onProposeEdit }: { guestInputs: Record<string, unknown>; onProposeEdit: (edits: ProposedEdit[]) => void }) => {
    chat.context = guestInputs;
    chat.proposeEdit = onProposeEdit;
    return null;
  },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({
  UploadModal: ({ onStart, onComplete }: { onStart: () => Promise<void>; onComplete: () => Promise<void> }) => {
    upload.onStart = onStart;
    upload.onComplete = onComplete;
    return null;
  },
}));

import { HealthTool } from './HealthTool';

const TODAY = localDay(new Date());
const RIGHT_DAY = '2026-08-15';

/** The guest's record as this browser holds it, after every pending save. */
async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}
const rowsOf = async (metric: string) => (await recordOnDisk()).measurements.filter((m) => m.metricType === metric);
const active = <T extends { status: string }>(rows: T[]) => rows.filter((r) => r.status === 'active');
const day = (r: FileMeasurement | FileLabValue) => r.recordedAt.slice(0, 10);
const activeOn = async (metric: string) => active(await rowsOf(metric)).map((m) => [m.value, day(m)]).sort();

/** A guest who has entered sex and height (and, for stage 3, a weight). */
async function guest({ weight }: { weight?: number } = {}) {
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
  if (weight) await addMeasurement('weight', weight, '2026-09-01');
}

/** The same guest on a second visit, when the vitals show as a matrix. */
async function returningGuest(): Promise<RenderResult> {
  await guest({ weight: 82 });
  return secondVisit();
}
async function secondVisit(): Promise<RenderResult> {
  const first = render(<HealthTool />);
  await waitFor(() => expect(first.container.querySelector('.bt-timeline-title')).toBeTruthy());
  first.unmount();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.bt-vitals-card')).toBeTruthy());
  return view;
}

/** Wide desktop: plan, form and the chat column all on screen. */
function wideDesktop() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
}

/** Time passes, and the promises it settles run. */
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** The store heard another writer (a device, a connector): the page re-reads. */
const remoteChange = () => act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });

/** Type into a first-time vitals field and leave it. Its save runs 500 ms
 *  later; `beforeSave` acts while it waits. */
async function typeAndLeave(field: HTMLInputElement, value: string, beforeSave?: () => void) {
  typeInto(field, value);
  act(() => field.blur());
  beforeSave?.();
  await wait(600);
}
/** A guest at stage 2 who has typed today's weight into its first-time field. */
async function firstWeight(value: string): Promise<RenderResult> {
  await guest();
  const view = render(<HealthTool />);
  await typeAndLeave(await shown<HTMLInputElement>(view.container, '#weightKg'), value);
  await waitFor(async () => expect(await activeOn('weight')).toEqual([[Number(value), TODAY]]));
  return view;
}
/** Today's saved weight, clicked open in its first-time field. */
async function openToday(view: RenderResult): Promise<HTMLInputElement> {
  fireEvent.click(await shown<HTMLElement>(view.container, '.collapsed-field-value'));
  return view.container.querySelector('#weightKg') as HTMLInputElement;
}
/** The store's next correction waits for the call this hands back: a save
 *  caught in flight, so the user can type while it runs. */
function holdNextCorrection(): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const correct = RoadmapStore.prototype.correctValue;
  vi.spyOn(RoadmapStore.prototype, 'correctValue').mockImplementationOnce(function (this: RoadmapStore, ...args) {
    return held.then(() => correct.apply(this, args)) as unknown as CorrectStatus;
  });
  return release;
}

function bloodMatrix(container: HTMLElement): HTMLElement {
  return container.querySelector('.bt-timeline-title')!.closest('.bt-timeline') as HTMLElement;
}
const vitalsMatrix = (container: HTMLElement) => container.querySelector('.bt-vitals-card') as HTMLElement;
function row(scope: Element, label: string): HTMLElement {
  const rows = Array.from(scope.querySelectorAll<HTMLElement>('.bt-row'));
  const found = rows.find((r) => r.querySelector('.bt-name-label')?.textContent === label);
  if (!found) throw new Error(`no row ${label}`);
  return found;
}
const draftInput = (scope: Element, label: string) => row(scope, label).querySelector('.bt-cell-draft input') as HTMLInputElement;
/** A saved column's empty cell for that test. */
const backfillInput = (scope: Element, label: string) => row(scope, label).querySelector('.bt-cell-backfill input') as HTMLInputElement;
/** The element, once the page has rendered it. */
function shown<T extends HTMLElement>(container: HTMLElement, selector: string): Promise<T> {
  return waitFor(() => {
    const el = container.querySelector<T>(selector);
    if (!el) throw new Error(`${selector} is not on the page`);
    return el;
  });
}
/** Click a saved value open, as a person does, and hand back its editor input. */
function openEditor(cellRow: HTMLElement, which: 'first' | 'last' = 'first'): HTMLInputElement {
  const cells = cellRow.querySelectorAll('.bt-cell-clickable');
  fireEvent.click(cells[which === 'first' ? 0 : cells.length - 1]);
  return cellRow.querySelector('.bt-cell-correcting input') as HTMLInputElement;
}
/** A tap on text outside every matrix: nothing there takes the focus. */
function tapOutside(container: HTMLElement) {
  const text = container.querySelector('.alr-title') as HTMLElement;
  fireEvent.pointerDown(text);
  fireEvent.pointerUp(text);
}
/** Save as PDF, pressed as a person presses it. */
function savePdf(view: RenderResult) {
  const pdf = view.getAllByRole('button', { name: /Save as PDF/i })[0];
  press(pdf);
  fireEvent.click(pdf);
}
/** The LDL figure on the plan. */
const ldlTile = (container: HTMLElement) => Array.from(container.querySelectorAll('.stat-card'))
  .find((c) => c.querySelector('.stat-label')?.textContent === 'LDL Cholesterol')?.querySelector('.stat-value')?.textContent;
/** The LDL the chat is told about: its current value and its newest dated point. */
function ldlInChat() {
  const history = (chat.context?.measurementHistory as Record<string, Array<{ value: number }>> | undefined)?.ldl ?? [];
  return [chat.context?.ldlC, history[history.length - 1]?.value];
}
/** A press on a row's unit chip, which switches that test's unit. */
function toggleChip(scope: Element, label: string) {
  const chip = row(scope, label).querySelector('button.bt-unit-chip') as HTMLElement;
  press(chip);
  fireEvent.click(chip);
}
/** The user part-way through a profile edit. The page holds back a re-read
 *  until the edit is saved (US-34 AC4), so it shows an older record than the
 *  store holds. (178.5, not a whole number: a plausible height moves the
 *  focus on to the weight, which would leave the matrix.) */
const editHeight = (container: HTMLElement) =>
  fireEvent.change(container.querySelector('#heightCm') as HTMLInputElement, { target: { value: '178.5' } });
/** A press on the blood-test title: out of the vitals matrix, into the page. */
const leaveVitals = (container: HTMLElement) => press(container.querySelector('.bt-timeline-title') as HTMLElement);
const DAY_MS = 24 * 60 * 60 * 1000;
/** A phone turned across 768 px, which swaps the whole form for another
 *  (useIsMobile). Each call turns it and waits while the form is built again. */
function rotatablePhone() {
  const heard = new Set<{ query: string; listener: (e: { matches: boolean }) => void }>();
  let portrait = false;
  const matches = (query: string) => (query.includes('max-width') ? portrait : !portrait);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return matches(query); },
    media: query,
    addEventListener: (_: string, listener: (e: { matches: boolean }) => void) => heard.add({ query, listener }),
    removeEventListener: (_: string, listener: (e: { matches: boolean }) => void) => {
      for (const h of heard) if (h.listener === listener) heard.delete(h);
    },
  }));
  return async () => {
    act(() => {
      portrait = !portrait;
      for (const h of [...heard]) h.listener({ matches: matches(h.query) });
    });
    await wait(200);
  };
}
/** Save as PDF, and the LDL figure on the page it prints. */
async function printedLdl(view: RenderResult) {
  let printed = '';
  vi.stubGlobal('open', () => ({ document: { write: (html: string) => { printed = html; }, close() {} }, print() {} }));
  savePdf(view);
  await waitFor(() => expect(printed).not.toBe(''));
  return ldlTile(new DOMParser().parseFromString(printed, 'text/html').body);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  wideDesktop();
  Element.prototype.scrollIntoView ??= () => {}; // jsdom has no layout to scroll
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('open', () => null); // Save as PDF's print window
  vi.mocked(trackProductEvent).mockClear();
  chat.context = null;
  chat.proposeEdit = null;
  upload.onStart = null;
  upload.onComplete = null;
});
afterEach(async () => {
  cleanup();
  showPage();
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the 2026-09-22 feedback: blood tests on the wrong day', () => {
  it('US-03 AC5: a value typed before its date is picked lands on the picked date', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    const matrix = bloodMatrix(view.container);

    // The natural order: type the value, then go to fix the date.
    typeInto(draftInput(matrix, 'LDL Cholesterol'), '3.2');
    const dateCell = matrix.querySelector('.bt-header-row .bt-cell-draft-date') as HTMLElement;
    fireEvent.pointerDown(dateCell);
    fireEvent.click(dateCell);
    const dateInput = dateCell.querySelector('input[type="date"]') as HTMLInputElement;
    act(() => dateInput.focus());
    await wait(60_000); // a person choosing a date
    fireEvent.change(dateInput, { target: { value: RIGHT_DAY } });
    act(() => dateInput.blur()); // the picker put away
    expect(await rowsOf('ldl')).toEqual([]);

    press(view.container.querySelector('.alr-add-btn') as HTMLElement); // on to the next thing
    await waitFor(async () => expect(active(await rowsOf('ldl')).map(day)).toEqual([RIGHT_DAY]));
  });

  it('US-04: a correction reaches the plan, which re-reads the record', async () => {
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.9, '2026-01-10');
    await addMeasurement('ldl', 2.1, '2026-08-15'); // the latest, and mistyped
    const view = render(<HealthTool />);
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.1 mmol/L'));

    const editor = openEditor(row(bloodMatrix(view.container), 'LDL Cholesterol'), 'last');
    fireEvent.change(editor, { target: { value: '1.9' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(ldlTile(view.container)).toBe('1.9 mmol/L'));
    expect(active(await rowsOf('ldl')).map((m) => m.value).sort()).toEqual([1.9, 3.9]);
    expect(trackProductEvent).toHaveBeenCalledWith('correction_made');
  });

  // Review of 2026-09-24 (D2): a matrix saving two tests cleared its copy of
  // only the last one in `inputs`, and the copy left behind outranked every
  // later correction of the other, in the plan and in the chat.
  it.each([
    ['a tap outside', (container: HTMLElement) => tapOutside(container)],
    ['Enter', (container: HTMLElement) => fireEvent.keyDown(draftInput(bloodMatrix(container), 'HDL Cholesterol'), { key: 'Enter' })],
  ])('US-04: after two tests saved together (by %s), correcting one reaches the plan and the chat', async (_how, commit) => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    typeInto(draftInput(bloodMatrix(view.container), 'HDL Cholesterol'), '1.4');
    commit(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.2, TODAY]]));
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.2 mmol/L'));

    const editor = openEditor(row(bloodMatrix(view.container), 'LDL Cholesterol'), 'last');
    fireEvent.change(editor, { target: { value: '2.1' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[2.1, TODAY]]));
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.1 mmol/L'));
    expect(ldlInChat()).toEqual([2.1, 2.1]);
  });

  it('US-34: a correction made through a connector reaches the plan and the chat', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    typeInto(draftInput(bloodMatrix(view.container), 'HDL Cholesterol'), '1.4');
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.2, TODAY]]));

    // The connector corrects the value; the store takes it in and the page re-reads.
    const [saved] = (await loadAllHistory()).filter((m) => m.metricType === 'ldl');
    expect(await correctValue(saved.id, 2.1)).toBe('ok');
    remoteChange();

    await waitFor(() => expect(ldlTile(view.container)).toBe('2.1 mmol/L'));
    expect(ldlInChat()).toEqual([2.1, 2.1]);
  });
});

// US-03 AC3: a draft dated onto a saved column and that column's empty cell
// can name one test on one day. That is an error on both cells; neither is
// saved until the user clears one, and the rest of the draft saves.
// (Codex R1, 2026-09-24, found both going to insert; the first fix saved the
// one typed last, a silent pick the review of 2026-09-24 refused.)
describe('US-03 AC3: two cells for one test on one day are an error, never a pick', () => {
  it('in the blood-test matrix', async () => {
    await guest({ weight: 82 });
    await addMeasurement('hdl', 1.4, RIGHT_DAY); // the column's LDL cell is empty
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    const matrix = bloodMatrix(view.container);
    typeInto(backfillInput(matrix, 'LDL Cholesterol'), '3.1');
    pickDraftDate(matrix, RIGHT_DAY);
    typeInto(draftInput(matrix, 'LDL Cholesterol'), '3.4');
    typeInto(draftInput(matrix, 'Triglycerides'), '1.1'); // an empty slot: added
    typeInto(draftInput(matrix, 'HDL Cholesterol'), '1.5'); // a held slot: corrected
    tapOutside(view.container);

    await waitFor(async () => expect(await activeOn('triglycerides')).toEqual([[1.1, RIGHT_DAY]]));
    const hdl = await rowsOf('hdl');
    expect(hdl.map((m) => [m.value, m.status]).sort()).toEqual([[1.4, 'entered-in-error'], [1.5, 'active']]);
    expect(await rowsOf('ldl')).toEqual([]);
    const ldl = row(bloodMatrix(view.container), 'LDL Cholesterol');
    expect(within(ldl).getAllByText(SAME_SLOT)).toHaveLength(2);
    expect(draftInput(bloodMatrix(view.container), 'LDL Cholesterol').value).toBe('3.4');

    typeInto(backfillInput(bloodMatrix(view.container), 'LDL Cholesterol'), ''); // settled: the draft's is right
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.4, RIGHT_DAY]]));
    expect(within(row(bloodMatrix(view.container), 'LDL Cholesterol')).queryByText(SAME_SLOT)).toBeNull();
  });

  // The guest's 2026-09-01 column holds a weight and an empty waist cell.
  it('in the vitals matrix', async () => {
    const view = await returningGuest();
    const vitals = vitalsMatrix(view.container);
    typeInto(backfillInput(vitals, 'Waist Circumference'), '91');
    pickDraftDate(vitals, '2026-09-01');
    typeInto(draftInput(vitals, 'Waist Circumference'), '90');
    press(view.container.querySelector('.bt-timeline-title') as HTMLElement); // on to the blood tests
    await wait(1000);
    expect(await rowsOf('waist')).toEqual([]);
    expect(within(row(vitalsMatrix(view.container), 'Waist Circumference')).getAllByText(SAME_SLOT)).toHaveLength(2);

    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), ''); // the column's is right
    press(view.container.querySelector('.bt-timeline-title') as HTMLElement);
    await waitFor(async () => expect(await activeOn('waist')).toEqual([[91, '2026-09-01']]));
  });
});

describe('the 2026-09-22 feedback: a mistyped "add a blood test"', () => {
  async function addLab(wrap: HTMLElement, { name, value, unit }: { name: string; value: string; unit?: string }) {
    const add = within(wrap).queryByRole('button', { name: /add a blood test/i });
    if (add) fireEvent.click(add);
    const test = within(wrap).getByLabelText('Test') as HTMLSelectElement;
    const catalogued = Array.from(test.options).find((o) => o.textContent === name);
    if (catalogued) {
      fireEvent.change(test, { target: { value: catalogued.value } });
    } else {
      fireEvent.change(test, { target: { value: 'custom' } });
      fireEvent.change(within(wrap).getByLabelText('Test name'), { target: { value: name } });
      fireEvent.change(within(wrap).getByLabelText('Unit'), { target: { value: unit } });
    }
    fireEvent.change(within(wrap).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(wrap).getByRole('button', { name: /^save$/i }));
  }
  const labRows = async (key: string) => (await recordOnDisk()).labValues.filter((l) => l.metricName.toLowerCase() === key);

  it('US-21 AC5: a mistyped value is corrected in place: a correction, never a second row', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    const wrap = await shown<HTMLElement>(view.container, '.alr-wrap');

    await addLab(wrap, { name: 'Feritin', value: '45', unit: 'ug/L' });
    fireEvent.click(await within(wrap).findByRole('button', { name: /Other tests/ }));

    const editor = openEditor(row(wrap.querySelector('.alr-matrix') as HTMLElement, 'Feritin'));
    fireEvent.change(editor, { target: { value: '54' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(async () => expect(active(await labRows('feritin')).map((l) => l.value)).toEqual([54]));
    const feritin = await labRows('feritin'); // rows sit in id order, not typing order
    const typo = feritin.find((l) => l.value === 45)!;
    const fixed = feritin.find((l) => l.value === 54)!;
    expect(typo).toMatchObject({ value: 45, status: 'entered-in-error' });
    expect(fixed).toMatchObject({ value: 54, status: 'active', correctsId: typo.id, recordedAt: typo.recordedAt, source: 'manual_correction' });
  });

  // Codex R2 (2026-09-24): the editor saves 150 ms after a click-away, and
  // closing the group unmounted it first, taking the correction with it.
  it('US-21 AC5: a correction clicked away onto its group\'s header, which closes the group, is written', async () => {
    await guest({ weight: 82 });
    await bulkSaveLabValues([{ metricName: 'Feritin', value: 45, unit: 'ug/L', recordedAt: `${TODAY}T00:00:00.000Z`, source: 'manual' }]);
    const view = render(<HealthTool />);
    const wrap = await shown<HTMLElement>(view.container, '.alr-wrap');
    const header = await within(wrap).findByRole('button', { name: /Other tests/ });
    fireEvent.click(header);

    const editor = openEditor(row(wrap.querySelector('.alr-matrix') as HTMLElement, 'Feritin'));
    fireEvent.change(editor, { target: { value: '54' } });
    act(() => header.focus()); // the press on the header takes the focus: the editor blurs
    fireEvent.click(header); // and the group closes at once

    await waitFor(async () => expect(active(await labRows('feritin')).map((l) => l.value)).toEqual([54]));
    fireEvent.click(header);
    expect(within(wrap.querySelector('.alr-matrix') as HTMLElement).getByText('54')).toBeTruthy();
  });

  it('US-21 AC13: the same test twice on one day offers Replace, and Replace is a correction', async () => {
    await guest({ weight: 82 });
    await bulkSaveLabValues([{ metricName: 'ferritin', value: 45, unit: 'µg/L', recordedAt: `${TODAY}T00:00:00.000Z`, source: 'manual' }]);
    const view = render(<HealthTool />);
    const wrap = await shown<HTMLElement>(view.container, '.alr-wrap');

    await addLab(wrap, { name: 'Ferritin', value: '54' });
    const replace = await within(wrap).findByRole('button', { name: 'Replace 45 µg/L with 54' });
    fireEvent.click(replace);

    await waitFor(async () => expect(active(await labRows('ferritin')).map((l) => l.value)).toEqual([54]));
    const ferritin = await labRows('ferritin');
    const old = ferritin.find((l) => l.value === 45)!;
    const replacement = ferritin.find((l) => l.value === 54)!;
    expect(old.status).toBe('entered-in-error');
    expect(replacement).toMatchObject({ correctsId: old.id, recordedAt: old.recordedAt, source: 'manual_correction' });
    expect(trackProductEvent).toHaveBeenCalledWith('correction_made');
  });
});

describe('the 2026-09-22 feedback: edits that added new things instead', () => {
  it('US-03 AC3: a same-day fix to a weight replaces it, says so, and an unchanged value writes nothing', async () => {
    const view = await firstWeight('82');

    // The user spots the typo and clicks the value to fix it.
    const again = await openToday(view);
    expect(view.getByText('Replaces 82 kg')).toBeTruthy();
    await typeAndLeave(again, '84');

    await waitFor(async () => expect(active(await rowsOf('weight')).map((m) => m.value)).toEqual([84]));
    const both = await rowsOf('weight');
    const first = both.find((m) => m.value === 82)!;
    const fix = both.find((m) => m.value === 84)!;
    expect(first.status).toBe('entered-in-error');
    expect(fix).toMatchObject({ correctsId: first.id, recordedAt: first.recordedAt, source: 'manual_correction' });

    // The save closed the field. The same number again is not a change: the
    // field closes as after any save, and nothing is written.
    const same = await openToday(view);
    expect(view.getByText('Replaces 84 kg')).toBeTruthy();
    await typeAndLeave(same, '84');
    await waitFor(() => expect(view.container.querySelector('#weightKg')).toBeNull());
    expect(await rowsOf('weight')).toHaveLength(2);
  });

  // Codex R2 (2026-09-25, round 7): the first-time fields asked "changes
  // nothing" in the unit on screen at the save, not the unit the number was
  // typed in. Round 5 fixed only the vitals matrix.
  it('US-03 AC3: in the first-time fields, today\'s weight re-entered as shown in lb, then switched back to kg before the save, writes nothing; a new number is a correction, exactly', async () => {
    const view = await firstWeight('84');

    // Open today's weight, switch it to lb, type, and switch back to kg while
    // the save still waits.
    const unitPill = () => view.container.querySelector('label[for="weightKg"] .unit-toggle-pill') as HTMLElement;
    async function typeInLbThenSwitchBack(typed: string) {
      const field = await openToday(view);
      fireEvent.click(unitPill()); // kg → lb
      expect(view.getByText('Replaces 185 lbs')).toBeTruthy();
      await typeAndLeave(field, typed, () => fireEvent.click(unitPill())); // lb → kg
      await waitFor(() => expect(view.container.querySelector('#weightKg')).toBeNull()); // the save closed the field
    }

    await typeInLbThenSwitchBack(formatDisplayValue('weight', 84, 'conventional')); // 185, as shown
    expect((await rowsOf('weight')).map((m) => [m.value, m.status])).toEqual([[84, 'active']]);

    await typeInLbThenSwitchBack('190');
    expect(await activeOn('weight')).toEqual([[toCanonicalValue('weight', 190, 'conventional'), TODAY]]);
  });

  // Round 7 review: the chat fills a first-time field from the unit the user
  // stated, and the field kept the unit on screen instead.
  it('US-03 AC3: in the first-time fields, the chat\'s 185 lb over today\'s 84 kg, shown in kg, writes nothing', async () => {
    const view = await firstWeight('84');

    act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: 185, unitSystem: 'conventional', date: null }]));
    await waitFor(() => expect(chat.context?.weightKg).toBe(toCanonicalValue('weight', 185, 'conventional')));
    savePdf(view); // saves what the fields hold
    await wait(1500);
    expect((await rowsOf('weight')).map((m) => [m.value, m.status])).toEqual([[84, 'active']]);
  });

  // Round 7: a blood pressure has no unit to keep; mmHg is mmHg in both.
  it('US-03 AC3: in the first-time fields, a blood pressure saves as a pair, and the same pair typed again writes nothing across a unit switch', async () => {
    await guest(); // stage 2: the first-time fields
    const view = render(<HealthTool />);
    async function typePair(sys: string, dia: string) {
      const systolic = await shown<HTMLInputElement>(view.container, '#systolicBp');
      fireEvent.change(systolic, { target: { value: sys } });
      fireEvent.blur(systolic);
      const diastolic = view.container.querySelector('#diastolicBp') as HTMLInputElement;
      fireEvent.change(diastolic, { target: { value: dia } });
      fireEvent.blur(diastolic); // the two blurs make one save
    }
    const bpRows = async () => [...await rowsOf('systolic_bp'), ...await rowsOf('diastolic_bp')].map((m) => [m.value, m.status, day(m)]);

    await typePair('120', '80');
    await wait(600);
    await waitFor(async () => expect(await bpRows()).toEqual([[120, 'active', TODAY], [80, 'active', TODAY]]));

    fireEvent.click(await shown<HTMLElement>(view.container, '.collapsed-field-value')); // open today's 120/80
    await typePair('120', '80');
    fireEvent.click(view.getByRole('button', { name: /Switch units/ })); // to US units, before the save runs
    await wait(600);
    await waitFor(() => expect(view.container.querySelector('#systolicBp')).toBeNull()); // the save closed the pair
    expect(await bpRows()).toEqual([[120, 'active', TODAY], [80, 'active', TODAY]]);
  });

  // Cleanup review of 2026-09-25: a save took each field it saved out of the
  // form by name, so a number typed there while the save ran went with it.
  it('US-03 AC3: a weight typed into its first-time field while that field\'s save runs stays in the form, and is saved next', async () => {
    const view = await firstWeight('82');
    const field = await openToday(view);
    const release = holdNextCorrection();
    await typeAndLeave(field, '84'); // its save starts, and holds as it writes
    expect(view.getByText('Saving…')).toBeTruthy();
    typeInto(field, '85'); // back in the field while the save runs
    release();
    await waitFor(() => expect(view.queryByText('Saving…')).toBeNull());
    expect(await activeOn('weight')).toEqual([[84, TODAY]]);
    expect(chat.context?.weightKg).toBe(85);
    expect((view.container.querySelector('#weightKg') as HTMLInputElement).value).toBe('85');

    act(() => field.blur()); // leaving saves it
    await wait(600);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[85, TODAY]]));
  });

  it('US-34 AC4: a change arriving while a weight is being typed keeps the typed weight', async () => {
    await guest();
    const view = render(<HealthTool />);
    const weight = await shown<HTMLInputElement>(view.container, '#weightKg');
    typeInto(weight, '82');

    // The record changed under the page (the demographics form is clean).
    remoteChange();
    await wait(50);
    fireEvent.blur(weight);
    await wait(600);

    await waitFor(async () => expect(active(await rowsOf('weight')).map((m) => m.value)).toEqual([82]));
  });

  // The reload keeps only the field being typed in. A field the user has
  // left waits 500 ms for its save; a change arriving in that time must not
  // take the value with it.
  it('US-34 AC4: a weight the user left, its save still waiting when a change arrives, is saved', async () => {
    await guest();
    const view = render(<HealthTool />);
    const weight = await shown<HTMLInputElement>(view.container, '#weightKg');
    typeInto(weight, '82');
    act(() => weight.blur());
    remoteChange();
    await wait(600);

    await waitFor(async () => expect(active(await rowsOf('weight')).map((m) => m.value)).toEqual([82]));
  });
});

// Cleanup review of 2026-09-25: each edit in one chat reply spread the same
// copy of the form, so a reply carrying two first-time field edits kept only
// the last.
describe('US-16 AC1: the chat fills the first-time fields', () => {
  it.each([
    ['a blood pressure ("120/80")', { systolicBp: 120, diastolicBp: 80 }, { systolic_bp: 120, diastolic_bp: 80 }],
    ['a weight and a waist', { weightKg: 84, waistCm: 90 }, { weight: 84, waist: 90 }],
  ])('one reply carrying %s leaves both in the form, and a save saves both', async (_what, fields, saved) => {
    await guest(); // stage 2: the first-time fields
    const view = render(<HealthTool />);
    await shown(view.container, '#weightKg');
    act(() => chat.proposeEdit!(Object.entries(fields).map(([field, displayValue]) =>
      ({ kind: 'field', field, displayValue, unitSystem: 'si', date: null }) as ProposedEdit)));
    await waitFor(() => expect(Object.keys(fields).map((f) => chat.context?.[f])).toEqual(Object.values(fields)));

    savePdf(view); // saves what the fields hold
    await waitFor(async () => {
      for (const [metric, value] of Object.entries(saved)) expect(await activeOn(metric)).toEqual([[value, TODAY]]);
    });
  });
});

describe('US-03 AC5: a matrix commits what is typed when you leave it; the page hiding keeps the draft', () => {
  it('the vitals matrix commits when you leave it, never while you move between its cells', async () => {
    const view = await returningGuest();
    const vitals = vitalsMatrix(view.container);
    typeInto(draftInput(vitals, 'Waist Circumference'), '90');
    const bp = row(vitals, 'Blood Pressure');
    typeInto(bp.querySelector('.bt-cell-draft input[aria-label="Systolic blood pressure"]') as HTMLInputElement, '120');
    typeInto(bp.querySelector('.bt-cell-draft input[aria-label="Diastolic blood pressure"]') as HTMLInputElement, '80');
    await wait(5000);
    expect([...await rowsOf('waist'), ...await rowsOf('systolic_bp')]).toEqual([]);

    press(view.container.querySelector('.bt-timeline-title') as HTMLElement); // on to the blood tests
    await waitFor(async () => expect(active(await rowsOf('waist')).map((m) => m.value)).toEqual([90]));
    expect(active(await rowsOf('systolic_bp')).map((m) => m.value)).toEqual([120]);
    expect(active(await rowsOf('diastolic_bp')).map((m) => m.value)).toEqual([80]);
  });

  // Review of 2026-09-24 (D3): a hidden page used to save both matrices, and
  // a draft was cleared as soon as its save began. On a cloud backend the
  // upload of a page put away never finished, and the typed values were gone
  // from the device and from the cloud.
  it('the page hiding mid-entry writes nothing; the draft is there when it comes back, and after a reload', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), '90');
    hidePage();
    await wait(5000);
    expect(await rowsOf('waist')).toEqual([]);
    showPage();
    expect(draftInput(vitalsMatrix(view.container), 'Waist Circumference').value).toBe('90');

    view.unmount(); // the phone had put the page away for good: it loads again
    const again = render(<HealthTool />);
    await shown(again.container, '.bt-vitals-card');
    expect(draftInput(vitalsMatrix(again.container), 'Waist Circumference').value).toBe('90');

    // The same for the blood tests, the waist still waiting in its draft.
    typeInto(draftInput(bloodMatrix(again.container), 'LDL Cholesterol'), '3.2');
    hidePage();
    await wait(5000);
    showPage();
    again.unmount();
    const third = render(<HealthTool />);
    await shown(third.container, '.bt-vitals-card');
    expect(draftInput(bloodMatrix(third.container), 'LDL Cholesterol').value).toBe('3.2');
    expect(draftInput(vitalsMatrix(third.container), 'Waist Circumference').value).toBe('90');
    expect([...await rowsOf('waist'), ...await rowsOf('ldl')]).toEqual([]);
  });

  it('on a cloud backend whose upload never finishes, the page hiding keeps the typed value on the device and writes nothing', async () => {
    class HangingAdapter extends MemoryAdapter {
      hang = false;
      writes = 0;
      async write(...args: Parameters<MemoryAdapter['write']>) {
        if (!this.hang) return super.write(...args);
        this.writes++;
        return new Promise<never>(() => {}); // a page put away: the upload never lands
      }
    }
    const cloud = new MemoryCloud();
    const adapter = new HangingAdapter(cloud);
    await adapter.connect();
    await initRoadmapStore(adapter);
    await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');

    adapter.hang = true;
    hidePage();
    await wait(5000);
    expect((await loadAllHistory()).filter((m) => m.metricType === 'ldl')).toEqual([]);
    expect(adapter.writes).toBe(0);
    const inCloud = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(inCloud.measurements.filter((m) => m.metricType === 'ldl')).toEqual([]);
    adapter.hang = false;

    view.unmount(); // the page comes back from the device
    showPage();
    const again = render(<HealthTool />);
    await shown(again.container, '.bt-timeline-title');
    expect(draftInput(bloodMatrix(again.container), 'LDL Cholesterol').value).toBe('3.2');
  });

  // The draft outlives the page, so a saved column's empty cell can be filled
  // elsewhere while what was typed into it waits. That cell is gone from the
  // screen: what was typed never commits, and never corrects the new value.
  it('a value typed into a cell another device filled since is never committed over it', async () => {
    const view = await returningGuest(); // 2026-09-01 holds a weight; its waist cell is empty
    typeInto(backfillInput(vitalsMatrix(view.container), 'Waist Circumference'), '91');
    hidePage();
    await wait(1000);
    showPage();
    await addMeasurement('waist', 88, '2026-09-01'); // a connector, meanwhile
    remoteChange();
    await waitFor(() => expect(backfillInput(vitalsMatrix(view.container), 'Waist Circumference')).toBeNull());

    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84');
    press(view.container.querySelector('.bt-timeline-title') as HTMLElement); // leave
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [84, TODAY]]));
    expect(await rowsOf('waist')).toMatchObject([{ value: 88, status: 'active' }]);
  });

  // Review of 2026-09-24: iOS keeps the focus in a cell after a tap on blank
  // space. A second value typed there, with no new tap, still commits on the
  // next leave.
  it('after a commit, a value typed into the cell that kept the focus commits on the next leave', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    const ldl = draftInput(bloodMatrix(view.container), 'LDL Cholesterol');
    typeInto(ldl, '3.2');
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.2, TODAY]]));

    expect(document.activeElement).toBe(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'));
    typeWithoutTap(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.5');
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.5, TODAY]]));
  });

  // Review of 2026-09-24: the vitals draft rewrote what was typed to the
  // display's precision, and saved the rounded number.
  it('the vitals draft keeps what was typed, and saves that number', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), '90.4');
    await wait(50);
    expect(draftInput(vitalsMatrix(view.container), 'Waist Circumference').value).toBe('90.4');
    press(view.container.querySelector('.bt-timeline-title') as HTMLElement);
    await waitFor(async () => expect(await activeOn('waist')).toEqual([[90.4, TODAY]]));
  });

  // Review of 2026-09-24 (round 3): a unit switch rewrote only the draft
  // column, rounded to the display, so 84 kg saved as 83.9 after a trip to
  // lb and back, and a backfill kept its number under the new unit: 80 kg
  // became 80 lb. A switch re-expresses the same quantity in every typed
  // cell, and the commit is the quantity typed, never the rounded display.
  it('a unit switch re-expresses a typed weight: the number meant is the number saved', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84');
    toggleChip(vitalsMatrix(view.container), 'Weight'); // kg → lb
    await wait(50);
    expect(draftInput(vitalsMatrix(view.container), 'Weight').value).toBe('185');
    leaveVitals(view.container);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [84, TODAY]]));
  });

  it.each([
    ['Waist Circumference', 'waist', '90.4', 90.4],
    ['Weight', 'weight', '84', 84],
  ])('%s typed, switched to the other unit and back, reads as typed and saves exactly that', async (label, metric, typed, saved) => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), label), typed);
    toggleChip(vitalsMatrix(view.container), label);
    await wait(50);
    toggleChip(vitalsMatrix(view.container), label);
    await wait(50);
    expect(draftInput(vitalsMatrix(view.container), label).value).toBe(typed);
    leaveVitals(view.container);
    await waitFor(async () => expect((await activeOn(metric)).filter(([, d]) => d === TODAY)).toEqual([[saved, TODAY]]));
  });

  it('a backfill typed in kg and switched to lb is saved as the kilograms typed', async () => {
    await guest({ weight: 82 });
    await addMeasurement('waist', 90, '2026-08-20'); // the 20 Aug column has an empty weight cell
    const view = await secondVisit();
    typeInto(backfillInput(vitalsMatrix(view.container), 'Weight'), '80');
    toggleChip(vitalsMatrix(view.container), 'Weight'); // kg → lb
    await wait(50);
    expect(backfillInput(vitalsMatrix(view.container), 'Weight').value).toBe('176');
    leaveVitals(view.container);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[80, '2026-08-20'], [82, '2026-09-01']]));
  });

  // Codex R2 (2026-09-24, round 5): "changes nothing" was asked in the unit
  // on screen at the commit, not the unit the number was typed in.
  it('US-03 AC3: today\'s weight re-entered as shown in lb, then switched back to kg, writes nothing; a new number is a correction, exactly', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84');
    leaveVitals(view.container);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [84, TODAY]]));

    toggleChip(vitalsMatrix(view.container), 'Weight'); // kg → lb: today's 84 kg reads 185
    await wait(50);
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), formatDisplayValue('weight', 84, 'conventional'));
    toggleChip(vitalsMatrix(view.container), 'Weight'); // back to kg, then leave
    await wait(50);
    leaveVitals(view.container);
    await wait(1000);
    expect(await rowsOf('weight')).toHaveLength(2);

    toggleChip(vitalsMatrix(view.container), 'Weight'); // lb
    await wait(50);
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '190');
    toggleChip(vitalsMatrix(view.container), 'Weight'); // kg
    await wait(50);
    leaveVitals(view.container);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [toCanonicalValue('weight', 190, 'conventional'), TODAY]]));
  });

  // Cleanup review of 2026-09-25 (the rest of Codex R2): the chat's pre-fill
  // typed its number into the matrix converted to the cell's unit and rounded
  // to the display, and the commit saved the rounded number.
  it('US-03 AC3: the chat\'s 185 lb over today\'s 84 kg, in the vitals matrix shown in kg, writes nothing; a new number is a correction, exactly', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84');
    leaveVitals(view.container);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [84, TODAY]]));

    async function chatSaysLb(lb: number) {
      act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: lb, unitSystem: 'conventional', date: null }]));
      const weight = draftInput(vitalsMatrix(view.container), 'Weight');
      expect(weight.value).toBe(formatDisplayValue('weight', toCanonicalValue('weight', lb, 'conventional'), 'si')); // shown in kg
      press(weight); // the user looks it over, then leaves
      leaveVitals(view.container);
      await wait(1000);
    }
    await chatSaysLb(185);
    expect(await rowsOf('weight')).toHaveLength(2);

    await chatSaysLb(190);
    await waitFor(async () => expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [toCanonicalValue('weight', 190, 'conventional'), TODAY]]));
  });

  // Codex R2 (2026-09-24): an upload flushed the blood-test draft only, and a
  // vitals draft restored from the device waited through the extraction.
  it('starting a lab upload commits a vitals draft restored from the device, before any file is read', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), '90');
    hidePage();
    await wait(500);
    showPage();
    view.unmount();
    const again = render(<HealthTool />);
    await shown(again.container, '.bt-vitals-card');
    expect(await rowsOf('waist')).toEqual([]);

    await act(async () => { await upload.onStart!(); });
    expect(await activeOn('waist')).toEqual([[90, TODAY]]);
  });
});

// Review of 2026-09-24 (D1): after a vitals save, the copies of the saved
// values in `inputs` were not all cleared, and Save as PDF saved what was left
// under TODAY through the field path, whatever day the draft was dated.
describe('leftover form state never writes a value', () => {
  it('correct today\'s waist to 92, then Save as PDF: 92 stays', async () => {
    const view = await returningGuest();
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84');
    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), '90');
    press(view.container.querySelector('.bt-timeline-title') as HTMLElement); // leave: saved under today
    await waitFor(async () => expect(await activeOn('waist')).toEqual([[90, TODAY]]));

    const editor = openEditor(row(vitalsMatrix(view.container), 'Waist Circumference'), 'last');
    fireEvent.change(editor, { target: { value: '92' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(async () => expect(await activeOn('waist')).toEqual([[92, TODAY]]));

    savePdf(view);
    await wait(1500);
    expect(await activeOn('waist')).toEqual([[92, TODAY]]);
    expect(await activeOn('weight')).toEqual([[82, '2026-09-01'], [84, TODAY]]);
  });

  it('a vitals draft dated 20 Aug is saved on 20 Aug only; its invalid cell stays; Save as PDF writes nothing', async () => {
    await guest({ weight: 82 });
    await addMeasurement('waist', 90, TODAY);
    const view = await secondVisit();
    pickDraftDate(vitalsMatrix(view.container), '2026-08-20');
    typeInto(draftInput(vitalsMatrix(view.container), 'Waist Circumference'), '95');
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '1'); // on its way to a number; not one yet

    savePdf(view); // the press leaves the matrix: its valid cells are saved
    await waitFor(async () => expect(await activeOn('waist')).toEqual([[90, TODAY], [95, '2026-08-20']]));
    const weight = draftInput(vitalsMatrix(view.container), 'Weight');
    expect(weight.value).toBe('1');
    expect(weight.getAttribute('aria-invalid')).toBe('true');

    savePdf(view); // much later
    await wait(1500);
    expect(await activeOn('waist')).toEqual([[90, TODAY], [95, '2026-08-20']]);
    expect((await rowsOf('waist')).every((m) => m.status === 'active')).toBe(true);
    expect(await activeOn('weight')).toEqual([[82, '2026-09-01']]);
  });
});

// Review of 2026-09-24, round 3, and Codex R1: a value on screen can change
// under the user, another device or a connector writing to the same record.
describe('another writer changes a value the user is working on', () => {
  const CHANGED = 'This value changed on another device, so your edit was not saved.';

  it('US-04: an editor left open on a value corrected elsewhere writes nothing on the click away, and says so', async () => {
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.0, RIGHT_DAY);
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    const editor = openEditor(row(bloodMatrix(view.container), 'LDL Cholesterol'));
    expect(editor.value).toBe('3.0');

    const [saved] = (await loadAllHistory()).filter((m) => m.metricType === 'ldl');
    expect(await correctValue(saved.id, 2.5)).toBe('ok'); // a connector, meanwhile
    remoteChange();
    await wait(500);
    act(() => editor.blur()); // the user clicks away
    await wait(500);

    expect(await activeOn('ldl')).toEqual([[2.5, RIGHT_DAY]]);
    const ldl = row(bloodMatrix(view.container), 'LDL Cholesterol');
    expect(ldl.querySelector('.bt-cell-correcting')).toBeNull();
    expect(within(ldl).getByText(CHANGED)).toBeTruthy();
  });

  it('US-21 AC5: a lab value typed into an editor while another device corrects it is not saved over the correction', async () => {
    await guest({ weight: 82 });
    await bulkSaveLabValues([{ metricName: 'ferritin', value: 45, unit: 'µg/L', recordedAt: `${RIGHT_DAY}T00:00:00.000Z`, source: 'manual' }]);
    const view = render(<HealthTool />);
    const wrap = await shown<HTMLElement>(view.container, '.alr-wrap');
    fireEvent.click(await within(wrap).findByRole('button', { name: /Vitamins/ }));
    const editor = openEditor(row(wrap.querySelector('.alr-matrix') as HTMLElement, 'Ferritin'));
    fireEvent.change(editor, { target: { value: '50' } });

    const held = (await recordOnDisk()).labValues.find((l) => l.metricName === 'ferritin')!;
    expect(await correctValue(held.id, 60)).toBe('ok'); // another device, meanwhile
    remoteChange();
    await wait(500);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await wait(500);

    const ferritin = (await recordOnDisk()).labValues.filter((l) => l.metricName === 'ferritin');
    expect(active(ferritin).map((l) => l.value)).toEqual([60]);
    expect(ferritin).toHaveLength(2);
    expect(within(wrap).getByText(CHANGED)).toBeTruthy();
  });

  it('US-03 AC2: a New value whose day another writer filled after it was typed is an error, never a correction', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    hidePage(); // the phone put the page away: the draft waits on the device
    await wait(1000);
    showPage();
    await addMeasurement('ldl', 3.0, `${TODAY}T00:00:00.000Z`); // a connector, meanwhile
    remoteChange();
    await waitFor(() => expect(within(row(bloodMatrix(view.container), 'LDL Cholesterol')).getByText(SAME_SLOT)).toBeTruthy());

    typeInto(draftInput(bloodMatrix(view.container), 'HDL Cholesterol'), '1.4');
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('hdl')).toEqual([[1.4, TODAY]]));
    expect((await rowsOf('ldl')).map((m) => [m.value, m.status])).toEqual([[3, 'active']]);
    expect(draftInput(bloodMatrix(view.container), 'LDL Cholesterol').value).toBe('3.2');

    // Typed again, it still names the empty slot it was typed against: the
    // record refuses it, however often it is typed (round 5).
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.3');
    tapOutside(view.container);
    await wait(1000);
    expect((await rowsOf('ldl')).map((m) => [m.value, m.status])).toEqual([[3, 'active']]);
    expect(within(row(bloodMatrix(view.container), 'LDL Cholesterol')).getByText(SAME_SLOT)).toBeTruthy();

    // Emptied, then typed with 3.0 on screen: the user's correction of it.
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.3');
    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.3, TODAY]]));
  });

  // Codex R2 (2026-09-24, round 4), and round 5: a blood pressure is one
  // reading. A column holding half of one shows that half, so no pair is
  // typed over a value the user cannot see. A pair typed into the column's
  // empty cell before the half arrived leaves the screen with the cell, and
  // is never written.
  it.each([
    ['its systolic, after both halves', 'systolic_bp', 130, ['Systolic', 'Diastolic'], '130/—'],
    ['its diastolic, after both halves', 'diastolic_bp', 85, ['Systolic', 'Diastolic'], '—/85'],
    ['its diastolic, between the two halves', 'diastolic_bp', 85, ['Systolic'], '—/85'],
  ])('US-03 AC2: a BP typed into an empty column cell, %s filled for that day elsewhere: the column shows that half, and leaving writes nothing', async (_when, metric, value, typed, half) => {
    const view = await returningGuest(); // 1 Sep holds a weight; its BP cell is empty
    const bp = () => row(vitalsMatrix(view.container), 'Blood Pressure');
    for (const which of typed) {
      typeInto(bp().querySelector(`.bt-cell-backfill input[aria-label="${which} blood pressure"]`) as HTMLInputElement, which === 'Systolic' ? '120' : '80');
    }
    hidePage(); // the phone put the page away: the draft waits on the device
    await wait(300);
    showPage();
    await addMeasurement(metric, value, '2026-09-01T00:00:00.000Z'); // a connector, meanwhile
    remoteChange();
    await waitFor(() => expect(within(bp()).getByText(half)).toBeTruthy());
    expect(bp().querySelector('.bt-cell-backfill input')).toBeNull();

    leaveVitals(view.container);
    await wait(1000);
    expect(await rowsOf(metric)).toMatchObject([{ value, status: 'active' }]);
    expect(await rowsOf(metric === 'systolic_bp' ? 'diastolic_bp' : 'systolic_bp')).toEqual([]);
  });

  // Codex R1 (2026-09-24, round 5): the checks above read the record as the
  // page shows it, and the page can be behind the store: a remote change is
  // held back while the profile is being edited. Every write names the row
  // it expects to replace, and the store's own rows decide, as it lands.
  it('US-03 AC2: a New value whose empty slot another writer filled while the page could not show it is refused as it is written', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    const ldl = () => draftInput(bloodMatrix(view.container), 'LDL Cholesterol');
    typeInto(ldl(), '3.2');
    editHeight(view.container);
    await addMeasurement('ldl', 3.0, `${TODAY}T00:00:00.000Z`); // a connector, meanwhile
    remoteChange();
    expect(row(bloodMatrix(view.container), 'LDL Cholesterol').querySelector('.bt-cell-clickable')).toBeNull(); // not on the page

    fireEvent.keyDown(ldl(), { key: 'Enter' });
    await wait(1000);
    expect((await rowsOf('ldl')).map((m) => [m.value, m.status])).toEqual([[3, 'active']]);
    expect(ldl().value).toBe('3.2');
    expect(within(row(bloodMatrix(view.container), 'LDL Cholesterol')).getByText(SAME_SLOT)).toBeTruthy();
    expect(ldlTile(view.container)).toBe('3.0 mmol/L');
  });

  it('US-03 AC2: a value emptied and typed again while the page shows an older record names the row the page shows, and is refused', async () => {
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.0, `${TODAY}T00:00:00.000Z`);
    const view = render(<HealthTool />);
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.0 mmol/L'));
    const ldl = () => draftInput(bloodMatrix(view.container), 'LDL Cholesterol');
    typeInto(ldl(), '3.2');
    editHeight(view.container);
    const [shownRow] = (await loadAllHistory()).filter((m) => m.metricType === 'ldl');
    expect(await correctValue(shownRow.id, 2.8)).toBe('ok'); // a connector, meanwhile
    remoteChange();
    typeInto(ldl(), '');
    typeInto(ldl(), '3.4'); // the page still shows 3.0

    fireEvent.keyDown(ldl(), { key: 'Enter' });
    await wait(1000);
    expect(await activeOn('ldl')).toEqual([[2.8, TODAY]]);
    expect(ldl().value).toBe('3.4');
  });

  it('US-03 AC2: a blood pressure whose half another writer filled while the page could not show it is refused as a pair', async () => {
    const view = await returningGuest();
    const bp = () => row(vitalsMatrix(view.container), 'Blood Pressure');
    typeInto(bp().querySelector('.bt-cell-draft input[aria-label="Systolic blood pressure"]') as HTMLInputElement, '120');
    typeInto(bp().querySelector('.bt-cell-draft input[aria-label="Diastolic blood pressure"]') as HTMLInputElement, '80');
    editHeight(view.container);
    await addMeasurement('systolic_bp', 130, `${TODAY}T00:00:00.000Z`); // a connector, meanwhile
    remoteChange();

    leaveVitals(view.container);
    await wait(1000);
    expect(await rowsOf('systolic_bp')).toMatchObject([{ value: 130, status: 'active' }]);
    expect(await rowsOf('diastolic_bp')).toEqual([]);
    expect(within(bp()).getByText(SAME_SLOT)).toBeTruthy();
  });

  // Round 5: a saved column holding one half of a blood pressure showed an
  // empty pair to type into, and the half already there was corrected unseen.
  it('US-03 AC2: a saved column holding half a blood pressure shows that half, and offers nothing to type over it', async () => {
    await guest({ weight: 82 });
    await addMeasurement('systolic_bp', 130, '2026-09-01');
    const view = await secondVisit();
    const bp = row(vitalsMatrix(view.container), 'Blood Pressure');
    expect(within(bp).getByText('130/—')).toBeTruthy();
    expect(bp.querySelector('.bt-cell-backfill input')).toBeNull();
  });
});

// Review of 2026-09-24, round 3: the draft column kept the day it was first
// shown, so a value typed the next morning into an untouched New column
// landed on yesterday; and a date cleared in the picker was written as "".
describe('US-03 AC1: the New column\'s day', () => {
  it('an unpicked New column is today on every load, though other values waited overnight in both matrices', async () => {
    await guest({ weight: 82 });
    await addMeasurement('hdl', 1.4, RIGHT_DAY); // a saved column with an empty LDL cell
    const first = await secondVisit(); // 1 Sep holds a weight; its waist cell is empty
    typeInto(backfillInput(vitalsMatrix(first.container), 'Waist Circumference'), '91');
    typeInto(backfillInput(bloodMatrix(first.container), 'LDL Cholesterol'), '3.1');
    hidePage(); // put away for the night: both drafts wait on the device
    await wait(500);
    showPage();
    first.unmount();

    vi.setSystemTime(Date.now() + DAY_MS); // the next morning
    const nextDay = localDay(new Date());
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-vitals-card');
    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '81');
    typeInto(draftInput(bloodMatrix(view.container), 'Triglycerides'), '1.1');
    tapOutside(view.container);

    await waitFor(async () => expect(await activeOn('triglycerides')).toEqual([[1.1, nextDay]]));
    expect(await activeOn('weight')).toEqual([[81, nextDay], [82, '2026-09-01']]);
    expect(await activeOn('waist')).toEqual([[91, '2026-09-01']]);
    expect(await activeOn('ldl')).toEqual([[3.1, RIGHT_DAY]]);
  });

  it('a date cleared in the picker (iOS Reset) is never taken: the column keeps its day', async () => {
    await guest({ weight: 82 });
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    pickDraftDate(bloodMatrix(view.container), RIGHT_DAY);
    pickDraftDate(bloodMatrix(view.container), '');
    const dateInput = bloodMatrix(view.container).querySelector('.bt-cell-draft-date input') as HTMLInputElement;
    expect(dateInput.value).toBe(RIGHT_DAY);

    tapOutside(view.container);
    await waitFor(async () => expect(await activeOn('ldl')).toEqual([[3.2, RIGHT_DAY]]));
    expect((await rowsOf('ldl')).every((m) => m.recordedAt.startsWith(RIGHT_DAY))).toBe(true);
  });
});

// Review of 2026-09-24, round 3: a commit that partly landed kept every cell,
// the saved ones too, and the next leave wrote a saved value again over the
// user's correction of it.
describe('US-03 AC4: a commit that partly lands', () => {
  it('keeps only the refused cell, with its reason; what landed leaves the draft and the form', async () => {
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.0, `${TODAY}T00:00:00.000Z`);
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    toggleChip(bloodMatrix(view.container), 'LDL Cholesterol'); // LDL in mg/dL
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '500'); // the cell takes it; the record's range does not
    typeInto(draftInput(bloodMatrix(view.container), 'HDL Cholesterol'), '1.4');
    tapOutside(view.container);

    await waitFor(async () => expect(await activeOn('hdl')).toEqual([[1.4, TODAY]]));
    await waitFor(() => expect(draftInput(bloodMatrix(view.container), 'HDL Cholesterol').value).toBe(''));
    expect(draftInput(bloodMatrix(view.container), 'LDL Cholesterol').value).toBe('500');
    expect(within(row(bloodMatrix(view.container), 'LDL Cholesterol')).getByText(SAVE_ERRORS.invalid)).toBeTruthy();
    expect(await activeOn('ldl')).toEqual([[3, TODAY]]);

    // The saved HDL, corrected, stays corrected through the next leave.
    const editor = openEditor(row(bloodMatrix(view.container), 'HDL Cholesterol'));
    fireEvent.change(editor, { target: { value: '1.2' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(async () => expect(await activeOn('hdl')).toEqual([[1.2, TODAY]]));
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), ''); // the user settles the refused LDL
    tapOutside(view.container);
    await wait(1000);
    expect(await activeOn('hdl')).toEqual([[1.2, TODAY]]);
    expect(chat.context?.hdlC).toBe(1.2);
  });
});

// Review of 2026-09-24, round 3: every valid draft value stood in for the
// record in the plan and the chat, one that clashed with another cell or
// was older than the record's own latest value too.
describe('US-03: what the plan and the chat read of a draft', () => {
  it('a clashing or back-dated draft value leaves them to the record; the latest, clear of clashes, stands in for it', async () => {
    await guest({ weight: 82 });
    await addMeasurement('hdl', 1.4, RIGHT_DAY);
    await addMeasurement('ldl', 2.0, '2026-09-10'); // the latest LDL in the record
    const view = render(<HealthTool />);
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.0 mmol/L'));
    const matrix = bloodMatrix(view.container);
    typeInto(backfillInput(matrix, 'LDL Cholesterol'), '3.1');
    pickDraftDate(matrix, RIGHT_DAY);
    typeInto(draftInput(matrix, 'LDL Cholesterol'), '3.4'); // clashes, and 15 Aug is older than 10 Sep
    await wait(50);
    expect(ldlTile(view.container)).toBe('2.0 mmol/L');
    expect(chat.context?.ldlC).toBe(2);

    typeInto(backfillInput(bloodMatrix(view.container), 'LDL Cholesterol'), ''); // no clash; still back-dated
    await wait(50);
    expect(ldlTile(view.container)).toBe('2.0 mmol/L');

    pickDraftDate(bloodMatrix(view.container), TODAY); // today: newer than the record's latest
    await wait(50);
    expect(ldlTile(view.container)).toBe('3.4 mmol/L');
    expect(chat.context?.ldlC).toBe(3.4);
  });

  // Review of 2026-09-24, round 4 (a regression of this batch): a phone
  // turned across 768 px builds the form again, and the new matrix had sent
  // the plan nothing, so the value it sent before stayed there for good.
  it.each([
    ['emptied', (matrix: HTMLElement) => typeInto(draftInput(matrix, 'LDL Cholesterol'), '')],
    ['dated before the record\'s latest', (matrix: HTMLElement) => pickDraftDate(matrix, RIGHT_DAY)],
  ])('a draft value, the phone turned and back, then the cell %s: the plan, the chat and the PDF read the record', async (_how, change) => {
    const turnPhone = rotatablePhone();
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.9, '2026-09-10');
    const view = render(<HealthTool />);
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.9 mmol/L'));
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '2.0');
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.0 mmol/L'));

    await turnPhone(); // portrait
    await turnPhone(); // landscape again
    await shown(view.container, '.bt-timeline-title');
    expect(ldlTile(view.container)).toBe('2.0 mmol/L'); // the draft, back on screen, still stands in

    change(bloodMatrix(view.container));
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.9 mmol/L'));
    expect(chat.context?.ldlC).toBe(3.9);
    expect(await printedLdl(view)).toBe('3.9 mmol/L');
  });

  // Round 5 (a test the batch lacked): the matrix leaving the form with no
  // other built in its place, as when the weight that opened the blood tests
  // is taken back, takes back what it lent the plan and the chat.
  it('a draft value stands in while its matrix shows; the matrix leaving the form leaves the plan and the chat to the record', async () => {
    await guest(); // stage 2: the first-time weight field
    const view = render(<HealthTool />);
    const weight = await shown<HTMLInputElement>(view.container, '#weightKg');
    typeInto(weight, '82'); // the blood tests appear
    const ldl = await waitFor(() => draftInput(bloodMatrix(view.container), 'LDL Cholesterol'));
    fireEvent.change(ldl, { target: { value: '2.0' } }); // typed with the focus still in the weight
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.0 mmol/L'));
    expect(chat.context?.ldlC).toBe(2);

    fireEvent.change(weight, { target: { value: '' } }); // the weight taken back: the blood tests go
    await waitFor(() => expect(view.container.querySelector('.bt-timeline-title')).toBeNull());
    expect(ldlTile(view.container)).toBeUndefined();
    expect(chat.context?.ldlC).toBeUndefined();
  });

  // Round 5 (scoped back from round 4): what an earlier load of the page left
  // on the device waits until the user types into it here. A phone turned
  // builds the form again on the same page, and what was typed stands in.
  it('a blood-test draft restored as the page loads leaves the plan, the chat and the PDF to the record until it is typed into; a phone turned keeps it standing in', async () => {
    const turnPhone = rotatablePhone();
    await guest({ weight: 82 });
    await addMeasurement('ldl', 3.9, '2026-09-10');
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ draft: { values: { ldl: '2.0' } }, backfills: {} })); // left by an earlier load
    const view = render(<HealthTool />);
    await waitFor(() => expect(draftInput(bloodMatrix(view.container), 'LDL Cholesterol').value).toBe('2.0'));
    await wait(200);
    expect(ldlTile(view.container)).toBe('3.9 mmol/L');
    expect(chat.context?.ldlC).toBe(3.9);
    expect(await printedLdl(view)).toBe('3.9 mmol/L');

    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '2.1');
    await waitFor(() => expect(ldlTile(view.container)).toBe('2.1 mmol/L'));
    await turnPhone(); // portrait
    await turnPhone(); // landscape again
    await shown(view.container, '.bt-timeline-title');
    expect(ldlTile(view.container)).toBe('2.1 mmol/L');
    expect(chat.context?.ldlC).toBe(2.1);
  });

  it('a vitals draft restored as the page loads leaves the plan and the chat to the record until it is typed into', async () => {
    await guest({ weight: 82 });
    const first = render(<HealthTool />);
    await shown(first.container, '.bt-timeline-title');
    first.unmount();
    localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { weight: '84' } }, backfills: {} })); // left by an earlier load
    const view = render(<HealthTool />);
    await waitFor(() => expect(draftInput(vitalsMatrix(view.container), 'Weight').value).toBe('84'));
    await wait(200);
    expect(chat.context?.weightKg).toBe(82);

    typeInto(draftInput(vitalsMatrix(view.container), 'Weight'), '84.5');
    await waitFor(() => expect(chat.context?.weightKg).toBe(84.5));
  });

  // Codex R3 (2026-09-25, round 7): a remote change took back what the draft
  // lent the plan and the chat, but the matrix still counted it as lent, so
  // the same number typed again ("3" on to "3.0") sent nothing.
  it('US-03 AC6: after a remote change the plan and the chat read the record until the draft is typed into again, the same number included', async () => {
    await guest({ weight: 82 });
    await addMeasurement('ldl', 4.0, RIGHT_DAY);
    const view = render(<HealthTool />);
    await waitFor(() => expect(ldlTile(view.container)).toBe('4.0 mmol/L'));
    const ldl = () => draftInput(bloodMatrix(view.container), 'LDL Cholesterol');
    typeInto(ldl(), '3');
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.0 mmol/L'));

    await addMeasurement('hdl', 1.4, RIGHT_DAY); // a connector's change, to another test
    remoteChange();
    await waitFor(() => expect(ldlTile(view.container)).toBe('4.0 mmol/L'));
    expect(chat.context?.ldlC).toBe(4);
    expect(ldl().value).toBe('3');

    typeWithoutTap(ldl(), '3.0');
    await waitFor(() => expect(ldlTile(view.container)).toBe('3.0 mmol/L'));
    expect(chat.context?.ldlC).toBe(3);
  });

  // Round 7: a matrix built again after an upload (a phone turned) lent the
  // draft again, though nobody had typed into it since.
  it('US-03 AC6: after an upload, a phone turned lends the vitals draft nothing until it is typed into again; then it keeps lending', async () => {
    const turnPhone = rotatablePhone(); // the whole form is built again
    const view = await returningGuest(); // 82 kg on 1 Sep
    const weight = () => draftInput(vitalsMatrix(view.container), 'Weight');
    typeInto(weight(), '84');
    await waitFor(() => expect(chat.context?.weightKg).toBe(84));

    await addMeasurement('hdl', 1.4, RIGHT_DAY); // what the upload saved
    await act(async () => { await upload.onComplete!(); });
    await waitFor(() => expect(chat.context?.weightKg).toBe(82));
    await turnPhone(); // portrait
    await shown(view.container, '.bt-vitals-card');
    expect(chat.context?.weightKg).toBe(82);
    expect(weight().value).toBe('84');

    typeInto(weight(), '84.0');
    await waitFor(() => expect(chat.context?.weightKg).toBe(84));
    await turnPhone(); // landscape again
    await shown(view.container, '.bt-vitals-card');
    expect(chat.context?.weightKg).toBe(84);
  });
});

// Review of 2026-09-24, round 3: a draft typed here outlived an erase made on
// another device, and was committed into the new record when the user
// started again.
describe('US-11: an erase made on another device', () => {
  it('clears this device\'s drafts when the page takes it in; starting again brings nothing back', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    await adapter.connect();
    await initRoadmapStore(adapter);
    await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    hidePage(); // put away: the draft waits on the device
    await wait(500);
    showPage();

    // Another device erases everything. jsdom has one localStorage for both
    // devices: this device's draft is put back where it was.
    const kept = localStorage.getItem(BT_TIMELINE_DRAFT_KEY)!;
    expect(kept).toContain('3.2');
    await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteUserData();
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, kept);
    await wait(6000);
    act(() => { window.dispatchEvent(new Event('focus')); }); // this page comes back, and re-reads
    await waitFor(() => expect(view.container.querySelector('.bt-timeline-title')).toBeNull());
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();

    // The user starts again here, and the page loads again.
    await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await addMeasurement('weight', 80, TODAY);
    view.unmount();
    const again = render(<HealthTool />);
    await shown(again.container, '.bt-timeline-title');
    expect(draftInput(bloodMatrix(again.container), 'LDL Cholesterol').value).toBe('');
  });

  // Codex R1 (2026-09-24, round 4): the other device erased and started
  // again before this page re-read, so the matrix stayed on screen. It kept
  // the draft in its own state, wrote it back on the next keystroke and
  // committed it into the new record on the next leave.
  it('clears a draft still on screen: no keystroke brings it back, and leaving commits nothing', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    await adapter.connect();
    await initRoadmapStore(adapter);
    await saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await shown(view.container, '.bt-timeline-title');
    typeInto(draftInput(bloodMatrix(view.container), 'LDL Cholesterol'), '3.2');
    hidePage(); // put away: the draft waits on the device
    await wait(500);
    showPage();

    // Another device erases everything and starts again: sex, height, weight.
    const kept = localStorage.getItem(BT_TIMELINE_DRAFT_KEY)!;
    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    await other.deleteUserData();
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, kept); // one localStorage for both devices
    other.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
    other.addMeasurement('weight', 80, `${TODAY}T00:00:00.000Z`);
    await other.flush();
    await wait(6000);
    act(() => { window.dispatchEvent(new Event('focus')); }); // this page comes back, and re-reads

    const ldl = () => draftInput(bloodMatrix(view.container), 'LDL Cholesterol');
    await waitFor(() => expect(ldl().value).toBe(''));
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
    const inCloud = async (metric: string) => {
      await act(async () => { await flushRoadmapStore(); });
      const file = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
      return active(file.measurements.filter((m) => m.metricType === metric)).map((m) => m.value);
    };
    tapOutside(view.container); // leaving
    await wait(1000);
    expect(await inCloud('ldl')).toEqual([]);

    typeInto(draftInput(bloodMatrix(view.container), 'HDL Cholesterol'), '1.4'); // a keystroke
    await wait(50);
    expect(ldl().value).toBe('');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).not.toContain('3.2');
    tapOutside(view.container);
    await waitFor(async () => expect(await inCloud('hdl')).toEqual([1.4]));
    expect(await inCloud('ldl')).toEqual([]);
    expect(await inCloud('weight')).toEqual([80]);
    expect(chat.context?.ldlC).toBeUndefined();
  });
});
