// @vitest-environment jsdom
/**
 * US-75, the blood pressure widget as a visitor sees it, over a real
 * RoadmapStore: the two readings, the average and its stage, the plan's own
 * card, the save, the prefill, the auto-advance and the privacy rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import type { SuggestionInputs } from '@roadmap/health-core/types';
import { computePlan } from '@roadmap/health-core/plan';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { PRESSURE_ORDER } from '@roadmap/health-core/validation';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { BloodPressureWidget, WIDTH, spelledOut } from './BloodPressure';
import { NO_SAVES, savePair, transition, type SavesEvent, type Saves } from './blood-pressure';
import { bpTier } from '@roadmap/health-core/bp-tier';
/** Whether a pair's tier has a plan card (Stage 1 and above). */
const bpTierOf = (sys: number, dia: number) => !['normal', 'elevated'].includes(bpTier(sys, dia));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

const OLD = '2026-01-10T00:00:00.000Z';
let cloud: MemoryCloud;
/** The record as the store last wrote it to the cloud; none written yet reads as no rows. */
const persisted = (): RoadmapFile => {
  const written = cloud.files.get(ROADMAP_FILE_NAME);
  return written ? JSON.parse(written.json) : { ...data.recordFileSync()!, measurements: [] };
};
const rows = (metric: string) => persisted().measurements.filter((m) => m.metricType === metric);
const active = (metric: string) => rows(metric).filter((m) => m.status === 'active').map((m) => m.value);
const reading = (n: 1 | 2) => within(screen.getByRole('group', { name: new RegExp(`^Reading ${n}`) }));
const box = (n: 1 | 2, half: 'top' | 'bottom') => reading(n).getByLabelText(half === 'top' ? /^Systolic/ : /^Diastolic/) as HTMLInputElement;
const type = (n: 1 | 2, half: 'top' | 'bottom', value: string) => fireEvent.change(box(n, half), { target: { value } });
const enterPair = (n: 1 | 2, sys: string, dia: string) => { type(n, 'top', sys); type(n, 'bottom', dia); };
/** Leave the readings, as a tap elsewhere does (useSaveOnLeave), and let the save land. */
const leave = async () => {
  fireEvent.pointerDown(box(1, 'top'));
  fireEvent.pointerDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.focusIn(document.body);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};
/** A result text as read: padding and the no-break space before the unit read as one space. */
const shown = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\u2060/g, '').replace(/\s+/g, ' ').trim() ?? null;
/** The card's text exactly, its line breaks kept, without the padding. */
const advice = () => document.querySelector('.hr-widget-advice')?.textContent?.replace(/\u2060/g, '') ?? null;
const calls = (name: string) => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === name);
const tierCard = (file: RoadmapFile) => computePlan(file).results.suggestions.find((s) => s.id.startsWith('bp-') && s.id !== 'bp-measure' && s.category === 'blood_pressure' && s.id !== 'measure-bp');

beforeEach(async () => {
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no HTTP')));
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  cloud = new MemoryCloud();
  await data.initRoadmapStore(new MemoryAdapter(cloud));
  vi.mocked(trackProductEvent).mockClear();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await data.flushRoadmapStore();
  vi.unstubAllGlobals();
});

