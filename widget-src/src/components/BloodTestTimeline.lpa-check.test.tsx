// @vitest-environment jsdom
/**
 * US-05 AC3: the Lp(a) check. From 2026-09-07 (6 September in US time zones)
 * until the fix went live, the
 * US-units Lp(a) field was labelled mg/L and read at 0.24 nmol/L per mg/L, so
 * a US lab's mg/dL number typed there is stored 10x low (156 mg/dL stored as
 * 37.44 nmol/L, Normal; it is 390, Elevated). The matrix asks, and the user
 * answers with a number and its unit, so a row that was stored right (a
 * connector's Quest 120 nmol/L) has an honest answer that writes nothing.
 * US-04 AC1: an answer is a correction, as a click-to-correct makes one.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { ApiMeasurement, MetricType, UnitSystem } from '@roadmap/health-core';
import { BloodTestTimeline, SAVE_ERRORS, type BloodTestPrefillFn } from './BloodTestTimeline';
import { formatShortDate } from '../lib/constants';
import { slotOf } from '../lib/matrix-save';
import { press } from '../testing/matrix-gestures';

const { trackProductEvent } = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/server-api', async (original) => ({ ...(await original<typeof import('../lib/server-api')>()), trackProductEvent }));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  trackProductEvent.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Time passes, and the promises it settles run. */
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** After an answer, every answer button rests this long (US-05 AC3: a double click answers once). */
const REST = 600;
/** What an empty live region holds, so the theme never hides it. */
const NBSP = '\u00a0';

const typedRow = (over: Partial<ApiMeasurement> = {}): ApiMeasurement => ({
  id: 'row0', metricType: 'lpa', value: 37.44, recordedAt: '2026-09-18T00:00:00.000Z',
  createdAt: '2026-09-20T04:00:00.000Z', source: 'manual', status: 'active', ...over,
});
const copy = (stored: number, recordedAt = '2026-09-18T00:00:00.000Z') =>
  `Please check this Lp(a) result from ${formatShortDate(recordedAt)}. It is saved as ${stored} nmol/L. `
  + 'Between 6 September and 13 October this box was labelled mg/L, so a number copied from a lab report '
  + 'may have been saved wrongly. What does your lab report say?';
const NOTE = 'You can also correct any value by clicking it in the table.';
const RANGE_NOTE = 'This tool records Lp(a) up to 300 mg/dL (750 nmol/L). If your report shows a higher number, '
  + 'that result is very high: please discuss it with your doctor.';
const NEITHER = 'Neither of these (keep as saved)';
/** The mg/L answer: a correction at today's 0.25 nmol/L per mg/L (clinical ruling R2). */
const mgL = (typed: number, saves: number) => `My report says ${typed} mg/L (saves ${saves} nmol/L)`;
/** Above 300 mg/dL the mg/dL answer saves the record's ceiling, 750 nmol/L (clinical ruling R3). */
const capped = (typed: number) => `My report says ${typed} mg/dL (saves 750 nmol/L, the highest value this tool records)`;
const WAIT = 'Finish editing the Lp(a) value first.';
/** What the status region says once an answer took effect, naming the result's day. */
const SAVED = (recordedAt = '2026-09-18T00:00:00.000Z') => `Saved the result from ${formatShortDate(recordedAt)}.`;
const KEPT = (recordedAt = '2026-09-18T00:00:00.000Z') => `Kept the result from ${formatShortDate(recordedAt)} as saved.`;

function matrix(rows: ApiMeasurement[] = [typedRow()], unitSystem: UnitSystem = 'conventional', onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map())) {
  const onCorrectValue: Mock = vi.fn().mockResolvedValue('ok');
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const page = (recorded: ApiMeasurement[]) => (
    <BloodTestTimeline bloodTestHistory={recorded} unitSystem={unitSystem} unitOverrides={{}} onToggleFieldUnit={() => {}}
      onSaveBatch={onSaveBatch} onCorrectValue={onCorrectValue} onDraftValue={() => {}}
      isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>
  );
  const view = render(page(rows));
  const notices = () => Array.from(view.container.querySelectorAll<HTMLElement>('.lpa-check'));
  const buttons = (i = 0) => within(notices()[i]).getAllByRole('button') as HTMLButtonElement[];
  const labels = (i = 0) => buttons(i).map((b) => b.textContent);
  const answer = async (label: RegExp | string, i = 0) => {
    fireEvent.click(within(notices()[i]).getByRole('button', { name: label }));
    await wait(0);
  };
  const answers = () => trackProductEvent.mock.calls.filter(([name]) => name === 'lpa_check_answered').map(([, meta]) => meta);
  const lpaCells = () => Array.from(view.container.querySelectorAll<HTMLElement>('[data-metric="lpa"] .bt-cell-clickable'));
  const status = () => view.container.querySelector('.lpa-check-status')!;
  return { view, notices, buttons, labels, answer, answers, lpaCells, status, onCorrectValue, prefillRef, showHistory: (recorded: ApiMeasurement[]) => view.rerender(page(recorded)) };
}

