// @vitest-environment jsdom
/**
 * US-03 AC2 (one active row per metric and day), a probe: two commits
 * of one typed value in the same render save it once.
 *
 * The vitals grid's commit (StartingInfoVitals), the blood-test grid's
 * (BloodTestTimeline, guarded by its `isSaving` prop) and the value page's Add
 * (ValuePage AddValue, whose Add button `saving` disables) guarded on React
 * state, which a second call in the same render cannot see. React 18 holds every render queued inside an
 * act() scope until it exits, so two triggers fired in one act both reach the
 * save with the same draft: the faithful worst case. What stops the second
 * write is the save itself: saves run one after another
 * (useLongitudinalSave), each routed against the store's rows as it writes
 * (matrix-save routeTasksToSaves: the slot no longer holds the row the cell
 * expected, so `changed`), and the store's own slot rule (placeMeasurement:
 * `slot-occupied`). These tests pin that.
 * And the second commit never reaches the save: each commit claims it
 * synchronously (a ref), so no "changed on another device" shows over a value
 * that did save, and the value page says "Added." once (US-03 AC2a, seen 2026-11-14).
 *
 * Whole widget over a REAL RoadmapStore on jsdom's localStorage. Synthetic data only.
 */
import { describe, it, expect, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { localDay } from '@roadmap/health-core/merge';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import { RoadmapStore } from '../storage/roadmap-store';
import { recordOnDisk, seedGuest, showTables, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { typeInto } from '../testing/matrix-gestures';

// What the page does as a lab upload starts, before any file is read.
const upload = vi.hoisted(() => ({ onStart: null as null | (() => Promise<void>) }));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({
  UploadModal: ({ onStart }: { onStart: () => Promise<void> }) => { upload.onStart = onStart; return null; },
}));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

const SAVED_DAY = '2026-09-01';
const PROFILE = { sex: 'male' as const, heightCm: 178, birthYear: 1980, birthMonth: 1, unitSystem: 'si' as const };
const today = () => localDay(new Date());
type Inserts = MockInstance<RoadmapStore['addMeasurement']>;

/** Every row of a metric on disk, a blood test's too: value, day, status. */
const rowsOf = async (metric: string) => toOldShape(await recordOnDisk()).measurements
  .filter((m) => m.metricType === metric)
  .map((m) => [m.value, m.recordedAt.slice(0, 10), m.status])
  .sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])));

/** A returning guest with a weight saved on SAVED_DAY, the grids on screen; the store's inserts counted from here. */
async function withGrid(): Promise<{ view: RenderResult; inserts: Inserts }> {
  await seedGuest(PROFILE, [['weight', 82]], [], SAVED_DAY);
  const inserts = vi.spyOn(RoadmapStore.prototype, 'addMeasurement');
  const view = render(<HealthTool />);
  showTables(view.container);
  await waitFor(() => expect(view.container.querySelector('.bt-vitals-card .bt-cell-draft input')).not.toBeNull());
  return { view, inserts };
}
const vitals = (view: RenderResult) => view.container.querySelector('.bt-vitals-card') as HTMLElement;
const row = (scope: Element, label: string) => [...scope.querySelectorAll<HTMLElement>('.bt-row')]
  .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!;
const draftWeight = (view: RenderResult) => row(vitals(view), 'Weight').querySelector('.bt-cell-draft input') as HTMLInputElement;
const bpHalf = (view: RenderResult, half: 'Systolic' | 'Diastolic') =>
  row(vitals(view), 'Blood Pressure').querySelector(`.bt-cell-draft input[aria-label="${half} blood pressure"]`) as HTMLInputElement;
/** A tap on the page outside every grid, as useSaveOnLeave hears it. */
const tapOutside = () => { fireEvent.pointerDown(document.body); fireEvent.pointerUp(document.body); };
/** Let the queued saves and the re-read finish. */
const settled = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
/** What a refused save shows, a cell's reason or the matrix's line under the grid: none. */
const noRefusal = (scope: HTMLElement) =>
  expect(scope.textContent!.match(/[^.]*(changed on another device|did not save|not saved)[^.]*\./g)).toBeNull();
/** Runs `body` with the process's unhandled rejections caught: a save that throws still escapes
 *  its event handler, as on main (PlanPdf.print.test.tsx does the same). */
