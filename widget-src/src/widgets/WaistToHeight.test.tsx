// @vitest-environment jsdom
/**
 * US-74, the widget as a visitor sees it: the boxes, the one button, the
 * results, the events and the next-step link, over a real RoadmapStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { WaistToHeightWidget } from './WaistToHeight';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

let cloud: MemoryCloud;
const persisted = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
const box = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(box(label), { target: { value } });
const press = () => fireEvent.click(screen.getByRole('button', { name: 'See my results' }));

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
  await data.flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('US-74 waist-to-height and BMI widget', () => {
  it('AC2: prefills height, weight and waist from the record', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('weight', 82, '2026-01-10T00:00:00.000Z');
    await data.addMeasurement('waist', 90, '2026-01-10T00:00:00.000Z');
    render(<WaistToHeightWidget />);
    expect([box(/^Height/).value, box(/^Weight/).value, box(/^Waist/).value]).toEqual(['178', '82', '90']);
  });

  it('AC5 (review P2): a save sends exactly these analytics calls, no value, and nothing else leaves the page', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    type(/^Waist/, '90');
    press();
    await screen.findByText('Waist-to-Height');
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([
      ['waist_widget_viewed'],
      ['measurement_added', { measure: 'waist' }], // the full app's own counter: the measure's name, never a value
      ['waist_widget_saved'],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('review P3: a save with no waist is not counted as a ratio saved', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    press();
    await screen.findByText('BMI');
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('waist_widget_saved');
  });

  it('AC5: counts a view and a save by name alone, never a value', async () => {
    render(<WaistToHeightWidget />);
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([['waist_widget_viewed']]);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    press();
    await screen.findByText('Waist-to-Height');
    const calls = vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name.startsWith('waist_widget_'));
    expect(calls).toEqual([['waist_widget_viewed'], ['waist_widget_saved']]);
  });

  it('AC3: shows the ratio, its grade, BMI with the composite reading, and the target waist', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '170');
    type(/^Weight/, '78.03');
    type(/^Waist/, '81.6');
    press();
    await screen.findByText('Waist-to-Height');
    expect(screen.getByText('0.48')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('27')).toBeTruthy();
    expect(screen.getByText('Normal')).toBeTruthy(); // BMI 27 with a healthy ratio, as the plan reads it
    expect(screen.getByText('Target: <85 cm')).toBeTruthy();
    expect(screen.queryByText(/Ideal Body Weight|Protein/)).toBeNull();
  });

  it('AC2: an out-of-range value is refused with the full app\'s words and nothing is written', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '300');
    press();
    expect(await screen.findByText('Height must be at most 250 cm')).toBeTruthy();
    expect(screen.queryByText('Waist-to-Height')).toBeNull();
    await data.flushRoadmapStore();
    expect(cloud.files.has(ROADMAP_FILE_NAME) ? persisted().profile.heightCm ?? null : null).toBeNull();
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('waist_widget_saved');
  });

  it('AC2: the units switch converts the boxes; a typed height keeps its exact value (review A1), a US weight saves in kg', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Weight/, '80');
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect([box(/^Feet/).value, box(/^Inches/).value, box(/^Weight/).value]).toEqual(['5', '10', '176']);
    type(/^Weight/, '180');
    press();
    await screen.findByText('BMI');
    await data.flushRoadmapStore();
    const file = persisted();
    expect(file.profile.heightCm).toBe(178);
    expect(file.measurements.find((m) => m.metricType === 'weight')!.value).toBeCloseTo(81.65, 2);
  });

  it('a save that throws says it was not saved and gives the button back', async () => {
    vi.spyOn(RoadmapStore.prototype, 'saveChangedMeasurements').mockRejectedValue(new Error('storage down'));
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    press();
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved. Reload the page and try again.');
    const button = screen.getByRole('button', { name: 'See my results' });
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(screen.queryByText('Waist-to-Height')).toBeNull();
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('waist_widget_saved');
  });

  it('the results arrive in a live region already on the page, and the button keeps focus while saving', async () => {
    const { container } = render(<WaistToHeightWidget />);
    const region = container.querySelector('output[aria-live="polite"]')!;
    expect(region.textContent).toBe('');
    type(/^Height/, '178');
    type(/^Waist/, '90');
    const button = screen.getByRole('button', { name: 'See my results' });
    button.focus();
    press();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    await screen.findByText('Waist-to-Height');
    expect(container.querySelector('output[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toContain('Target: <89 cm');
  });

  it('AC2: a US height out of range marks both its boxes, in a group named for the height', async () => {
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Feet/, '9');
    press();
    const error = await screen.findByText(/^Height must be at most/);
    expect(screen.getByRole('group', { name: 'Height (ft/in)' })).toBeTruthy();
    for (const label of [/^Feet/, /^Inches/]) {
      expect(box(label).getAttribute('aria-invalid')).toBe('true');
      expect(box(label).getAttribute('aria-describedby')).toBe(error.id);
    }
  });

  it('AC6: the next-step link shows after a result, and only when it is set', async () => {
    const { unmount } = render(<WaistToHeightWidget nextUrl="/pages/roadmap" nextLabel="See your full plan" />);
    expect(screen.queryByRole('link')).toBeNull();
    type(/^Height/, '178');
    press();
    expect((await screen.findByRole('link', { name: 'See your full plan' })).getAttribute('href')).toBe('/pages/roadmap');
    type(/^Waist/, '90'); // an edit hides the results and the link with them
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    press();
    await screen.findByText('Target: <89 cm');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('AC6: an unsafe link is never shown', async () => {
    render(<WaistToHeightWidget nextUrl="javascript:alert(1)" nextLabel="Go" />);
    type(/^Height/, '178');
    press();
    await screen.findByText('Target: <89 cm');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('US-74 review fixes', () => {
  const OLD = '2026-01-10T00:00:00.000Z';
  const today = () => new Date().toISOString().slice(0, 10);

  it('A1: pressing over values only filled from the record writes nothing and dates nothing today', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.addMeasurement('weight', 82, OLD);
    await data.addMeasurement('waist', 90, OLD);
    await data.flushRoadmapStore();
    const before = persisted();
    render(<WaistToHeightWidget />);
    press();
    await screen.findByText('Waist-to-Height');
    await data.flushRoadmapStore();
    expect(persisted().measurements).toEqual(before.measurements);
    expect(persisted().measurements.some((m) => m.recordedAt.startsWith(today()))).toBe(false);
    expect(persisted().profile).toEqual(before.profile);
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('waist_widget_saved');
  });

  it('A1: a record height of 178 cm pressed in the US view stays exactly 178', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Waist/, '35');
    press();
    await screen.findByText('Waist-to-Height');
    await data.flushRoadmapStore();
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
    press();
    await screen.findByText('Waist-to-Height');
    expect(screen.getByText(grade)).toBeTruthy();
  });

  it('A3: a store that cannot keep the record says Not saved, keeps the drafts and counts nothing', async () => {
    const failing = new MemoryAdapter(cloud);
    await data.initRoadmapStore(failing);
    const write = vi.spyOn(failing, 'write').mockRejectedValue(new Error('disk full'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '90');
    press();
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved. Reload the page and try again.');
    expect([box(/^Height/).value, box(/^Waist/).value]).toEqual(['178', '90']);
    expect(screen.queryByText('Waist-to-Height')).toBeNull();
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('waist_widget_saved');
    // The store recovers: a press again saves the person's own entries, with no conflict against itself.
    write.mockRestore();
    setItem.mockRestore();
    press();
    await screen.findByText('Waist-to-Height');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('A4 and A5: a waist changed elsewhere is not overwritten; the box shows it and the notice says what was kept', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    const first = await data.addMeasurement('waist', 90);
    render(<WaistToHeightWidget />);
    if (first.status !== 'inserted') throw new Error('seed');
    await data.correctValue(first.row.id, 92); // another tab, unseen by this page
    type(/^Height/, '175');
    type(/^Waist/, '88');
    press();
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Saved: height.');
    expect(notice.textContent).toContain('Not saved: waist. It changed on another device or tab');
    expect(box(/^Waist/).value).toBe('92');
    await data.flushRoadmapStore();
    const active = () => persisted().measurements.filter((m) => m.metricType === 'waist' && m.status === 'active').map((m) => m.value);
    expect(active()).toEqual([92]);
    expect(persisted().profile.heightCm).toBe(175);
    // Seen now: an unedited press keeps 92; a new entry replaces the row the person saw.
    press();
    await screen.findByText('Waist-to-Height');
    await data.flushRoadmapStore();
    expect(active()).toEqual([92]);
    type(/^Waist/, '88');
    press();
    await screen.findByText('Waist-to-Height');
    await data.flushRoadmapStore();
    expect(active()).toEqual([88]);
  });

  it('A4: a height changed elsewhere is not overwritten; its box shows the record\'s', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    render(<WaistToHeightWidget />);
    await data.saveChangedMeasurements({ heightCm: 180 }, { heightCm: 178 });
    type(/^Height/, '175');
    press();
    expect((await screen.findByRole('alert')).textContent).toContain('Not saved: height.');
    expect(box(/^Height/).value).toBe('180');
    await data.flushRoadmapStore();
    expect(persisted().profile.heightCm).toBe(180);
  });

  it('A6: unreadable text is an error on its box, never a blank; nothing is saved', async () => {
    render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '88 cm');
    press();
    await screen.findByText('Type one decimal number, without signs, < > or spaces');
    expect(box(/^Waist/).getAttribute('aria-invalid')).toBe('true');
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
    // The draft survives a unit switch, as typed.
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect(box(/^Waist/).value).toBe('88 cm');
  });

  it('A6: a fractional US inches entry is refused, never truncated', async () => {
    render(<WaistToHeightWidget />);
    fireEvent.click(screen.getByRole('radio', { name: 'US' }));
    type(/^Feet/, '5');
    type(/^Inches/, '10.5');
    press();
    expect(await screen.findByText('Enter a number')).toBeTruthy();
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(false);
  });

  it('P1: no class names the grade, so a Clarity replay cannot read it', async () => {
    const { container } = render(<WaistToHeightWidget />);
    type(/^Height/, '178');
    type(/^Waist/, '95');
    press();
    await screen.findByText('Elevated');
    const classes = [...container.querySelectorAll('[class]')].map((el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/normal|info|attention|urgent|elevated|healthy|status--/i);
    expect(screen.getByText('Elevated').className).toBe('hr-widget-status');
  });

  it('U1: two blocks on one page never share an id', () => {
    const { container } = render(<><WaistToHeightWidget /><WaistToHeightWidget /></>);
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('U2: a link set with a blank label reads "Next step"', async () => {
    render(<WaistToHeightWidget nextUrl="/pages/health-plan" nextLabel="  " />);
    type(/^Height/, '178');
    press();
    expect((await screen.findByRole('link', { name: 'Next step' })).getAttribute('href')).toBe('/pages/health-plan');
  });

  it('U3: a link to another site is never shown', async () => {
    render(<WaistToHeightWidget nextUrl="https://drstanfield.com/pages/roadmap" nextLabel="Go" />);
    type(/^Height/, '178');
    press();
    await screen.findByText('Target: <89 cm');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('U6: a press with errors moves the focus to the first box at fault; arrow keys switch the units', async () => {
    render(<WaistToHeightWidget />);
    type(/^Waist/, 'abc');
    press();
    await screen.findByText('Required');
    expect(document.activeElement).toBe(box(/^Height/));
    const metric = screen.getByRole('radio', { name: 'Metric' });
    fireEvent.keyDown(metric, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'US' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'US' }));
  });
});