describe('US-05 AC3 — the Lp(a) check: a number with its unit', () => {
  it('asks once per row, below the matrix, in these words, with four answers in order and a pointer to the table', () => {
    const m = matrix();
    expect(m.notices()).toHaveLength(1);
    expect(m.notices()[0].closest('.bt-timeline')).toBeTruthy();
    expect(m.notices()[0].querySelector('p')?.textContent).toBe(copy(37));
    expect(m.labels()).toEqual(['My report says 156 mg/dL (saves 390 nmol/L)', 'My report says 156 nmol/L', mgL(156, 39), NEITHER]);
    expect(within(m.notices()[0]).queryByText(WAIT)).toBeNull();
    expect(within(m.notices()[0]).getByText(NOTE)).toBeTruthy();
    expect(within(m.notices()[0]).queryByText(RANGE_NOTE)).toBeNull(); // every button shown
    expect(m.notices()[0].textContent).not.toMatch(/US labs usually|by mistake/);
    expect(m.notices()[0].textContent).not.toMatch(/—/);
  });

  // Clinical ruling R2: a report in mg/L, typed into the mg/L box, was read
  // at the old 0.24 nmol/L per mg/L. The answer corrects it at today's 0.25.
  it('"My report says 156 mg/L" writes one correction of 39 nmol/L (156 x 0.25) and sends mg/L', async () => {
    const m = matrix();
    await m.answer(mgL(156, 39));
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 39);
    expect(m.notices()).toHaveLength(0);
    expect(m.answers()).toEqual([{ answer: 'mg/L' }]);
  });

  it('the mg/L answer that saves the stored value to 12 digits writes nothing, is kept on this device, and sends keep', async () => {
    const m = matrix([typedRow({ value: 0.0025 })]); // typed 0.01 mg/L: 0.01 x 0.25 is 0.0025
    await m.answer(mgL(0.01, 0.0025));
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(m.notices()).toHaveLength(0);
    expect(m.answers()).toEqual([{ answer: 'keep' }]);
    cleanup();
    expect(matrix([typedRow({ value: 0.0025 })]).notices()).toHaveLength(0);
  });

  it('Karen\'s case: 37.44 stored, "My report says 156 mg/dL" writes one correction of 390 nmol/L on that row', async () => {
    const m = matrix();
    await m.answer(/^My report says 156 mg\/dL/);
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 390);
    expect(m.answers()).toEqual([{ answer: 'mg/dL' }]);
  });

  it('"My report says 156 nmol/L" writes one correction, the number on the button', async () => {
    const m = matrix();
    await m.answer('My report says 156 nmol/L');
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 156);
    expect(m.answers()).toEqual([{ answer: 'nmol/L' }]);
  });

  it('a correctly stored connector row (Quest 120 nmol/L): the honest answer, Neither, writes nothing', async () => {
    const m = matrix([typedRow({ value: 120 })]);
    expect(m.notices()[0].querySelector('p')?.textContent).toBe(copy(120));
    // 500 mg/dL is 1250 nmol/L, past the record's 750: that answer saves 750, and a note says why.
    expect(m.labels()).toEqual([capped(500), 'My report says 500 nmol/L', mgL(500, 125), NEITHER]);
    expect(within(m.notices()[0]).getByText(RANGE_NOTE)).toBeTruthy();
    expect(m.onCorrectValue).not.toHaveBeenCalled(); // nothing is written by asking
    await m.answer(NEITHER);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(m.notices()).toHaveLength(0);
    expect(m.answers()).toEqual([{ answer: 'keep' }]);
    cleanup();
    expect(matrix([typedRow({ value: 120 })]).notices()).toHaveLength(0); // remembered on this device
  });

  it('hides a correction the record would refuse: 200 stored (833.33 typed) offers no 833.33 nmol/L, with the range note', () => {
    const m = matrix([typedRow({ value: 200 })]);
    expect(m.labels()).toEqual([capped(833.33), mgL(833.33, 208.3325), NEITHER]);
    expect(within(m.notices()[0]).getByText(RANGE_NOTE)).toBeTruthy();
  });

  it('hides an mg/L answer past 750 nmol/L too: 740 stored (3083.33 typed)', () => {
    const m = matrix([typedRow({ value: 740 })]);
    expect(m.labels()).toEqual([capped(3083.33), NEITHER]);
    expect(within(m.notices()[0]).getByText(RANGE_NOTE)).toBeTruthy();
  });

  it('shows a correction right at the bound: 180 stored (750 typed) offers 750 nmol/L, with the range note', () => {
    const m = matrix([typedRow({ value: 180 })]);
    expect(m.labels()).toEqual([capped(750), 'My report says 750 nmol/L', mgL(750, 187.5), NEITHER]);
    expect(within(m.notices()[0]).getByText(RANGE_NOTE)).toBeTruthy();
  });

  // Clinical ruling R3: a report above 300 mg/dL is a real result past the
  // record's range. The answer saves the ceiling, 750, and the note stays.
  it('a report above 300 mg/dL saves exactly 750 and sends mg/dL: 180 stored (750 mg/dL typed)', async () => {
    const m = matrix([typedRow({ value: 180 })]);
    await m.answer(capped(750));
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 750);
    expect(m.answers()).toEqual([{ answer: 'mg/dL' }]);
  });

  // Any answer that would save the stored value, to 12 significant digits,
  // writes nothing: a stored 750 (3125 typed) offered the capped mg/dL answer.
  it('a correction that would save the stored value writes nothing, is kept on this device, and sends keep: 750 stored, the capped mg/dL answer', async () => {
    const m = matrix([typedRow({ value: 750 })]);
    expect(m.labels()).toEqual([capped(3125), NEITHER]);
    await m.answer(capped(3125));
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(m.notices()).toHaveLength(0);
    expect(m.answers()).toEqual([{ answer: 'keep' }]);
    expect(m.view.container.querySelector('.lpa-check-status')?.textContent).toBe(KEPT());
    cleanup();
    expect(matrix([typedRow({ value: 750 })]).notices()).toHaveLength(0);
  });

  it('exactly 300 mg/dL is no cap: 28.8 stored (120 typed) saves 300', () => {
    expect(matrix([typedRow({ value: 28.8 })]).labels()[0]).toBe('My report says 120 mg/dL (saves 300 nmol/L)');
    cleanup();
    expect(matrix([typedRow({ value: 72 })]).labels()[0]).toBe('My report says 300 mg/dL (saves 750 nmol/L)');
  });

  it('a decimal typed is kept, never rounded: 10.92 stored was 45.5, and saves 113.75 (mg/dL) or 45.5 (nmol/L)', async () => {
    const m = matrix([typedRow({ value: 10.92 })]);
    expect(m.notices()[0].querySelector('p')?.textContent).toBe(copy(11));
    expect(m.labels()).toEqual(['My report says 45.5 mg/dL (saves 113.75 nmol/L)', 'My report says 45.5 nmol/L', mgL(45.5, 11.375), NEITHER]);
    await m.answer(/mg\/dL/);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 113.75);
    cleanup();
    const n = matrix([typedRow({ value: 10.92 })]);
    await n.answer('My report says 45.5 nmol/L');
    expect(n.onCorrectValue).toHaveBeenCalledWith('row0', 45.5);
  });

  it('asks nothing of a user whose field never showed mg/L', () => {
    expect(matrix([typedRow()], 'si').notices()).toHaveLength(0);
  });

  it('a correction ends the question: the row asked about is no longer active', async () => {
    const m = matrix();
    await m.answer(/mg\/dL/);
    expect(m.notices()).toHaveLength(0);
    // What the page re-reads after the correction: the store's active rows,
    // the old one now entered-in-error, the new one written after the fix.
    m.showHistory([typedRow({ id: 'row1', value: 390, source: 'manual_correction', createdAt: '2026-10-13T03:00:00.000Z', correctsId: 'row0' })]);
    expect(m.notices()).toHaveLength(0);
  });

  it('a correction the record refuses keeps the question, says why in a polite live region, and sends no event', async () => {
    const m = matrix();
    m.onCorrectValue.mockResolvedValue('invalid');
    await m.answer(/mg\/dL/);
    expect(m.notices()).toHaveLength(1);
    const reason = within(m.notices()[0]).getByText(SAVE_ERRORS.invalid);
    expect(reason.closest('[aria-live="polite"]')).toBeTruthy();
    await wait(REST);
    expect(m.buttons().every((b) => !b.disabled)).toBe(true); // free to answer again
    expect(document.activeElement).toBe(m.notices()[0]); // not the page
    expect(m.answers()).toEqual([]);
  });

  // The storefront theme hides `div:empty`, which would take an empty div
  // region out of the page (adversary R3).
  it('the live region is on the page before any refusal, so a screen reader hears it, and is not an empty div', () => {
    const m = matrix();
    const region = m.notices()[0].querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region!.matches('div:empty')).toBe(false);
  });

  // R4: the notice goes once answered, so the result is said in a region
  // that stays: on the page before the answer, a p (never an empty div).
  it('a correction announces "Saved the result from <date>." in a polite live region that was there before the answer and outlives the notice', async () => {
    const m = matrix();
    const region = m.view.container.querySelector('.lpa-check-status')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.tagName).toBe('P');
    expect(region.textContent).toBe(NBSP);
    await m.answer(/mg\/dL/);
    expect(m.notices()).toHaveLength(0);
    expect(m.view.container.querySelector('.lpa-check-status')).toBe(region);
    expect(region.textContent).toBe(SAVED());
  });

  it('a kept answer announces "Kept the result from <date> as saved."', async () => {
    const m = matrix();
    await m.answer(NEITHER);
    expect(m.view.container.querySelector('.lpa-check-status')?.textContent).toBe(KEPT());
  });

  // Adversary R2, Codex R2: a live region set to the text it already holds
  // says nothing, so a second "Saved." went unheard.
  it('two corrections in a row each change what the region says', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    const region = m.view.container.querySelector('.lpa-check-status')!;
    await m.answer(/mg\/dL/, 0);
    expect(region.textContent).toBe(SAVED());
    await wait(REST);
    await m.answer('My report says 50 nmol/L', 0);
    expect(region.textContent).toBe(SAVED('2026-09-25T00:00:00.000Z'));
    expect(SAVED('2026-09-25T00:00:00.000Z')).not.toBe(SAVED());
  });

  it('two keeps in a row each change what the region says', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    const region = m.view.container.querySelector('.lpa-check-status')!;
    await m.answer(NEITHER, 0);
    expect(region.textContent).toBe(KEPT());
    await wait(REST);
    await m.answer(NEITHER, 0);
    expect(region.textContent).toBe(KEPT('2026-09-25T00:00:00.000Z'));
    expect(KEPT('2026-09-25T00:00:00.000Z')).not.toBe(KEPT());
  });

  it('a refused correction announces nothing as saved', async () => {
    const m = matrix();
    m.onCorrectValue.mockResolvedValue('error');
    await m.answer(/mg\/dL/);
    expect(m.view.container.querySelector('.lpa-check-status')?.textContent).toBe(NBSP);
  });

  it('asks nothing, and holds no region, when no row needs checking', () => {
    expect(matrix([typedRow()], 'si').view.container.querySelector('.lpa-check-status')).toBeNull();
  });

  it('two rows asked about are two notices, each answered on its own', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    expect(m.notices()).toHaveLength(2);
    expect(m.labels(1)).toEqual(['My report says 50 mg/dL (saves 125 nmol/L)', 'My report says 50 nmol/L', mgL(50, 12.5), NEITHER]);
    await m.answer('My report says 50 nmol/L', 1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row1', 50);
  });
});

