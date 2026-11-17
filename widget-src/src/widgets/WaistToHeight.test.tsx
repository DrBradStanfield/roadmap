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

  it('AC2: the units switch converts the boxes, and a US entry saves in cm and kg', async () => {
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
    expect(file.profile.heightCm).toBeCloseTo(177.8, 6);
    expect(file.measurements.find((m) => m.metricType === 'weight')!.value).toBeCloseTo(81.65, 2);
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