async function catchingRejections(body: (caught: unknown[]) => Promise<void>) {
  const caught: unknown[] = [];
  const before = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const mine = (e: unknown) => { caught.push(e); };
  process.on('unhandledRejection', mine);
  try {
    await body(caught);
  } finally {
    process.off('unhandledRejection', mine);
    for (const l of before) process.on('unhandledRejection', l);
  }
}
const writeFails = () => { throw new Error('test write failed'); };
/** The store's inserts of one metric, as the save made them. */
const insertsOf = (inserts: Inserts, metric: string) => inserts.mock.calls.filter((c) => c[0] === metric).length;

describe('US-03 AC2, AC2a (double commit): a vitals New cell committed twice in one render saves once', () => {
  it('Enter and a tap outside in one render: one weight insert, one row today', async () => {
    const { view, inserts } = await withGrid();
    typeInto(draftWeight(view), '84');
    act(() => {
      fireEvent.keyDown(draftWeight(view), { key: 'Enter' });
      tapOutside();
    });
    await settled();
    expect(insertsOf(inserts, 'weight')).toBe(1);
    expect(await rowsOf('weight')).toEqual([[82, SAVED_DAY, 'active'], [84, today(), 'active']]);
    noRefusal(view.container);
  });

  it('a tap outside and an upload starting in one render: one weight insert, one row today', async () => {
    const { view, inserts } = await withGrid();
    typeInto(draftWeight(view), '84');
    await act(async () => {
      tapOutside();
      await upload.onStart!(); // commits both grids' drafts (flushRef), then the fields
    });
    await settled();
    expect(insertsOf(inserts, 'weight')).toBe(1);
    expect(await rowsOf('weight')).toEqual([[82, SAVED_DAY, 'active'], [84, today(), 'active']]);
    noRefusal(view.container);
  });

  it('a blood pressure: Enter on the diastolic and an upload starting in one render: one insert of each half', async () => {
    const { view, inserts } = await withGrid();
    typeInto(bpHalf(view, 'Systolic'), '128');
    typeInto(bpHalf(view, 'Diastolic'), '82');
    await act(async () => {
      fireEvent.keyDown(bpHalf(view, 'Diastolic'), { key: 'Enter' });
      await upload.onStart!();
    });
    await settled();
    expect([insertsOf(inserts, 'systolic_bp'), insertsOf(inserts, 'diastolic_bp')]).toEqual([1, 1]);
    expect(await rowsOf('systolic_bp')).toEqual([[128, today(), 'active']]);
    expect(await rowsOf('diastolic_bp')).toEqual([[82, today(), 'active']]);
    noRefusal(view.container);
  });

  it('a commit whose save throws frees the claim: the next Enter saves', () => catchingRejections(async (caught) => {
    const { view, inserts } = await withGrid();
    inserts.mockImplementationOnce(writeFails);
    typeInto(draftWeight(view), '84');
    fireEvent.keyDown(draftWeight(view), { key: 'Enter' });
    await settled();
    expect(caught).toHaveLength(1);
    fireEvent.keyDown(draftWeight(view), { key: 'Enter' });
    await settled();
    expect(insertsOf(inserts, 'weight')).toBe(2);
    expect(await rowsOf('weight')).toEqual([[82, SAVED_DAY, 'active'], [84, today(), 'active']]);
    noRefusal(view.container);
  }));
});

describe('US-03 AC2a (double commit): a blood-test New cell committed twice in one render saves once', () => {
  const blood = (view: RenderResult) => view.container.querySelector('.bt-timeline-title')!.closest('.bt-timeline') as HTMLElement;
  const draftLdl = (view: RenderResult) => row(blood(view), 'LDL Cholesterol').querySelector('.bt-cell-draft input') as HTMLInputElement;

  it.each([
    ['a tap outside and an upload starting', async (_view: RenderResult) => {
      tapOutside();
      await upload.onStart!(); // commits both grids' drafts (flushRef), then the fields
    }],
    ['the tick and a tap outside', async (view: RenderResult) => {
      fireEvent.click(within(blood(view)).getByRole('button', { name: 'Save typed values' }));
      tapOutside();
    }],
  ])('%s in one render: one LDL insert, one row today, no refusal shown', async (_how, commitTwice) => {
    const { view, inserts } = await withGrid();
    typeInto(draftLdl(view), '3.2');
    await act(async () => { await commitTwice(view); });
    await settled();
    expect(insertsOf(inserts, 'ldl')).toBe(1);
    expect(await rowsOf('ldl')).toEqual([[3.2, today(), 'active']]);
    noRefusal(view.container);
  });

  it('a save that throws frees the claim: the tick then saves', () => catchingRejections(async (caught) => {
    const { view, inserts } = await withGrid();
    inserts.mockImplementationOnce(writeFails);
    typeInto(draftLdl(view), '3.2');
    const tick = () => fireEvent.click(within(blood(view)).getByRole('button', { name: 'Save typed values' }));
    tick();
    await settled();
    expect(caught).toHaveLength(1);
    tick();
    await settled();
    expect(insertsOf(inserts, 'ldl')).toBe(2);
    expect(await rowsOf('ldl')).toEqual([[3.2, today(), 'active']]);
    noRefusal(view.container);
  }));
});