describe('US-05 AC3 / US-04 AC1 — one answer, one correction', () => {
  it('all four buttons are disabled while a correction saves: a double click writes once and never says "changed"', async () => {
    const m = matrix();
    let land!: (status: string) => void;
    m.onCorrectValue.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    m.onCorrectValue.mockResolvedValue('changed'); // what a second correction of the same row would get
    const button = within(m.notices()[0]).getByRole('button', { name: /mg\/dL/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(m.buttons().map((b) => b.disabled)).toEqual([true, true, true, true]);
    fireEvent.click(within(m.notices()[0]).getByRole('button', { name: NEITHER }));
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.answers()).toEqual([]); // no outcome yet
    await act(async () => { land('ok'); });
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.view.container.textContent).not.toContain(SAVE_ERRORS.changed);
    expect(m.notices()).toHaveLength(0);
    expect(m.answers()).toEqual([{ answer: 'mg/dL' }]);
  });

  it('the event follows the outcome and carries only the label, never a number', async () => {
    for (const [label, answer] of [[/mg\/dL/, 'mg/dL'], ['My report says 156 nmol/L', 'nmol/L'], [mgL(156, 39), 'mg/L'], [NEITHER, 'keep']] as const) {
      cleanup();
      localStorage.clear();
      trackProductEvent.mockClear();
      const m = matrix();
      await m.answer(label);
      const [meta] = m.answers();
      expect(meta).toEqual({ answer });
      expect(JSON.stringify(meta)).not.toMatch(/\d/);
    }
  });
});

