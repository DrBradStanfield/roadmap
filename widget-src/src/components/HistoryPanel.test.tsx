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
  loadMedicationHistory: async () => ['started', 'dose_changed', 'stopped'].map((changeType, i) => ({
    id: `h${i}`, medicationKey: 'statin', drugName: changeType === 'stopped' ? 'none' : 'atorvastatin',
    doseValue: 20, doseUnit: 'mg', changeType,
    // Start and dose change an hour apart share a pixel on a two-month axis; the stop is two weeks on.
    recordedAt: ['2026-09-07T12:00:00Z', '2026-09-07T13:00:00Z', '2026-09-21T12:00:00Z'][i],
  })),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: event }));
import { HistoryPanel } from './HistoryPanel';
afterEach(() => { cleanup(); charts.length = 0; event.mockClear(); });
describe('US-06 AC4: rendered medication timeline', () => {
  it('includes later events with one old measurement; same-date changes remain readable and toggle off', async () => {
    const { container, getByLabelText } = render(<HistoryPanel initialMetric="ldl" />);
    await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(3));
    const chart = charts.at(-1);
    expect(chart.options.scales.x.min).toBeLessThan(Date.parse('2026-09-07T12:00:00Z'));
    expect(chart.options.scales.x.max).toBeGreaterThan(Date.parse('2026-09-21T12:00:00Z'));
    // Changes recorded close together share one pin whose label lists both entry numbers.
    const pins = Object.values(chart.options.plugins.annotation.annotations) as Array<{ label: { content: string } }>;
    expect(pins.map(pin => pin.label.content)).toEqual(['1, 2', '3']);
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
});
