// @vitest-environment jsdom
/**
 * US-74, the widget as a visitor sees it, over a real RoadmapStore: the
 * boxes, live results, the automatic save on the full app's timings, the
 * events, the notices and the next-step link. Each "review" test names the
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
import { NEXT_STEP_DEFAULT, NOT_SAVED, WaistToHeightWidget } from './WaistToHeight';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

const OLD = '2026-01-10T00:00:00.000Z';
let cloud: MemoryCloud;
const persisted = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
const active = (metric: string) => persisted().measurements.filter((m) => m.metricType === metric && m.status === 'active').map((m) => m.value);
const box = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.input(box(label), { target: { value } });
/** Enter in a box: every entry saves now (US-74 AC4). */
const enter = (label: RegExp = /^Height|^Feet/) => fireEvent.keyDown(box(label), { key: 'Enter' });
/** Leave the waist and weight boxes, as a tap elsewhere does: they commit, as the vitals grid's cells do. */
const leaveDays = () => fireEvent.focusIn(document.body);
const saved = () => screen.findByText('Saved');
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
  it('AC2: prefills height, weight and waist from the record, each with the day it comes from (review X2)', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('weight', 82, OLD);
    await data.addMeasurement('waist', 90);
    render(<WaistToHeightWidget />);
    expect([box(/^Height/).value, box(/^Weight/).value, box(/^Waist/).value]).toEqual(['178', '82', '90']);
    expect(screen.getByText(`from ${formatShortDate('2026-01-10')}`)).toBeTruthy();
    expect(screen.getByText('today')).toBeTruthy();
    type(/^Weight/, '80'); // an entry is the person's: no longer the record's day
    expect(screen.queryByText(`from ${formatShortDate('2026-01-10')}`)).toBeNull();
  });

  it('AC3: results show as soon as a height and a waist or weight are in, before any save, with the widget\'s own labels', () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '170');
    expect(screen.queryByText('Waist-to-height ratio')).toBeNull();
    type(/^Weight/, '78.03');
    type(/^Waist/, '81.6');
    expect(screen.getByText('Waist-to-height ratio')).toBeTruthy();
    expect(screen.getByText('0.48')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('Body mass index (BMI)')).toBeTruthy();
    expect(screen.getByText('27')).toBeTruthy();
    expect(screen.getByText('Normal')).toBeTruthy(); // BMI 27 with a healthy ratio, as the plan reads it
    expect(screen.getByText('Target waist circumference')).toBeTruthy();
    expect(screen.getByText('<85 cm')).toBeTruthy();
    expect(screen.getByLabelText(/^Waist circumference/)).toBeTruthy();
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
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
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
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect([box(/^Feet/).value, box(/^Inches/).value, box(/^Weight/).value]).toEqual(['5', '10', '176']);
    type(/^Weight/, '180');
    enter(/^Weight/);
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
    expect(active('weight')[0]).toBeCloseTo(81.65, 2);
  });

  it('a save that throws says Not saved and keeps the drafts', async () => {
    vi.spyOn(RoadmapStore.prototype, 'saveChangedMeasurements').mockRejectedValue(new Error('storage down'));
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    enter();
    expect((await screen.findByRole('alert')).textContent).toBe(NOT_SAVED);
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
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Feet/, '9');
    enter(/^Feet/);
    const error = await screen.findByText(/^Height must be at most/);
    expect(screen.getByRole('group', { name: 'Height' })).toBeTruthy();
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
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('weight', 82, OLD);
    await data.addMeasurement('waist', 90, OLD);
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
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Waist/, '35');
    enter(/^Waist/);
    await saved();
    expect(persisted().profile.heightCm).toBe(178);
  });

  it.each([
    [88.1, 'Healthy'], // 0.4949 rounds to 0.49
    [88.2, 'Elevated'], // 0.4955 rounds to 0.50: both boxes show "88"
  ])('A2: today\'s unchanged waist of %s cm at 178 cm reads %s, as the plan reads the record', async (waist, grade) => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('waist', waist);
    render(<WaistToHeightWidget />);
    expect(box(/^Waist/).value).toBe('88');
    expect(screen.getByText(grade)).toBeTruthy();
  });

  it('A3, C8: a store that cannot keep the record says Not saved, keeps the drafts, counts nothing; the next save goes through', async () => {
    const failing = new MemoryAdapter(cloud);
    await data.initRoadmapStore(failing);
    const write = vi.spyOn(failing, 'write').mockRejectedValue(new Error('disk full'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    enter();
    expect((await screen.findByRole('alert')).textContent).toBe(NOT_SAVED);
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

  it('A4, A5, X1: a waist changed elsewhere is kept; the box shows it, the notice says to type a new value, and only that replaces it', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    const first = await data.addMeasurement('waist', 90);
    render(<WaistToHeightWidget />);
    if (first.status !== 'inserted') throw new Error('seed');
    await data.correctValue(first.row.id, 92); // another tab, unseen by this page
    type(/^Height/, '175');
    type(/^Waist/, '88');
    enter();
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Saved: height.');
    expect(notice.textContent).toContain('Not saved: waist circumference. It changed on another device or tab, so the box now shows the saved value. Type a new value to replace it.');
    expect(box(/^Waist/).value).toBe('92');
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
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    render(<WaistToHeightWidget />);
    await data.saveChangedMeasurements({ heightCm: 180 }, { heightCm: 178 });
    type(/^Height/, '175');
    enter();
    expect((await screen.findByRole('alert')).textContent).toContain('Not saved: height.');
    expect(box(/^Height/).value).toBe('180');
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
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect(box(/^Waist/).value).toBe('88 cm');
    await data.flushRoadmapStore();
    expect(cloud.files.has(ROADMAP_FILE_NAME) ? active('waist') : []).toEqual([]);
  });

  it('A6, C11: a fractional US inches entry is refused, never truncated, and the Inches box takes the focus', async () => {
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Feet/, '5');
    type(/^Inches/, '10.5');
    enter(/^Inches/);
    expect(await screen.findByText('Enter a number')).toBeTruthy();
    expect(document.activeElement).toBe(box(/^Inches/));
    await pause(700);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('C4: "88.0" typed over a waist filled with 88 is no entry: no row, no saved event', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('waist', 88, OLD);
    render(<WaistToHeightWidget />);
    type(/^Waist/, '88.0');
    enter();
    await pause(50);
    await data.flushRoadmapStore();
    expect(persisted().measurements.filter((m) => m.metricType === 'waist')).toHaveLength(1);
    expect(calls('waist_widget_saved')).toEqual([]);
  });

  it('C5: 50 in typed over today\'s 127.4 cm (shown as 50.2 in) is written, and counted', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('waist', 127.4);
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect(box(/^Waist/).value).toBe('50.2');
    type(/^Waist/, '50');
    enter(/^Waist/);
    await saved();
    expect(active('waist')).toEqual([toCanonicalValue('waist', 50, 'conventional')]);
    expect(calls('waist_widget_saved')).toHaveLength(1);
  });

  it('C6: a box typed in while its save is on its way keeps the new text; the save does not say Saved over it', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
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
    await screen.findByText('Saving…');
    type(/^Waist/, '91');
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(box(/^Waist/).value).toBe('91');
    expect(screen.queryByText('Saved')).toBeNull();
    leaveDays();
    await saved();
    expect(active('waist')).toEqual([91]);
  });

  it('P1 and B: a Healthy and an Elevated result give the block the same classes, styles and attributes', () => {
    const snapshot = (waist: string) => {
      const { container, unmount } = render(<WaistToHeightWidget />);
      type(/^Height/, '178');
      type(/^Waist/, waist);
      expect(screen.getByText(waist === '80' ? 'Healthy' : 'Elevated')).toBeTruthy();
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
    expect(screen.getByText('<89 cm')).toBeTruthy();
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
  });
});