describe('US-75 blood pressure widget', () => {
  it('AC4: grades the average at every tier boundary, live, with no button', () => {
    const cases: Array<[string, string, string]> = [
      ['119', '79', 'Normal'], ['120', '79', 'Elevated'], ['129', '79', 'Elevated'], ['130', '79', 'Stage 1 range'],
      ['110', '80', 'Stage 1 range'], ['139', '89', 'Stage 1 range'], ['140', '70', 'Stage 2 range'],
      ['110', '90', 'Stage 2 range'], ['179', '119', 'Stage 2 range'], ['180', '70', 'Crisis range'], ['125', '120', 'Crisis range'],
    ];
    for (const [sys, dia, stage] of cases) {
      const { unmount } = render(<BloodPressureWidget />);
      enterPair(1, sys, dia);
      expect([sys, dia, shown('.hr-widget-sr, .hr-widget-status'), shown('.hr-widget-v')]).toEqual([sys, dia, stage, `${sys}/${dia} mmHg`]);
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('AC2: a pair at or below its bottom number is no blood pressure: the error, no result, no save', async () => {
    render(<BloodPressureWidget />);
    enterPair(1, '80', '120');
    expect(screen.getAllByText(PRESSURE_ORDER)).toHaveLength(1);
    expect(box(1, 'top').getAttribute('aria-invalid')).toBe('true');
    expect(box(1, 'bottom').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.hr-widget-res')).toBeNull();
    enterPair(1, '90', '90');
    expect(screen.getAllByText(PRESSURE_ORDER)).toHaveLength(1);
    await leave();
    expect(active('systolic_bp')).toEqual([]);
  });

  it('AC4: averages the readings given, each half rounded to a whole mmHg', () => {
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    expect(shown('.hr-widget-v')).toBe('135/85 mmHg');
    enterPair(2, '140', '90');
    expect(shown('.hr-widget-v')).toBe('138/88 mmHg'); // 137.5 and 87.5 round up
    enterPair(2, '136', '84');
    expect(shown('.hr-widget-v')).toBe('136/85 mmHg'); // 135.5 -> 136, 84.5 -> 85
    // A reading with one half only is not a reading yet: the average is the first's.
    type(2, 'bottom', '');
    expect(shown('.hr-widget-v')).toBe('135/85 mmHg');
  });

  it('AC4: the card is the plan\'s own text for the saved average, age target included', async () => {
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1955, birthMonth: 1, sex: 'male' }, {}, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    enterPair(2, '131', '81');
    const text = advice();
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[133], [83]]);
    const card = tierCard(persisted());
    expect(card?.id).toBe('bp-stage1');
    expect(text).toBe(spelledOut(card!.description)); // the plan's words, line breaks and all, its abbreviation spelled out
    expect(text).toContain('Dr Brad aims for below 130/80 from 65.'); // 65 or older
    // Never reworded: the DOM text is the description, line breaks and all.
  });

  it('AC4 (ruling C2): with no plan (a fresh record, no height) the engine\'s own card for the pair alone shows, in its medicine-free words', () => {
    render(<BloodPressureWidget />);
    enterPair(1, '150', '95');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('Stage 2 range');
    const alone = (sys: number, dia: number, id: string) => calculateHealthResults({ systolicBp: sys, diastolicBp: dia } as SuggestionInputs).suggestions.find((c) => c.id === id)!.description;
    expect(advice()).toBe(spelledOut(alone(150, 95, 'bp-stage2')));
    expect(advice()).toContain('Discuss treatment with your doctor.');
    expect(advice()).not.toContain('medication');
    enterPair(1, '190', '125');
    expect(advice()).toBe(spelledOut(alone(190, 125, 'bp-crisis')));
    expect(advice()).toMatch(/^Your blood pressure of 190\/125 mmHg is dangerously high\./);
  });

  it('AC4 (ruling C1): any one reading at crisis level makes the result crisis, whatever the average; the average is what is saved', async () => {
    render(<BloodPressureWidget />);
    enterPair(1, '190', '125');
    enterPair(2, '140', '85');
    expect(shown('.hr-widget-v')).toBe('165/105 mmHg');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('Crisis range');
    expect(advice()).toMatch(/^Your blood pressure of 190\/125 mmHg is dangerously high\./);
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[165], [105]]);
    cleanup();
    render(<BloodPressureWidget />);
    type(1, 'top', '160'); type(1, 'bottom', '95');
    enterPair(2, '190', '122');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('Crisis range');
    expect(advice()).toMatch(/^Your blood pressure of 190\/122 mmHg/);
  });

  it('AC4 (ruling C3): a known minor gets the average only: no adult stage, pill or card', async () => {
    await data.saveChangedMeasurements({ birthYear: new Date().getFullYear() - 10, birthMonth: 1 }, {}, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '119', '79');
    expect(shown('.hr-widget-v')).toBe('119/79 mmHg');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('');
    enterPair(1, '190', '125');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('');
    expect(advice()).toBe('');
  });

  it('AC4 (Codex R4): the card is worked out from the readable record, so a row the full app cannot read never shapes it', async () => {
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1970, birthMonth: 1, sex: 'male' }, {}, data.getShownErase());
    await data.flushRoadmapStore();
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    const plain = advice();
    cleanup();
    // A lab eGFR of 95 with a comparator this build cannot read: hidden from every reader.
    const file = data.recordFileSync()!;
    file.labValues.push({ id: 'hidden-egfr', metricName: 'egfr', value: 95, unit: 'mL/min/1.73m²', recordedAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z', source: 'lab_import', status: 'active', correctsId: null, comparator: '~' } as never);
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    expect(advice()).toBe(plain);
    expect(advice()).not.toMatch(/potassium/i);
  });

  it('AC4: Normal and Elevated show no card with a plan; crisis shows the plan\'s crisis card', async () => {
    await data.saveChangedMeasurements({ heightCm: 170 }, {}, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '118', '76');
    expect(advice()).toBe('');
    enterPair(1, '125', '78');
    expect(advice()).toBe('');
    enterPair(1, '185', '100');
    expect(advice()).toMatch(/^Your blood pressure of 185\/100 mmHg is dangerously high\./);
  });

  it('AC5: saves the average as today\'s pair; a later change the same day corrects today\'s rows', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[135], [85]]);
    enterPair(2, '140', '90');
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[138], [88]]);
    // One active row per metric per day; the first is kept as entered-in-error, corrected by the second.
    const sys = rows('systolic_bp');
    expect(sys.map((m) => [m.value, m.status]).sort()).toEqual([[135, 'entered-in-error'], [138, 'active']]);
    expect(sys.find((m) => m.value === 138)!.correctsId).toBe(sys.find((m) => m.value === 135)!.id);
    expect(calls('bp_widget_saved')).toEqual([['bp_widget_saved']]);
    expect(calls('bp_widget_viewed')).toEqual([['bp_widget_viewed']]);
    expect(calls('measurement_added')).toEqual([['measurement_added', { measure: 'blood_pressure' }]]);
  });

  it('AC5: Enter saves now; a reading with an error blocks the save', async () => {
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    type(2, 'top', '300');
    fireEvent.keyDown(box(2, 'top'), { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(active('systolic_bp')).toEqual([]);
    type(2, 'top', '');
    fireEvent.keyDown(box(1, 'bottom'), { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(active('systolic_bp')).toEqual([135]);
  });

  it('AC5: no save message at all, before, during or after a save', async () => {
    const { container } = render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    const during = leave();
    expect(container.textContent).not.toMatch(/sav|not kept|changed|error/i);
    await during;
    expect(active('systolic_bp')).toEqual([135]);
    expect(container.textContent).not.toMatch(/sav|not kept|changed|error/i);
  });

  it('AC3: prefills Reading 1 from the record\'s latest pair, an older day\'s with "from <date>"; untouched, it is never saved', async () => {
    await data.addMeasurement('systolic_bp', 128, OLD, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 82, OLD, data.getShownErase());
    await data.flushRoadmapStore();
    render(<BloodPressureWidget />);
    expect([box(1, 'top').value, box(1, 'bottom').value]).toEqual(['128', '82']);
    expect(screen.getByText(`from ${formatShortDate('2026-01-10')}`)).toBeTruthy();
    expect(shown('.hr-widget-v')).toBe('128/82 mmHg');
    await leave();
    expect(rows('systolic_bp').map((m) => m.value)).toEqual([128]);
    // Typing in Reading 2 clears the record's reading: it is never averaged in or saved.
    enterPair(2, '120', '70');
    expect([box(1, 'top').value, box(1, 'bottom').value]).toEqual(['', '']);
    expect(screen.queryByText(/^from /)).toBeNull();
    expect(shown('.hr-widget-v')).toBe('120/70 mmHg');
    await leave();
    expect(active('systolic_bp').sort()).toEqual([120, 128]);
  });

  it('AC3 (Codex R7): editing one half of the record\'s reading clears its other half, so no day\'s half is saved with today\'s', async () => {
    await data.addMeasurement('systolic_bp', 165, OLD, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 98, OLD, data.getShownErase());
    await data.flushRoadmapStore();
    render(<BloodPressureWidget />);
    type(1, 'top', '125');
    expect([box(1, 'top').value, box(1, 'bottom').value]).toEqual(['125', '']);
    expect(document.querySelector('.hr-widget-res')).toBeNull();
    await leave();
    expect(active('systolic_bp')).toEqual([165]);
  });

  it('AC3 (adversary R7): today\'s saved reading prefills with no note and is not averaged in again', async () => {
    await data.addMeasurement('systolic_bp', 130, undefined, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 80, undefined, data.getShownErase());
    render(<BloodPressureWidget />);
    expect(screen.queryByText(/^from /)).toBeNull();
    enterPair(2, '140', '90');
    expect(shown('.hr-widget-v')).toBe('140/90 mmHg');
    await leave();
    // The page showed today's rows, so its save corrects them.
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[140], [90]]);
  });

  it('AC3 (Codex R6): a newer lone half does not hide the newest complete pair', async () => {
    await data.addMeasurement('systolic_bp', 128, OLD, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 82, OLD, data.getShownErase());
    await data.addMeasurement('systolic_bp', 150, '2026-02-01T00:00:00.000Z', data.getShownErase());
    render(<BloodPressureWidget />);
    expect([box(1, 'top').value, box(1, 'bottom').value]).toEqual(['128', '82']);
  });

  it('AC5 (Codex R3): a slot holding a row the page did not show refuses both halves; nothing is half saved', async () => {
    render(<BloodPressureWidget />);
    // Another tab writes today's diastolic after the page opened: the page has not seen it.
    await data.addMeasurement('diastolic_bp', 70, undefined, data.getShownErase());
    await data.flushRoadmapStore();
    enterPair(1, '150', '95');
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[], [70]]);
    // A newer edit, typed after the change, may replace it (as US-74 AC4).
    enterPair(1, '150', '96');
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[150], [96]]);
  });

  it('AC5 (Codex R3): an unreadable row in a slot refuses both halves', async () => {
    render(<BloodPressureWidget />);
    const file = data.recordFileSync()!;
    const day = new Date().toLocaleDateString('en-CA');
    file.measurements.push({ id: 'odd', metricType: 'diastolic_bp', value: 70, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, source: 42, status: 'active', correctsId: null, externalId: null } as never);
    enterPair(1, '150', '95');
    await leave();
    expect(data.recordFileSync()!.measurements.filter((m) => m.metricType === 'systolic_bp')).toEqual([]);
  });

  it('AC5 (Codex R11): an exact stored value is compared exactly, never by its display', async () => {
    await data.addMeasurement('systolic_bp', 179.6, undefined, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 85, undefined, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '180', '90');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('Crisis range');
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[180], [90]]);
  });

  it('AC5 (Codex R9): a kept reading is not saved again on a later day without a new entry; a save is bound to the day it was asked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 16, 23, 0));
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    await leave();
    vi.setSystemTime(new Date(2026, 10, 17, 8, 0));
    await leave(); // a tap in and out, no typing
    expect(rows('systolic_bp').map((m) => [m.value, m.recordedAt.slice(0, 10)])).toEqual([[135, '2026-11-16']]);
    enterPair(1, '140', '90');
    await leave();
    expect(rows('systolic_bp').map((m) => [m.value, m.status, m.recordedAt.slice(0, 10)]).sort()).toEqual([[135, 'active', '2026-11-16'], [140, 'active', '2026-11-17']]);
    vi.useRealTimers();
  });

  it('AC5 (Codex R8): a save asked before a conflict was found never writes over the row that conflict showed', async () => {
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    await leave();
    // Another device corrects today's systolic.
    const sysRow = data.loadAllHistorySync().find((m) => m.metricType === 'systolic_bp')!;
    await data.correctValue(sysRow.id, 120, data.getShownErase());
    await data.flushRoadmapStore();
    enterPair(1, '150', '95');
    fireEvent.keyDown(box(1, 'bottom'), { key: 'Enter' }); // asked, queued
    await leave(); // asked again for the same entry
    expect(active('systolic_bp')).toEqual([120]);
  });

  it('AC6 (Codex R12): the next-step link leaves only once a typed reading is kept', async () => {
    const navigate = vi.fn();
    render(<BloodPressureWidget nextUrl="/pages/health-plan" navigate={navigate} />);
    enterPair(1, '135', '85');
    const flush = vi.spyOn(data, 'flushRoadmapStore').mockRejectedValueOnce(new Error('no cloud'));
    vi.spyOn(data, 'currentSaveStatus').mockReturnValue('error' as never);
    fireEvent.click(screen.getByRole('link'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(navigate).not.toHaveBeenCalled();
    flush.mockRestore();
    vi.mocked(data.currentSaveStatus).mockRestore();
    fireEvent.click(screen.getByRole('link'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(navigate).toHaveBeenCalledWith('/pages/health-plan');
    expect(active('systolic_bp')).toEqual([135]);
  });

  it('AC4 (Codex 1876b R1): the card is always the typed pair\'s, whatever pair the record holds on a later day', async () => {
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1970, birthMonth: 1, sex: 'male' }, {}, data.getShownErase());
    const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    await data.addMeasurement('systolic_bp', 118, tomorrow, data.getShownErase());
    await data.addMeasurement('diastolic_bp', 76, tomorrow, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '190', '125');
    expect(advice()).toMatch(/^Your blood pressure of 190\/125 mmHg is dangerously high\./);
    cleanup();
    const later = data.loadAllHistorySync().filter((m) => m.recordedAt === tomorrow);
    for (const m of later) await data.correctValue(m.id, m.metricType === 'systolic_bp' ? 200 : 130, data.getShownErase());
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    expect(advice()).toMatch(/^Your blood pressure of 135\/85 mmHg is in the range the ACC\/AHA guideline calls stage 1/);
    enterPair(1, '190', '125');
    expect(advice()).toMatch(/^Your blood pressure of 190\/125 mmHg/);
  });

  it('AC5 (Codex 1876b R5): a reading typed before midnight is not averaged into the new day\'s save', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 16, 23, 0));
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    await leave();
    vi.setSystemTime(new Date(2026, 10, 17, 8, 0));
    enterPair(2, '145', '95');
    expect(shown('.hr-widget-v')).toBe('145/95 mmHg');
    fireEvent.keyDown(box(2, 'bottom'), { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(rows('systolic_bp').map((m) => [m.value, m.recordedAt.slice(0, 10)]).sort()).toEqual([[135, '2026-11-16'], [145, '2026-11-17']]);
    vi.useRealTimers();
  });

  it('AC6 (Codex 1876b R7): a complete reading held back by another reading\'s error keeps the next-step link on the page', async () => {
    const navigate = vi.fn();
    render(<BloodPressureWidget nextUrl="/pages/health-plan" navigate={navigate} />);
    enterPair(1, '135', '85');
    type(2, 'top', '300');
    fireEvent.click(screen.getByRole('link'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(navigate).not.toHaveBeenCalled();
    expect(active('systolic_bp')).toEqual([]);
    type(2, 'top', '');
    fireEvent.click(screen.getByRole('link'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(navigate).toHaveBeenCalledWith('/pages/health-plan');
  });

  it('AC6 (Brad 2026-11-19): with no card the advice is hidden, and the first edit drops the returning reserve', async () => {
    const block = document.createElement('div');
    block.className = 'hr-widget hr-widget--saved';
    document.body.append(block);
    render(<BloodPressureWidget />, { container: block });
    enterPair(1, '118', '76');
    expect((document.querySelector('.hr-widget-advice') as HTMLElement).hidden).toBe(true);
    expect(block.className).toBe('hr-widget');
    enterPair(1, '150', '95');
    expect((document.querySelector('.hr-widget-advice') as HTMLElement).hidden).toBe(false);
    block.remove();
  });

  it('AC1 (Codex R14): two blocks on one page send each event once per page view', async () => {
    render(<><BloodPressureWidget /><BloodPressureWidget /></>);
    expect(calls('bp_widget_viewed')).toHaveLength(1);
    const [first, second] = screen.getAllByRole('group', { name: /^Reading 1/ });
    fireEvent.change(within(first).getByLabelText(/^Systolic/), { target: { value: '135' } });
    fireEvent.change(within(first).getByLabelText(/^Diastolic/), { target: { value: '85' } });
    fireEvent.keyDown(within(first).getByLabelText(/^Diastolic/), { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.change(within(second).getByLabelText(/^Systolic/), { target: { value: '140' } });
    fireEvent.change(within(second).getByLabelText(/^Diastolic/), { target: { value: '90' } });
    fireEvent.keyDown(within(second).getByLabelText(/^Diastolic/), { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls('bp_widget_saved')).toHaveLength(1);
  });

  it('AC2: systolic moves on to diastolic (US-02 AC6), and a complete diastolic to the next reading\'s systolic while it is empty', () => {
    render(<BloodPressureWidget />);
    box(1, 'top').focus();
    type(1, 'top', '135');
    expect(document.activeElement).toBe(box(1, 'bottom'));
    type(1, 'bottom', '8');
    expect(document.activeElement).toBe(box(1, 'bottom'));
    type(1, 'bottom', '85');
    expect(document.activeElement).toBe(box(2, 'top'));
    type(2, 'top', '140');
    expect(document.activeElement).toBe(box(2, 'bottom'));
    type(2, 'bottom', '90'); // the last box: nowhere to go
    expect(document.activeElement).toBe(box(2, 'bottom'));
    // A filled next reading is not jumped into.
    box(1, 'bottom').focus();
    type(1, 'bottom', '88');
    expect(document.activeElement).toBe(box(1, 'bottom'));
  });

  it('AC2: the boxes take digits only, as the vitals grid\'s pair', () => {
    render(<BloodPressureWidget />);
    const event = fireEvent.keyDown(box(1, 'top'), { key: 'a' });
    expect(event).toBe(false); // prevented
    type(1, 'top', '1a3.5');
    expect(box(1, 'top').value).toBe('135');
  });
});

describe('US-75 AC7 privacy', () => {
  const STAGES: Array<[string, string]> = [['118', '76'], ['125', '78'], ['134', '82'], ['150', '95'], ['185', '100'], ['99', '60'], ['250', '150']];
  /** Clarity's encoding of a masked text node (clarity-js src/core/scrub.ts mangleText; as US-74's test):
   *  its trimmed length in base 36, the whitespace around it kept. */
  const clarity = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const at = value.indexOf(trimmed[0]);
    return value.slice(0, at) + trimmed.length.toString(36) + value.slice(at + trimmed.length);
  };
  const encoded = (root: Element) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => clarity(n.textContent!)));
  const attributes = (root: Element) => [...root.querySelectorAll('*')].map((el) => [el.tagName, ...[...el.attributes]
    .filter((a) => !(el.tagName === 'INPUT' && a.name === 'value'))
    .map((a) => `${a.name}=${a.value.replace(/:r[0-9a-z]+:|«r[0-9a-z]+»/g, ':id:')}`).sort()].join(' '));

  it('a no-break space pad would leak through Clarity; the word joiner does not', () => {
    expect(clarity('Normal\u00a0\u00a0')).not.toBe(clarity('Elevated'));
    expect(clarity('Normal\u2060\u2060')).toBe(clarity('Elevated'));
  });

  it('every stage and value leaves the block\'s text identical as Clarity encodes it, and the same attributes (one canvas) but the advice\'s `hidden` with no card', async () => {
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1980, birthMonth: 1, sex: 'male' }, {}, data.getShownErase());
    const seen = STAGES.map(([sys, dia]) => {
      const { container, unmount } = render(<BloodPressureWidget />);
      enterPair(1, sys, dia);
      const out = { lengths: encoded(container), attrs: attributes(container), stage: shown('.hr-widget-sr, .hr-widget-status') };
      unmount();
      return out;
    });
    expect(new Set(seen.map((s) => s.stage)).size).toBe(5);
    expect(seen[0].attrs.filter((a) => a.startsWith('CANVAS'))).toHaveLength(1);
    // The one attribute that differs: the advice is hidden with no card (Brad 2026-11-19; the page's height says as much).
    const hasCard = STAGES.map(([sys, dia]) => bpTierOf(Number(sys), Number(dia)));
    const withoutHidden = (attrs: string[]) => attrs.map((a) => a.replace(/ hidden=/, ''));
    for (const [i, each] of seen.entries()) {
      expect(each.lengths).toEqual(seen[0].lengths);
      expect(withoutHidden(each.attrs)).toEqual(withoutHidden(seen[0].attrs));
      expect(each.attrs.some((a) => a.startsWith('DIV') && a.includes('hidden='))).toBe(!hasCard[i]);
    }
  });

  it('the fixed widths hold the longest text each can be: every tier card at its longest fits the advice width', () => {
    // The longest form of each card: three-digit halves, a known adult (medicine sentences), potassium safe (an eGFR) and the weight paragraph.
    const longest = (sys: number, dia: number) => calculateHealthResults(
      { heightCm: 178, weightKg: 110, waistCm: 120, sex: 'male', birthYear: 1960, birthMonth: 1, creatinine: 80, systolicBp: sys, diastolicBp: dia },
    ).suggestions.filter((s) => s.category === 'blood_pressure');
    const cards = [...longest(250, 150), ...longest(179, 119), ...longest(139, 89)];
    expect(cards.map((c) => c.id).sort()).toEqual(['bp-crisis', 'bp-stage1', 'bp-stage2']);
    for (const card of cards) expect(card.description.length).toBeLessThanOrEqual(WIDTH.advice);
    expect('250/150'.length).toBe(WIDTH.value);
    expect('Stage 2 range'.length).toBe(WIDTH.tier);
  });
});

// US-16 AC2a (lead H18): the widget's save carries the erase the page showed when the save was asked (BloodPressure.tsx
// `save`); a record at another erase by the time it runs takes nothing.
describe('US-16 AC2a: the blood pressure save writes under the erase it was asked under', () => {
  const day = '2026-09-02';
  const NONE = { sys: null, dia: null };
  async function erasedSinceAsked() {
    data.markEraseShown(data.getEraseIdentity());
    const asked = data.getShownErase();
    expect((await data.deleteUserData()).success).toBe(true);
    data.markEraseShown(data.getEraseIdentity());
    await data.flushRoadmapStore();
    return asked;
  }

  it('asked before an erase the page now shows: nothing written, the record unchanged', async () => {
    const asked = await erasedSinceAsked();
    const before = JSON.stringify(data.recordFileSync());
    expect(await savePair({ sys: 128, dia: 82 }, day, NONE, asked)).toEqual({ kind: 'changed' });
    expect(JSON.stringify(data.recordFileSync())).toBe(before);
  });

  it('control: asked under the erase shown, the pair is kept', async () => {
    await erasedSinceAsked();
    expect(await savePair({ sys: 128, dia: 82 }, day, NONE, data.getShownErase())).toMatchObject({ kind: 'kept' });
    expect(active('systolic_bp')).toEqual([128]);
  });
});

// US-75 AC8 (lead H404): a reading belongs to the erase the page showed as its first digit was typed, as the full
// app's fields; a save that runs under a newer erase writes nothing, as a changed row (AC5).
describe('US-75 AC8: a reading is saved under the erase shown as it was typed', () => {
  /** Another tab erased the record; the page's mark shows the erased one (as another block's root moves it), and
   *  this widget's tree has not yet followed. */
  async function erasedElsewhere() {
    expect((await data.deleteUserData()).success).toBe(true);
    data.markEraseShown(data.getEraseIdentity());
    await data.flushRoadmapStore();
  }
  const follow = async () => {
    fireEvent.click(screen.getByRole('link'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };

  it('typed before an erase, saved after it: nothing written, and the next step stays', async () => {
    const navigate = vi.fn();
    render(<BloodPressureWidget nextUrl="/next" navigate={navigate} />);
    enterPair(1, '128', '82');
    await erasedElsewhere();
    const before = JSON.stringify(data.recordFileSync());
    await leave();
    await follow();
    expect(JSON.stringify(data.recordFileSync())).toBe(before);
    expect(active('systolic_bp')).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('control: with no erase between typing and saving, the same save lands and the next step goes', async () => {
    const navigate = vi.fn();
    render(<BloodPressureWidget nextUrl="/next" navigate={navigate} />);
    enterPair(1, '128', '82');
    await leave();
    await follow();
    expect(active('systolic_bp')).toEqual([128]);
    expect(navigate).toHaveBeenCalledWith('/next');
  });

  it('typed again after the refused save, once the widget has followed the erase: kept', async () => {
    render(<BloodPressureWidget />);
    enterPair(1, '128', '82');
    await erasedElsewhere();
    await leave();
    expect(active('systolic_bp')).toEqual([]);
    // The re-read's news reaches the widget: it starts over under the erase shown now (FollowErase).
    act(() => { window.dispatchEvent(new CustomEvent(REMOTE_CHANGED_EVENT, { detail: { erase: data.getEraseIdentity() } })); });
    expect(box(1, 'top').value).toBe('');
    enterPair(1, '130', '84');
    await leave();
    expect(active('systolic_bp')).toEqual([130]);
  });
});

describe('US-75 AC5: the saves state, event by event', () => {
  const typing = (edits: number, kept: number, dropped: number): Saves => ({ kind: 'typing', edits, kept, dropped });
  const settled = (edits: number, kept: number, dropped: number): Saves => ({ kind: 'settled', edits, kept, dropped });
  const table: Array<[string, Saves, SavesEvent, Saves]> = [
    ['the first keystroke: typing', NO_SAVES, { type: 'typed' }, typing(1, 0, 0)],
    ['a later keystroke: still typing', typing(1, 0, 0), { type: 'typed' }, typing(2, 0, 0)],
    ['the newest edit kept: settled', typing(2, 0, 0), { type: 'kept', seq: 2 }, settled(2, 2, 0)],
    ['an older edit kept, a newer waiting: still typing', typing(3, 0, 0), { type: 'kept', seq: 2 }, typing(3, 2, 0)],
    ['the newest edit dropped: settled, nothing kept', typing(2, 0, 0), { type: 'dropped', seq: 2 }, settled(2, 0, 2)],
    ['an older edit dropped, a newer waiting: still typing', typing(3, 1, 0), { type: 'dropped', seq: 2 }, typing(3, 1, 2)],
    ['typing after a drop', settled(2, 0, 2), { type: 'typed' }, typing(3, 0, 2)],
    ['typing after a keep', settled(2, 2, 0), { type: 'typed' }, typing(3, 2, 0)],
    ['a late answer never moves a count back', settled(4, 4, 3), { type: 'kept', seq: 2 }, settled(4, 4, 3)],
    ['a drop answered while settled stays settled', settled(3, 1, 0), { type: 'dropped', seq: 3 }, settled(3, 1, 3)],
    ['an older edit kept once a newer one is dropped: settled', settled(3, 0, 3), { type: 'kept', seq: 2 }, settled(3, 2, 3)],
    ['typing after a drop, with an earlier edit kept', settled(3, 1, 3), { type: 'typed' }, typing(4, 1, 3)],
  ];
  it.each(table)('%s', (_, from, event, to) => {
    expect(transition(from, event)).toEqual(to);
  });
});