describe('US-03 AC2, AC2a (double commit): the value page\'s Add pressed twice in one render saves once', () => {
  /** The weight's value page, opened from its My health row; the store's writes counted from here. */
  async function weightPage(savedDay: string) {
    await seedGuest(PROFILE, [['weight', 82]], [], savedDay);
    const inserts = vi.spyOn(RoadmapStore.prototype, 'addMeasurement');
    const corrections = vi.spyOn(RoadmapStore.prototype, 'correctValue');
    const view = render(<HealthTool />);
    const weightRow = await waitFor(() => {
      const r = [...view.container.querySelectorAll<HTMLElement>('[data-topic="weight"] .md-row')]
        .find((x) => x.querySelector('.md-row-label')?.textContent === 'Weight');
      expect(r).toBeDefined();
      return r!;
    });
    fireEvent.click(weightRow);
    const page = view.container.querySelector<HTMLElement>('.md-page:not(.mh-settings)')!;
    const value = within(page).getByLabelText(/Value/) as HTMLInputElement;
    const form = page.querySelector('form.md-add') as HTMLFormElement;
    // Every message the page's live region says, in order.
    const said: string[] = [];
    const region = page.querySelector('.md-page-messages')!;
    new MutationObserver(() => { if (region.textContent?.trim()) said.push(region.textContent); })
      .observe(region, { childList: true, characterData: true, subtree: true });
    return { inserts, corrections, value, form, page, said };
  }

  it('an empty day: two submits in one render, one insert, one row today', async () => {
    const { inserts, value, form, page, said } = await weightPage(SAVED_DAY);
    fireEvent.change(value, { target: { value: '84' } });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await settled();
    expect(insertsOf(inserts, 'weight')).toBe(1);
    expect(await rowsOf('weight')).toEqual([[82, SAVED_DAY, 'active'], [84, today(), 'active']]);
    expect(said).toEqual(['Added.']);
    noRefusal(page);
  });

  it('a day already holding a weight: two submits in one render, one correction, one active row that day', async () => {
    const { inserts, corrections, value, form, page, said } = await weightPage(today());
    fireEvent.change(value, { target: { value: '84' } });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await settled();
    expect(insertsOf(inserts, 'weight')).toBe(0);
    expect(corrections).toHaveBeenCalledTimes(1);
    expect(await rowsOf('weight')).toEqual([[84, today(), 'active'], [82, today(), 'entered-in-error']]);
    expect(said).toEqual(['Corrected.']);
    noRefusal(page);
  });

  // A save that throws (the store's write failing) still hands the button back and frees the
  // claim. What the page says then is not settled (lead H128).
  it('a save that throws: the Add button comes back enabled, and the next Add saves', () => catchingRejections(async (caught) => {
    const { inserts, value, form, page, said } = await weightPage(SAVED_DAY);
    inserts.mockImplementationOnce(writeFails);
    const add = within(page).getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    fireEvent.change(value, { target: { value: '84' } });
    fireEvent.submit(form);
    await settled();
    expect(inserts).toHaveBeenCalledTimes(1);
    expect(caught).toHaveLength(1);
    expect(add.disabled).toBe(false);
    expect(said).toEqual([]);
    fireEvent.submit(form);
    await settled();
    expect(inserts).toHaveBeenCalledTimes(2);
    expect(await rowsOf('weight')).toEqual([[82, SAVED_DAY, 'active'], [84, today(), 'active']]);
    expect(said).toEqual(['Added.']);
  }));
});
