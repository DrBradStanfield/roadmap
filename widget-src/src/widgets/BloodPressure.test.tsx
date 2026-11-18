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
import { computePlan } from '@roadmap/health-core/plan';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { PRESSURE_ORDER } from '@roadmap/health-core/validation';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { BloodPressureWidget, WIDTH } from './BloodPressure';

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
const box = (n: 1 | 2, half: 'top' | 'bottom') => reading(n).getByLabelText(half === 'top' ? /^Top number/ : /^Bottom number/) as HTMLInputElement;
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
      ['119', '79', 'Normal'], ['120', '79', 'Elevated'], ['129', '79', 'Elevated'], ['130', '79', 'Stage 1 hypertension'],
      ['110', '80', 'Stage 1 hypertension'], ['139', '89', 'Stage 1 hypertension'], ['140', '70', 'Stage 2 hypertension'],
      ['110', '90', 'Stage 2 hypertension'], ['179', '119', 'Stage 2 hypertension'], ['180', '70', 'Hypertensive crisis'], ['125', '120', 'Hypertensive crisis'],
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
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1955, birthMonth: 1, sex: 'male' }, {});
    render(<BloodPressureWidget />);
    enterPair(1, '135', '85');
    enterPair(2, '131', '81');
    const text = advice();
    await leave();
    expect([active('systolic_bp'), active('diastolic_bp')]).toEqual([[133], [83]]);
    const card = tierCard(persisted());
    expect(card?.id).toBe('bp-stage1');
    expect(text).toBe(card!.description); // exactly, line breaks and all
    expect(text).toContain('Target is <130/80'); // 65 or older
    // Never reworded: the DOM text is the description, line breaks and all.
  });

  it('AC4: Normal and Elevated show no card; with no height on the record the stage shows and no card', () => {
    render(<BloodPressureWidget />);
    enterPair(1, '150', '95');
    expect(shown('.hr-widget-sr, .hr-widget-status')).toBe('Stage 2 hypertension');
    expect(advice()).toBe('');
  });

  it('AC4: Normal shows no card with a plan; crisis shows the plan\'s crisis card', async () => {
    await data.saveChangedMeasurements({ heightCm: 170 }, {});
    render(<BloodPressureWidget />);
    enterPair(1, '118', '76');
    expect(advice()).toBe('');
    enterPair(1, '185', '100');
    expect(advice()).toMatch(/^Your BP of 185\/100 mmHg is dangerously high\./);
  });

  it('AC5: saves the average as today\'s pair; a later change the same day corrects today\'s rows', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
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
    await data.addMeasurement('systolic_bp', 128, OLD);
    await data.addMeasurement('diastolic_bp', 82, OLD);
    await data.flushRoadmapStore();
    render(<BloodPressureWidget />);
    expect([box(1, 'top').value, box(1, 'bottom').value]).toEqual(['128', '82']);
    expect(screen.getByText(`from ${formatShortDate('2026-01-10')}`)).toBeTruthy();
    expect(shown('.hr-widget-v')).toBe('128/82 mmHg');
    await leave();
    expect(rows('systolic_bp').map((m) => m.value)).toEqual([128]);
    // Once a reading is typed, the older day's is left out of the average and the save.
    enterPair(2, '120', '70');
    expect(shown('.hr-widget-v')).toBe('120/70 mmHg');
    await leave();
    expect(active('systolic_bp').sort()).toEqual([120, 128]);
  });

  it('AC3: today\'s reading prefills with no note, and counts in the average', async () => {
    await data.addMeasurement('systolic_bp', 130);
    await data.addMeasurement('diastolic_bp', 80);
    render(<BloodPressureWidget />);
    expect(screen.queryByText(/^from /)).toBeNull();
    enterPair(2, '140', '90');
    expect(shown('.hr-widget-v')).toBe('135/85 mmHg');
    await leave();
    expect(active('systolic_bp')).toEqual([135]);
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

  it('every stage and value leaves the block\'s text identical as Clarity encodes it, and the same attributes (one canvas)', async () => {
    await data.saveChangedMeasurements({ heightCm: 178, birthYear: 1980, birthMonth: 1, sex: 'male' }, {});
    const seen = STAGES.map(([sys, dia]) => {
      const { container, unmount } = render(<BloodPressureWidget />);
      enterPair(1, sys, dia);
      const out = { lengths: encoded(container), attrs: attributes(container), stage: shown('.hr-widget-sr, .hr-widget-status') };
      unmount();
      return out;
    });
    expect(new Set(seen.map((s) => s.stage)).size).toBe(5);
    expect(seen[0].attrs.filter((a) => a.startsWith('CANVAS'))).toHaveLength(1);
    for (const each of seen.slice(1)) {
      expect(each.lengths).toEqual(seen[0].lengths);
      expect(each.attrs).toEqual(seen[0].attrs);
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
    expect('Stage 2 hypertension'.length).toBe(WIDTH.tier);
  });
});
