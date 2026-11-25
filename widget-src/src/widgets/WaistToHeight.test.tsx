// @vitest-environment jsdom
/**
 * US-74, the widget as a visitor sees it, over a real RoadmapStore: the
 * boxes, live results, the automatic save on the full app's timings, the
 * events and the next-step link; nothing on the page talks about saving. Each "review" test names the
 * finding it pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { toCanonicalValue } from '@roadmap/health-core/units';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { NEXT_STEP_DEFAULT, WaistToHeightWidget } from './WaistToHeight';
import { INCHES_OVER } from './boxes';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

const OLD = '2026-01-10T00:00:00.000Z';
let cloud: MemoryCloud;
const persisted = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
const active = (metric: string) => persisted().measurements.filter((m) => m.metricType === metric && m.status === 'active').map((m) => m.value);
const box = (label: RegExp) => screen.getByLabelText(label, { selector: 'input' }) as HTMLInputElement;
const toUS = () => fireEvent.click(screen.getByRole('radio', { name: 'US' }));
const type = (label: RegExp, value: string) => fireEvent.input(box(label), { target: { value } });
/** Enter in a box: every entry saves now (US-74 AC4). */
const enter = (label: RegExp = /^Height|^Feet/) => fireEvent.keyDown(box(label), { key: 'Enter' });
/** Leave the waist and weight boxes, as a tap elsewhere does: they commit, as the vitals grid's cells do. */
const leaveDays = () => fireEvent.focusIn(document.body);
/** Saves end with no word on the page (Brad 2026-11-18): wait past the height's 500 ms timer, then for the store. */
const saved = async () => { await pause(600); await act(() => data.flushRoadmapStore()); };
/** Nothing in the block talks about saving: no status, alert or notice, shown or for screen readers. */
const quiet = (root: Element) => { expect(root.textContent).not.toMatch(/sav/i); expect(root.querySelector('[role="alert"], [role="status"]')).toBeNull(); };
/** A result's text as a person reads it: its zero-width pad (WidgetResults' PAD) left out. */
const shown = (text: string) => screen.getByText(text, { normalizer: (t) => t.replace(/\u2060/g, '').replace(/\s+/g, ' ').trim() });
const calls = (name: string) => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === name);
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

