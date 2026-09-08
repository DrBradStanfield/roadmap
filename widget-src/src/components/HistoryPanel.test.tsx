// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
const { charts, event } = vi.hoisted(() => ({ charts: [] as any[], event: vi.fn() }));
vi.mock('chart.js', () => ({
  Chart: class { static register() {} constructor(_canvas: unknown, config: unknown) { charts.push(config); } destroy() {} },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: async () => [{ id: 'm1', metricType: 'ldl', value: 3, recordedAt: '2026-08-01' }],
  loadLabValues: async () => [],
  loadMedicationHistory: vi.fn(async () => ['started', 'dose_changed', 'stopped'].map((changeType, i) => ({
    id: `h${i}`, medicationKey: 'statin', drugName: changeType === 'stopped' ? 'none' : 'atorvastatin',
    doseValue: 20, doseUnit: 'mg', changeType,
    // Start and dose change an hour apart share a pixel on a two-month axis; the stop is two weeks on.
    recordedAt: ['2026-09-07T12:00:00Z', '2026-09-07T13:00:00Z', '2026-09-21T12:00:00Z'][i],
  }))),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: event }));
import { HistoryPanel } from './HistoryPanel';
import { loadMedicationHistory } from '../lib/roadmap-data';
afterEach(() => { cleanup(); charts.length = 0; event.mockClear(); });
describe('US-06 AC4: rendered medication timeline', () => {
  it('includes later events with one old measurement; same-date changes remain readable and toggle off', async () => {
    const { container, getByLabelText } = render(<HistoryPanel initialMetric="ldl" />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(3));
    const chart = charts.at(-1);
    expect(chart.options.scales.x.min).toBeLessThan(Date.parse('2026-09-07T12:00:00Z'));
    expect(chart.options.scales.x.max).toBeGreaterThan(Date.parse('2026-09-21T12:00:00Z'));
    // Every line marks its actual date; readable descriptions live below the chart.
    const pins = Object.values(chart.options.plugins.annotation.annotations) as Array<{ xMin: number; label: { display: boolean; content: string; z: number } }>;
    expect(pins.map(pin => pin.xMin)).toEqual(['2026-09-07T12:00:00Z', '2026-09-07T13:00:00Z', '2026-09-21T12:00:00Z'].map(Date.parse));
    expect(pins.every(pin => !pin.label.display)).toBe(true);
    fireEvent.focus(container.querySelectorAll('ol.metric-chart-events button')[1]);
    const selected = Object.values(charts.at(-1).options.plugins.annotation.annotations) as typeof pins;
    expect(selected.filter(pin => pin.label.display).map(pin => [pin.xMin, pin.label.content])).toEqual([[Date.parse('2026-09-07T13:00:00Z'), '2']]);
    const entries = [...container.querySelectorAll('ol.metric-chart-events li')].map(li => li.textContent);
    expect(entries.map(text => text?.split(': ').slice(1).join(': '))).toEqual([
      'Recorded start: Atorvastatin 20mg', 'Recorded dose change: Atorvastatin 20mg', 'Recorded stop: Statin',
    ]);
    expect(event).toHaveBeenCalledWith('medication_history_viewed');
    expect(event.mock.calls.every(args => args.length === 1)).toBe(true);
    fireEvent.click(getByLabelText('Show recorded medication changes'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(charts.at(-1).options.plugins.annotation).toBeUndefined();
  });
  it('US-06 AC4: dense same-day events keep all descriptions and show only the chosen marker number', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `dense-${i}`, medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', changeType: 'started',
      recordedAt: i < 99 ? '2026-09-07T12:00:00Z' : '2026-09-13T12:00:00Z',
    }));
    vi.mocked(loadMedicationHistory).mockResolvedValueOnce(rows);
    const { container } = render(<HistoryPanel initialMetric="ldl" />);
    await waitFor(() => expect(container.querySelectorAll('ol.metric-chart-events button')).toHaveLength(100));
    const buttons = container.querySelectorAll('ol.metric-chart-events button');
    for (const index of [0, 8, 98, 99]) {
      fireEvent.click(buttons[index]);
      const pins = Object.values(charts.at(-1).options.plugins.annotation.annotations) as Array<{ xMin: number; label: { display: boolean; content: string; z: number } }>;
      expect(pins.filter(pin => pin.label.display).every(pin => pin.label.z > 0)).toBe(true);
      expect(pins.filter(pin => pin.label.display).map(pin => [pin.xMin, pin.label.content])).toEqual([
        [Date.parse(rows[index].recordedAt), String(index + 1)],
      ]);
      expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    }
  });

});