// Adversary R9: the check and the cell's own editor correct the same row, and
// the second to land would be refused as "changed". While an Lp(a) value's
// editor is open, the check waits.
describe('US-05 AC3 — the check waits while an Lp(a) value is being corrected in the table', () => {
  it('its buttons are disabled while the editor is open, and free again once it closes', () => {
    const m = matrix();
    expect(m.buttons().every((b) => !b.disabled)).toBe(true);
    fireEvent.click(m.lpaCells()[0]);
    const input = m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(m.buttons().every((b) => b.disabled)).toBe(true);
    expect(within(m.notices()[0]).getByText(WAIT)).toBeTruthy(); // R4: says why
    fireEvent.click(within(m.notices()[0]).getByRole('button', { name: /mg\/dL/ }));
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(m.buttons().every((b) => !b.disabled)).toBe(true);
    expect(within(m.notices()[0]).queryByText(WAIT)).toBeNull();
  });

  // Codex R2: an editor's delayed close (its click-away timer) cleared the
  // marker of whichever cell was open by then, freeing the buttons while an
  // Lp(a) editor was still open.
  it('another cell closing late does not free them: an LDL editor, then an Lp(a) one before the LDL click-away timer fires', async () => {
    vi.useFakeTimers();
    try {
      const m = matrix([typedRow({ id: 'ldl0', metricType: 'ldl', value: 3.2 }), typedRow()]);
      const cell = (metric: string) => m.view.container.querySelector<HTMLElement>(`[data-metric="${metric}"] .bt-cell-clickable`)!;
      fireEvent.click(cell('ldl'));
      expect(m.buttons().every((b) => b.disabled)).toBe(false);
      const lpaCell = cell('lpa');
      press(lpaCell); // the LDL editor loses the focus: its click-away timer starts
      fireEvent.click(lpaCell);
      expect(m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting input')).toBeTruthy();
      expect(m.buttons().every((b) => b.disabled)).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(m.view.container.querySelector('[data-metric="ldl"] .bt-cell-correcting')).toBeNull();
      expect(m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting input')).toBeTruthy();
      expect(m.buttons().every((b) => b.disabled)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Adversary R7: a draft or backfill cell losing the focus cleared whichever
// cell was marked active, so an Lp(a) editor opened from it lost its mark and
// freed the check's buttons. A cell clears only its own mark.
describe('US-05 AC3 / US-04 AC1 — a typed cell losing the focus to an Lp(a) editor', () => {
  for (const kind of ['draft', 'backfill'] as const) {
    it(`leaves the check waiting: the ${kind} cell focused, then the Lp(a) value clicked open`, () => {
      const m = matrix([typedRow({ id: 'ldl0', metricType: 'ldl', value: 3.2 }), typedRow()]);
      const cell = m.view.container.querySelector<HTMLInputElement>(`.bt-cell-${kind} input`)!; // another test's empty cell
      fireEvent.pointerDown(cell);
      act(() => cell.focus());
      fireEvent.pointerUp(cell);
      expect(m.buttons().every((b) => !b.disabled)).toBe(true);
      // Safari: the press on the value takes no focus; the editor's own input takes it.
      fireEvent.pointerDown(m.lpaCells()[0]);
      fireEvent.pointerUp(m.lpaCells()[0]);
      fireEvent.click(m.lpaCells()[0]);
      const input = m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting input');
      expect(document.activeElement).toBe(input);
      expect(m.buttons().every((b) => b.disabled)).toBe(true);
    });
  }
});

describe('US-05 AC3 — where the focus goes after an answer', () => {
  it('to the next notice, then to the Lp(a) row\'s value, never to the page', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    await m.answer(NEITHER, 0);
    expect(m.notices()).toHaveLength(1);
    expect(document.activeElement).toBe(m.notices()[0]);
    await wait(REST);
    await m.answer('My report says 50 nmol/L', 0);
    expect(m.notices()).toHaveLength(0);
    const cells = m.lpaCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(cells[cells.length - 1]);
    expect(document.activeElement).not.toBe(document.body);
  });
});

// Adversary R1: the first click of a double click unmounts its notice, and
// the next notice moves into place, so the second click answered it too.
describe('US-05 AC3 — a double click answers one question', () => {
  const twoRows = () => matrix([typedRow(), typedRow({ id: 'row1', value: 120, recordedAt: '2026-09-10T00:00:00.000Z' })]);
  const firstButton = (m: ReturnType<typeof matrix>) => m.buttons(0)[0];
  const neither = (m: ReturnType<typeof matrix>) => within(m.notices()[0]).getByRole('button', { name: NEITHER });

  it('a double click on a correction corrects only the first row', async () => {
    const m = twoRows();
    fireEvent.click(firstButton(m), { detail: 1 });
    await wait(0); // the correction lands; the second row's notice moves into place
    expect(m.notices()).toHaveLength(1);
    fireEvent.click(firstButton(m), { detail: 2 });
    await wait(0);
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 390);
    expect(m.notices()).toHaveLength(1);
  });

  it('a double click on Neither keeps only the first row', async () => {
    const m = twoRows();
    fireEvent.click(neither(m), { detail: 1 });
    fireEvent.click(neither(m), { detail: 2 });
    await wait(0);
    expect(JSON.parse(localStorage.getItem('health_roadmap_lpa_check_kept')!)).toEqual(['row0']);
    expect(m.notices()).toHaveLength(1);
    expect(m.answers()).toEqual([{ answer: 'keep' }]);
  });

  it('a click that is the second of a double click is never an answer, however late', async () => {
    const m = twoRows();
    await wait(REST);
    fireEvent.click(neither(m), { detail: 2 });
    await wait(0);
    expect(localStorage.getItem('health_roadmap_lpa_check_kept')).toBeNull();
    expect(m.notices()).toHaveLength(2);
  });

  it('every answer button rests for 600 ms after an answer, then answers again', async () => {
    const m = twoRows();
    await m.answer(NEITHER);
    expect(m.buttons(0).every((b) => b.disabled)).toBe(true);
    fireEvent.click(neither(m), { detail: 1 });
    await wait(REST - 50);
    expect(m.notices()).toHaveLength(1);
    expect(m.buttons(0).every((b) => b.disabled)).toBe(true);
    await wait(50);
    expect(m.buttons(0).every((b) => !b.disabled)).toBe(true);
    await m.answer(NEITHER);
    expect(m.notices()).toHaveLength(0);
  });
});

// Codex R1 / adversary R7: the check knew an Lp(a) editor was open only
// from the highlighted cell, which another cell can take while the editor is
// still open, and which a refused save can leave behind. It counts the open
// Lp(a) editors instead.
describe('US-05 AC3 — the check waits for every open Lp(a) editor, not the highlight', () => {
  it('moving from an open Lp(a) editor to a draft cell before its 150 ms click-away timer keeps the answers disabled until the editor closes', async () => {
    const m = matrix();
    fireEvent.click(m.lpaCells()[0]);
    expect(m.buttons().every((b) => b.disabled)).toBe(true);
    press(m.view.container.querySelector<HTMLInputElement>('[data-metric="ldl"] .bt-cell-draft input')!);
    expect(m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting input')).toBeTruthy();
    expect(m.buttons().every((b) => b.disabled)).toBe(true);
    expect(within(m.notices()[0]).getByText(WAIT)).toBeTruthy();
    await wait(200); // the editor, untouched, closes
    expect(m.view.container.querySelector('[data-metric="lpa"] .bt-cell-correcting')).toBeNull();
    expect(m.buttons().every((b) => !b.disabled)).toBe(true);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a chat value refused for a slot another device filled leaves no stale wait: no Lp(a) editor is open', async () => {
    const onSaveBatch = vi.fn().mockResolvedValue(new Map([[slotOf('2026-09-10', 'lpa'), 'changed']]));
    const ldl = typedRow({ id: 'ldl0', metricType: 'ldl', value: 3.2, recordedAt: '2026-09-10T00:00:00.000Z' });
    const m = matrix([typedRow(), ldl], 'conventional', onSaveBatch);
    act(() => { m.prefillRef.current!('lpa' as MetricType, 50, 'conventional', '2026-09-10'); });
    fireEvent.click(m.view.getByRole('button', { name: 'Save typed values' }));
    await wait(0);
    expect(onSaveBatch).toHaveBeenCalledTimes(1);
    // Another device's Lp(a) for that day, written after the fix: the page re-reads the record.
    m.showHistory([typedRow(), ldl, typedRow({ id: 'other', value: 125, recordedAt: '2026-09-10T00:00:00.000Z', createdAt: '2026-10-13T05:00:00.000Z' })]);
    expect(m.view.container.querySelector('.bt-cell-correcting')).toBeNull();
    expect(m.buttons().every((b) => !b.disabled)).toBe(true);
    expect(within(m.notices()[0]).queryByText(WAIT)).toBeNull();
  });
});

// Codex R2 / adversary R3: a live region set to the text it already holds
// changes nothing in the page, so a screen reader says nothing.
describe('US-05 AC3 — the check status region says a repeat too', () => {
  it('two keeps of results from the same day each clear the region, then say it', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12 })]); // both from 18 September
    await m.answer(NEITHER);
    expect(m.status().textContent).toBe(KEPT());
    await wait(REST);
    fireEvent.click(within(m.notices()[0]).getByRole('button', { name: NEITHER }));
    expect(m.status().textContent).toBe(NBSP); // cleared first: a fresh change
    await wait(0);
    expect(m.status().textContent).toBe(KEPT());
  });
});

// Adversary R8: a correction refused because another device replaced the
// row; the page re-reads the record and the notice goes, so the reason is
// said where it outlives the notice.
describe('US-05 AC3 — an answer refused because the result changed elsewhere', () => {
  it('says "This result changed on another device. Nothing was saved." in the status region, which outlives the notice', async () => {
    const m = matrix();
    m.onCorrectValue.mockResolvedValue('changed');
    await m.answer(/mg\/dL/);
    expect(m.status().textContent).toBe('This result changed on another device. Nothing was saved.');
    m.showHistory([typedRow({ id: 'other', value: 100, createdAt: '2026-10-13T05:00:00.000Z' })]);
    expect(m.notices()).toHaveLength(0);
    expect(m.status().textContent).toBe('This result changed on another device. Nothing was saved.');
    expect(m.answers()).toEqual([]);
  });

  // Adversary R5: the re-read took the notice, and the focus with it, to the page.
  it('moves the focus to the status region, which keeps it once the notice goes', async () => {
    const m = matrix();
    m.onCorrectValue.mockResolvedValue('changed');
    await m.answer(/mg\/dL/);
    expect(document.activeElement).toBe(m.status());
    m.showHistory([typedRow({ id: 'other', value: 100, createdAt: '2026-10-13T05:00:00.000Z' })]);
    expect(m.notices()).toHaveLength(0);
    expect(document.activeElement).toBe(m.status());
  });

  it('moves the focus to the next notice when there is one', async () => {
    const m = matrix([typedRow(), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    const next = m.notices()[1];
    m.onCorrectValue.mockResolvedValue('changed');
    await m.answer(/mg\/dL/, 0);
    expect(document.activeElement).toBe(next);
    m.showHistory([typedRow({ id: 'other', value: 100, createdAt: '2026-10-13T05:00:00.000Z' }), typedRow({ id: 'row1', value: 12, recordedAt: '2026-09-25T00:00:00.000Z' })]);
    expect(document.activeElement).toBe(next);
  });
});