beforeEach(async () => {
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no HTTP')));
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  localStorage.setItem('health_roadmap_unit_system', 'si');
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

describe('US-74 waist-to-height and BMI widget', () => {
  it('AC2: prefills height, weight and waist from the record, an older day\'s with the day it comes from (review X2)', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.addMeasurement('weight', 82, OLD, data.getShownErase());
    await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    render(<WaistToHeightWidget />);
    expect([box(/^Height/).value, box(/^Weight/).value, box(/^Waist/).value]).toEqual(['178', '82', '90']);
    expect(screen.getByText(`from ${formatShortDate('2026-01-10')}`)).toBeTruthy();
    expect(screen.queryByText('today')).toBeNull(); // today's value carries no note (Brad 2026-11-18)
    type(/^Weight/, '80'); // an entry is the person's: no longer the record's day
    expect(screen.queryByText(`from ${formatShortDate('2026-01-10')}`)).toBeNull();
  });

  it('the boxes take numbers only, with the full app\'s own key filter (Brad 2026-11-18)', () => {
    render(<WaistToHeightWidget />);
    for (const label of [/^Height/, /^Waist/, /^Weight/]) {
      expect(fireEvent.keyDown(box(label), { key: 'a' })).toBe(false); // prevented
      expect(fireEvent.keyDown(box(label), { key: '7' })).toBe(true);
      expect(fireEvent.keyDown(box(label), { key: '.' })).toBe(true);
    }
    toUS(); // feet and inches are About you's pair: anything but digits is dropped as typed
    type(/^Feet/, '5.');
    type(/^Inches/, 'a1x');
    expect([box(/^Feet/).value, box(/^Inches/).value]).toEqual(['5', '1']);
  });

  it('AC3: results show as soon as a height and a waist or weight are in, before any save, with the widget\'s own labels', () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '170');
    expect(screen.queryByText('Waist-to-height ratio')).toBeNull();
    type(/^Weight/, '78.03');
    type(/^Waist/, '81.6');
    expect(screen.getByText('Waist-to-height ratio')).toBeTruthy();
    expect(shown('0.48')).toBeTruthy();
    expect(shown('Healthy')).toBeTruthy();
    expect(screen.getByText('Body mass index (BMI)')).toBeTruthy();
    expect(shown('27')).toBeTruthy();
    expect(shown('Normal')).toBeTruthy(); // BMI 27 with a healthy ratio, as the plan reads it
    expect(screen.getByText('Target waist circumference')).toBeTruthy();
    expect(shown('<85 cm')).toBeTruthy();
    expect(screen.getByLabelText(/^Waist \(/)).toBeTruthy();
    expect(screen.queryByText(/Ideal Body Weight|Protein/)).toBeNull();
    expect(screen.queryByRole('button', { name: /See my results/ })).toBeNull(); // no button (Brad 2026-11-18)
  });

  it('AC4: the height saves itself 500 ms after it is typed, as About you saves it; a half-typed height never does', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '17');
    await pause(700);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    type(/^Height/, '178');
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
  });

  it('AC4: weight and waist save when their boxes are left, as the vitals grid commits, not while typed', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    render(<WaistToHeightWidget />);
    type(/^Waist/, '9');
    type(/^Waist/, '90');
    await pause(700);
    expect(cloud.files.has(ROADMAP_FILE_NAME) ? active('waist') : []).toEqual([]);
    leaveDays();
    await saved();
    expect(active('waist')).toEqual([90]);
    // A later change the same day corrects today's row: one active row, no chain of rows.
    type(/^Waist/, '89');
    leaveDays();
    await saved();
    expect(active('waist')).toEqual([89]);
    expect(persisted().measurements.filter((m) => m.metricType === 'waist')).toHaveLength(2);
  });

  it('AC5 (review P2): a save sends exactly these analytics calls, no value, and nothing else leaves the page', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    type(/^Waist/, '90');
    enter();
    await saved();
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([
      ['waist_widget_viewed'],
      ['measurement_added', { measure: 'waist' }], // the full app's own counter: the measure's name, never a value
      ['waist_widget_saved'],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('review P3: a save with no waist is not counted as a ratio saved; waist_widget_saved goes once per page view', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    enter();
    await saved();
    expect(calls('waist_widget_saved')).toEqual([]);
    type(/^Waist/, '90');
    enter();
    await saved();
    type(/^Waist/, '91');
    enter();
    await saved();
    expect(calls('waist_widget_saved')).toEqual([['waist_widget_saved']]);
  });

  it('AC2: an out-of-range value shows the full app\'s words once the box is left, and is never written', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '300');
    enter();
    expect(await screen.findByText('Height must be at most 250 cm')).toBeTruthy();
    await pause(700);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('AC2: the units switch converts the boxes; a typed height keeps its exact value (review A1), a US weight saves in kg', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    toUS();
    expect([box(/^Feet/).value, box(/^Inches/).value, box(/^Weight/).value]).toEqual(['5', '10', '176']);
    type(/^Weight/, '180');
    enter(/^Weight/);
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
    expect(active('weight')[0]).toBeCloseTo(81.65, 2);
  });

  it('B2: a save that throws says nothing and keeps the drafts', async () => {
    vi.spyOn(RoadmapStore.prototype, 'saveChangedMeasurements').mockRejectedValue(new Error('storage down'));
    const { container } = render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    enter();
    await saved();
    quiet(container);
    expect(box(/^Height/).value).toBe('178');
  });

  it('the results arrive in a live region already on the page', () => {
    const { container } = render(<WaistToHeightWidget />);
    const region = container.querySelector('output[aria-live="polite"]')!;
    expect(region.textContent).toBe('');
    type(/^Height/, '178');
    type(/^Waist/, '90');
    expect(container.querySelector('output[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toContain('<89 cm');
  });

  it('AC2: a US height out of range marks both its boxes, in a group named for the height', async () => {
    render(<WaistToHeightWidget />);
    toUS();
    type(/^Feet/, '9');
    enter(/^Feet/);
    const error = await screen.findByText(/^Height must be at most/);
    expect(screen.getByRole('group', { name: 'Height (ft, in)' })).toBeTruthy();
    for (const label of [/^Feet/, /^Inches/]) {
      expect(box(label).getAttribute('aria-invalid')).toBe('true');
      expect(box(label).getAttribute('aria-describedby')).toBe(error.id);
    }
  });

  it('AC6: the next-step link shows with a result, and only when set', () => {
    const { unmount } = render(<WaistToHeightWidget nextUrl="/pages/roadmap" nextLabel="See your full plan" />);
    type(/^Height/, '178');
    expect(screen.queryByRole('link')).toBeNull();
    type(/^Waist/, '90');
    expect(screen.getByRole('link', { name: 'See your full plan' }).getAttribute('href')).toBe('/pages/roadmap');
    unmount();
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('US-74 review fixes', () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it('A1: Enter over values only filled from the record writes nothing and dates nothing today', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.addMeasurement('weight', 82, OLD, data.getShownErase());
    await data.addMeasurement('waist', 90, OLD, data.getShownErase());
    await data.flushRoadmapStore();
    const before = persisted();
    render(<WaistToHeightWidget />);
    enter();
    leaveDays();
    await pause(700);
    await data.flushRoadmapStore();
    expect(persisted().measurements).toEqual(before.measurements);
    expect(persisted().measurements.some((m) => m.recordedAt.startsWith(today()))).toBe(false);
    expect(persisted().profile).toEqual(before.profile);
    expect(calls('waist_widget_saved')).toEqual([]);
  });

  it('A1: a record height of 178 cm, with a waist saved in the US view, stays exactly 178', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    render(<WaistToHeightWidget />);
    toUS();
    type(/^Waist/, '35');
    enter(/^Waist/);
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
  });

  it.each([
    [88.1, 'Healthy'], // 0.4949 rounds to 0.49
    [88.2, 'Elevated'], // 0.4955 rounds to 0.50: both boxes show "88"
  ])('A2: today\'s unchanged waist of %s cm at 178 cm reads %s, as the plan reads the record', async (waist, grade) => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.addMeasurement('waist', waist, undefined, data.getShownErase());
    render(<WaistToHeightWidget />);
    expect(box(/^Waist/).value).toBe('88');
    expect(shown(grade)).toBeTruthy();
  });

  it('A3, C8: a store that cannot keep the record keeps the drafts, says nothing, counts nothing; the next save goes through', async () => {
    const failing = new MemoryAdapter(cloud);
    await data.initRoadmapStore(failing);
    const write = vi.spyOn(failing, 'write').mockRejectedValue(new Error('disk full'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const { container } = render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    enter();
    await pause(100);
    quiet(container);
    expect([box(/^Height/).value, box(/^Waist/).value]).toEqual(['178', '90']);
    expect(calls('waist_widget_saved')).toEqual([]);
    expect(calls('measurement_added')).toEqual([]);
    write.mockRestore();
    setItem.mockRestore();
    enter();
    await saved();
    expect(calls('measurement_added')).toEqual([['measurement_added', { measure: 'waist' }]]);
    expect(calls('waist_widget_saved')).toHaveLength(1);
  });

  it('A4, A5, X1: a waist changed elsewhere is kept; the box shows it, nothing is said, and only a new value typed replaces it', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    const first = await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    render(<WaistToHeightWidget />);
    if (first.status !== 'inserted') throw new Error('seed');
    await data.correctValue(first.row.id, 92, data.getShownErase()); // another tab, unseen by this page
    type(/^Height/, '175');
    type(/^Waist/, '88');
    enter();
    await waitFor(() => expect(box(/^Waist/).value).toBe('92'));
    expect(screen.queryByRole('alert')).toBeNull();
    await data.flushRoadmapStore();
    expect(active('waist')).toEqual([92]);
    expect(persisted().profile.heightCm).toBe(175);
    enter(); // nothing new typed: nothing replaced
    await pause(50);
    await data.flushRoadmapStore();
    expect(active('waist')).toEqual([92]);
    type(/^Waist/, '88');
    enter();
    await saved();
    expect(active('waist')).toEqual([88]);
  });

  it('A4: a height changed elsewhere is not overwritten; its box shows the record\'s', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    render(<WaistToHeightWidget />);
    await data.saveChangedMeasurements({ heightCm: 180 }, { heightCm: 178 }, data.getShownErase());
    type(/^Height/, '175');
    enter();
    await waitFor(() => expect(box(/^Height/).value).toBe('180'));
    expect(screen.queryByRole('alert')).toBeNull();
    await data.flushRoadmapStore();
    expect(persisted().profile.heightCm).toBe(180);
  });

  it('A6: unreadable text is an error on its box, never a blank; nothing is saved; the draft survives a unit switch', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '88 cm');
    enter(/^Waist/);
    await screen.findByText('Type one decimal number, without signs, < > or spaces');
    expect(box(/^Waist/).getAttribute('aria-invalid')).toBe('true');
    toUS();
    expect(box(/^Waist/).value).toBe('88 cm');
    await data.flushRoadmapStore();
    expect(cloud.files.has(ROADMAP_FILE_NAME) ? active('waist') : []).toEqual([]);
  });

  it('C4: "88.0" typed over a waist filled with 88 is no entry: no row, no saved event', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.addMeasurement('waist', 88, OLD, data.getShownErase());
    render(<WaistToHeightWidget />);
    type(/^Waist/, '88.0');
    enter();
    await pause(50);
    await data.flushRoadmapStore();
    expect(persisted().measurements.filter((m) => m.metricType === 'waist')).toHaveLength(1);
    expect(calls('waist_widget_saved')).toEqual([]);
  });

  it('C5: 50 in typed over today\'s 127.4 cm (shown as 50.2 in) is written, and counted', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.addMeasurement('waist', 127.4, undefined, data.getShownErase());
    render(<WaistToHeightWidget />);
    toUS();
    expect(box(/^Waist/).value).toBe('50.2');
    type(/^Waist/, '50');
    enter(/^Waist/);
    await saved();
    expect(active('waist')).toEqual([toCanonicalValue('waist', 50, 'conventional')]);
    expect(calls('waist_widget_saved')).toHaveLength(1);
  });

  it('C6: a box typed in while its save is on its way keeps the new text, and the next leave saves it', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    await data.flushRoadmapStore();
    const slow = new MemoryAdapter(cloud);
    await data.initRoadmapStore(slow);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realWrite = slow.write.bind(slow);
    vi.spyOn(slow, 'write').mockImplementation(async (...args: Parameters<typeof slow.write>) => { await gate; return realWrite(...args); });
    render(<WaistToHeightWidget />);
    type(/^Waist/, '90');
    leaveDays();
    await pause(20); // the save is on its way, held at the store's write
    type(/^Waist/, '91');
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    await pause(50);
    expect(box(/^Waist/).value).toBe('91');
    leaveDays();
    await saved();
    expect(active('waist')).toEqual([91]);
  });

  it('P1 and B: a Healthy and an Elevated result give the block the same classes, styles and attributes', () => {
    const snapshot = (waist: string) => {
      const { container, unmount } = render(<WaistToHeightWidget />);
      type(/^Height/, '178');
      type(/^Waist/, waist);
      expect(shown(waist === '80' ? 'Healthy' : 'Elevated')).toBeTruthy();
      const attrs = [...container.querySelectorAll('*')].map((el) => [el.tagName, ...[...el.attributes]
        // Input values are the person's typing, which Clarity masks; the ids differ only by React's per-render prefix.
        .filter((a) => !(el.tagName === 'INPUT' && a.name === 'value'))
        .map((a) => `${a.name}=${a.value.replace(/:r[0-9a-z]+:/g, ':id:')}`).sort()].join(' '));
      unmount();
      return attrs;
    };
    const healthy = snapshot('80');
    const elevated = snapshot('95');
    expect(healthy.filter((a) => a.startsWith('CANVAS'))).toHaveLength(2);
    expect(elevated).toEqual(healthy);
  });

  it('U1: two blocks on one page never share an id', () => {
    const { container } = render(<><WaistToHeightWidget /><WaistToHeightWidget /></>);
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('U2: a link set with a blank label reads "Next step"', () => {
    render(<WaistToHeightWidget nextUrl="/pages/health-plan" nextLabel="  " />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    expect(screen.getByRole('link', { name: NEXT_STEP_DEFAULT }).getAttribute('href')).toBe('/pages/health-plan');
  });

  it.each(['https://drstanfield.com/pages/roadmap', 'javascript:alert(1)', '/\t/evil.com'])('U3, X6: a link to %j is never shown', (url) => {
    render(<WaistToHeightWidget nextUrl={url} nextLabel="Go" />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    expect(shown('<89 cm')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('U6: Enter with errors moves the focus to the first box at fault; arrow keys switch the units', async () => {
    render(<WaistToHeightWidget />);
    type(/^Waist/, 'abc');
    enter(/^Waist/);
    await screen.findByText('Required');
    expect(document.activeElement).toBe(box(/^Height/));
    const metric = screen.getByRole('radio', { name: 'Metric' });
    fireEvent.keyDown(metric, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'US' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'US' }));
    expect(screen.queryByRole('button', { name: /^(cm|ft\/in)$/ })).toBeNull(); // the full app's pill is not drawn here
  });
});

describe('US-74 B1: a complete height moves on to the waist at once (Brad 2026-11-18)', () => {
  /** Type into a box with the focus in it, as a person does. */
  const typeIn = (label: RegExp, value: string) => { box(label).focus(); type(label, value); };
  const waistFocused = () => document.activeElement === box(/^Waist/);
  /** The full app's helper moves the focus a frame later. */
  const frame = () => pause(30);

  it('metric: the third digit of a height in range moves on at once; "17" never does', async () => {
    render(<WaistToHeightWidget />);
    typeIn(/^Height/, '17');
    await pause(900);
    expect(waistFocused()).toBe(false);
    typeIn(/^Height/, '178');
    await frame();
    expect(waistFocused()).toBe(true);
  });

  it('US: feet move on to inches at once, as About you\'s pair does', async () => {
    render(<WaistToHeightWidget />);
    toUS();
    typeIn(/^Feet/, '5');
    await frame();
    expect(document.activeElement).toBe(box(/^Inches/));
  });

  it.each(['0', '2', '9', '10', '11'])('US: inches "%s" can take no other digit, so they move on at once', async (inches) => {
    render(<WaistToHeightWidget />);
    toUS();
    typeIn(/^Feet/, '5');
    await frame(); // the feet hand the focus on to inches a frame later (About you's pair)
    typeIn(/^Inches/, inches);
    await frame();
    expect(waistFocused()).toBe(true);
  });

  it('US: a lone "1" (1, 10 or 11) waits the helper\'s short time, then moves on; another digit in the wait decides at once', async () => {
    render(<WaistToHeightWidget />);
    toUS();
    typeIn(/^Feet/, '5');
    typeIn(/^Inches/, '1');
    await frame();
    expect(waistFocused()).toBe(false);
    await waitFor(() => expect(waistFocused()).toBe(true), { timeout: 1500 }); // 800 ms
    typeIn(/^Inches/, '1');
    typeIn(/^Inches/, '11');
    await frame();
    expect(waistFocused()).toBe(true);
  });

  it.each([
    ['metric, out of range', 'si', '300'],
    ['metric, too short', 'si', '030'],
    ['US, out of range', 'us', '9/10'],
    ['US, inches over 11', 'us', '5/12'],
    ['US, a lone 1 out of range', 'us', '9/1'],
  ])('no move on a height with an error (%s)', async (_name, units, value) => {
    render(<WaistToHeightWidget />);
    if (units === 'us') {
      toUS();
      const [feet, inches] = value.split('/');
      typeIn(/^Feet/, feet);
      typeIn(/^Inches/, inches);
    } else typeIn(/^Height/, value);
    await pause(900);
    expect(waistFocused()).toBe(false);
  });
});

describe('US-74 fourth review round', () => {
  /** A real paste: the event carries the clipboard's text, and the box changes only if it is not refused. */
  const paste = (label: RegExp, text: string) => {
    const input = box(label);
    input.focus();
    const accepted = fireEvent.paste(input, { clipboardData: { getData: () => text } });
    if (accepted) type(label, input.value + text); // the browser inserts what it was not stopped from
    return accepted;
  };

  it.each(['10.5', '8x', '1 0', '123'])('F2: a paste of "%s" into inches is refused whole, shows the error, and nothing is saved', async (text) => {
    render(<WaistToHeightWidget />);
    toUS();
    type(/^Feet/, '5');
    expect(paste(/^Inches/, text)).toBe(false);
    expect(box(/^Inches/).value).toBe(text); // kept as given, never cut to another number
    expect(screen.getByText('Enter a number')).toBeTruthy();
    expect(box(/^Inches/).getAttribute('aria-invalid')).toBe('true');
    enter(/^Inches/);
    expect(document.activeElement).toBe(box(/^Inches/));
    await saved();
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('F2: a paste of whole digits that fit goes in; a feet paste of two characters is refused', async () => {
    render(<WaistToHeightWidget />);
    toUS();
    expect(paste(/^Feet/, "5'")).toBe(false);
    expect(screen.getByText('Enter a number')).toBeTruthy();
    type(/^Feet/, '5');
    expect(paste(/^Inches/, '10')).toBe(true);
    expect(box(/^Inches/).value).toBe('10');
    await saved();
    expect(persisted().profile.heightCm).toBeCloseTo(177.8, 1);
  });

  it('Codex 1871b R7: two waist blocks on one page are one page view: one viewed event, one saved event', async () => {
    const { container } = render(<><WaistToHeightWidget /><WaistToHeightWidget /></>);
    expect(calls('waist_widget_viewed')).toHaveLength(1);
    const forms = [...container.querySelectorAll('form')];
    for (const form of forms) {
      const [height] = [...form.querySelectorAll<HTMLInputElement>('input[id$="-height"]')];
      const waist = form.querySelector<HTMLInputElement>('input[id$="-waist"]')!;
      fireEvent.input(height, { target: { value: '178' } });
      fireEvent.input(waist, { target: { value: '90' } });
      fireEvent.keyDown(height, { key: 'Enter' });
      await saved();
    }
    expect(calls('waist_widget_saved')).toHaveLength(1);
  });

  it('Codex 1871b R2: a refused paste stays unreadable even where its digits equal the box\'s number ("010" over 5 ft 10 in from 178 cm); nothing is saved', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    toUS(); // before the height's 500 ms save
    expect([box(/^Feet/).value, box(/^Inches/).value]).toEqual(['5', '10']);
    box(/^Inches/).setSelectionRange(0, 2); // the whole box selected, as a paste over it does
    expect(paste(/^Inches/, '010')).toBe(false);
    expect(box(/^Inches/).value).toBe('010');
    expect(screen.getByText('Enter a number')).toBeTruthy();
    await saved();
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('Codex 1871b R2: whitespace in a paste, and a paste that would overfill an occupied box, are refused whole', () => {
    render(<WaistToHeightWidget />);
    toUS();
    expect(paste(/^Inches/, '8 ')).toBe(false);
    expect(box(/^Inches/).value).toBe('8 ');
    type(/^Inches/, '1');
    box(/^Inches/).setSelectionRange(1, 1); // the caret after the 1
    expect(paste(/^Inches/, '23')).toBe(false);
    expect(box(/^Inches/).value).toBe('123');
    type(/^Inches/, '1');
    box(/^Inches/).setSelectionRange(1, 1);
    expect(paste(/^Inches/, '1')).toBe(true); // "11" fits
  });

  it('Codex 1871b R3: 5 ft 12 in is an error on Inches before any conversion: no results, no write', async () => {
    render(<WaistToHeightWidget />);
    toUS();
    type(/^Feet/, '5');
    type(/^Inches/, '12');
    type(/^Waist/, '33');
    enter(/^Inches/);
    expect(await screen.findByText(INCHES_OVER)).toBeTruthy();
    expect(document.activeElement).toBe(box(/^Inches/));
    expect(screen.queryByText('Waist-to-height ratio')).toBeNull();
    await saved();
    expect(cloud.files.has(ROADMAP_FILE_NAME) ? persisted().profile.heightCm : undefined).toBeUndefined();
  });

  it('F3, AC5: a box at fault differs from a good one only by aria-invalid and the error it names; its class never changes', () => {
    const attrs = (input: HTMLInputElement) => Object.fromEntries([...input.attributes].filter((a) => a.name !== 'value').map((a) => [a.name, a.value]));
    render(<WaistToHeightWidget />);
    const good = { height: attrs(box(/^Height/)), waist: attrs(box(/^Waist/)) };
    type(/^Height/, '300');
    type(/^Waist/, 'abc');
    enter();
    const bad = { height: attrs(box(/^Height/)), waist: attrs(box(/^Waist/)) };
    for (const f of ['height', 'waist'] as const) {
      expect(bad[f].class).toBe(good[f].class);
      const changed = Object.keys({ ...good[f], ...bad[f] }).filter((k) => good[f][k] !== bad[f][k]).sort();
      expect(changed.every((k) => k === 'aria-invalid' || k === 'aria-describedby')).toBe(true);
    }
    expect(bad.height['aria-invalid']).toBe('true');
  });

  it('F4: with the switch, the height\'s label names its unit in words and points at the box in use', () => {
    const { container } = render(<WaistToHeightWidget />);
    const label = () => container.querySelector<HTMLLabelElement>('label[id$="-height-label"]')!;
    expect(label().textContent).toBe('Height (cm)');
    expect(label().htmlFor).toBe(box(/^Height/).id);
    toUS();
    expect(label().textContent).toBe('Height (ft, in)');
    expect(label().htmlFor).toBe(box(/^Feet/).id);
    expect(screen.queryByRole('button', { name: /^(cm|ft\/in)$/ })).toBeNull();
  });

  it('F5: a cm box the browser cannot read (validity.badInput, its value blank) says "Enter a number", not "Required"; nothing is saved', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '17'); // then the browser loses what is typed, as "17e" leaves it
    const input = box(/^Height/);
    Object.defineProperty(input, 'validity', { configurable: true, get: () => ({ badInput: true }) });
    fireEvent.input(input, { target: { value: '' } });
    enter();
    expect(await screen.findByText('Enter a number')).toBeTruthy();
    expect(screen.queryByText('Required')).toBeNull();
    await saved();
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });
});

describe('US-74 third review round', () => {
  /** Clarity's encoding of a masked text node (clarity-js src/core/scrub.ts mangleText, read 2026-11-18):
   *  its trimmed length in base 36, the whitespace around it kept as it is. */
  const clarity = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const at = value.indexOf(trimmed[0]);
    return value.slice(0, at) + trimmed.length.toString(36) + value.slice(at + trimmed.length);
  };
  /** Every text node in the block, as Clarity's replay holds it. */
  const encoded = (root: Element) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => clarity(n.textContent!)));

  it('R1 (Codex 1871b R1): every grade, BMI category and value leaves the block\'s text identical as Clarity encodes it', () => {
    // What went wrong before: a no-break space pad is trimmed away, so the grade's length showed through.
    expect(clarity('Healthy\u00a0')).not.toBe(clarity('Elevated'));
    expect(clarity('Healthy\u2060')).toBe(clarity('Elevated'));
    const cases = [
      ['80', '49.1', 'Healthy', 'Underweight range'],
      ['80', '60', 'Healthy', 'Normal'],
      ['80', '78', 'Healthy', 'Normal'], // BMI 27 with a healthy ratio
      ['90', '78', 'Elevated', 'Overweight range'],
      ['95', '95', 'Elevated', 'Obesity range'],
    ];
    const lengths = cases.map(([waist, weight, grade, category]) => {
      const { container, unmount } = render(<WaistToHeightWidget />);
      type(/^Height/, '170');
      type(/^Waist/, waist);
      type(/^Weight/, weight);
      expect(shown(grade)).toBeTruthy();
      expect(shown(category)).toBeTruthy();
      const out = encoded(container);
      unmount();
      return out;
    });
    for (const each of lengths.slice(1)) expect(each).toEqual(lengths[0]);
  });

  it('R1: with no waist, a BMI with no category (25 to 29.9) and one with a category encode the same in Clarity', () => {
    const tile = (weight: string) => {
      const { container, unmount } = render(<WaistToHeightWidget />);
      type(/^Height/, '170');
      type(/^Weight/, weight);
      const out = encoded(container.querySelector('.hr-widget-grid')!);
      unmount();
      return out;
    };
    expect(tile('78')).toEqual(tile('60')); // BMI 27, no category without a waist; BMI 20.8, Normal
  });

  it('R2: a save asked for before a conflict was found does not write over the row that conflict showed', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    const first = await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    render(<WaistToHeightWidget />);
    if (first.status !== 'inserted') throw new Error('seed');
    await data.correctValue(first.row.id, 92, data.getShownErase()); // another tab, unseen
    type(/^Waist/, '88');
    enter(/^Waist/); // save 1
    leaveDays(); // save 2, asked before save 1 found the conflict
    await pause(100);
    await data.flushRoadmapStore();
    expect(active('waist')).toEqual([92]);
    expect(box(/^Waist/).value).toBe('92');
  });

  it('R5: past midnight, a height save does not make the old day\'s weight row the new day\'s expected one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 17, 22, 0));
      await data.addMeasurement('weight', 80, undefined, data.getShownErase());
      render(<WaistToHeightWidget />);
      vi.setSystemTime(new Date(2026, 10, 18, 7, 0));
      type(/^Height/, '178');
      enter();
      await saved();
      type(/^Weight/, '81');
      leaveDays();
      await saved();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(persisted().measurements.filter((m) => m.metricType === 'weight' && m.status === 'active').map((m) => [m.recordedAt.slice(0, 10), m.value]).sort())
        .toEqual([['2026-11-17', 80], ['2026-11-18', 81]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R6: the next-step link saves a height typed a moment ago before it leaves', async () => {
    await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    const navigate = vi.fn(() => { heightAtNavigate = cloud.files.has(ROADMAP_FILE_NAME) ? persisted().profile.heightCm : undefined; });
    let heightAtNavigate: number | undefined;
    render(<WaistToHeightWidget nextUrl="/pages/health-plan" nextLabel="Next" navigate={navigate} />);
    type(/^Height/, '178');
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/pages/health-plan'));
    expect(heightAtNavigate).toBe(178);
  });

  it('live check 2026-11-18: leaving the waist box keeps the height typed with it too', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '84');
    leaveDays();
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
    expect(active('waist')).toEqual([84]);
  });

  it('B2 (Brad 2026-11-18): nothing in the block talks about saving, before, during or after a save, or after a conflict', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {}, data.getShownErase());
    const first = await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    const { container } = render(<WaistToHeightWidget nextUrl="/pages/health-plan" />);
    quiet(container);
    if (first.status !== 'inserted') throw new Error('seed');
    await data.correctValue(first.row.id, 92, data.getShownErase()); // another tab: this save finds a conflict
    type(/^Weight/, '80');
    type(/^Waist/, '88');
    leaveDays();
    quiet(container);
    await saved();
    quiet(container);
    expect(active('weight')).toEqual([80]);
  });

  it('R6: a link whose save fails does not leave, and says nothing', async () => {
    await data.addMeasurement('waist', 90, undefined, data.getShownErase());
    vi.spyOn(RoadmapStore.prototype, 'saveChangedMeasurements').mockRejectedValue(new Error('storage down'));
    const navigate = vi.fn();
    render(<WaistToHeightWidget nextUrl="/pages/health-plan" nextLabel="Next" navigate={navigate} />);
    type(/^Height/, '178');
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    await saved();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('R8: a height that failed to save goes with the next save', async () => {
    vi.spyOn(RoadmapStore.prototype, 'saveChangedMeasurements').mockRejectedValueOnce(new Error('storage down'));
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    enter();
    await pause(100);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    type(/^Waist/, '90');
    leaveDays();
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
    expect(active('waist')).toEqual([90]);
  });
});

