// @vitest-environment jsdom
/**
 * US-21 AC3a: the history lightbox never draws one line through an additional
 * test's values that were reported in different units. Such a test shows the
 * same "Units vary between reports" note the results table shows, and no line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
const { charts } = vi.hoisted(() => ({ charts: [] as any[] }));
vi.mock('chart.js', () => ({
  Chart: class { static register() {} constructor(_canvas: unknown, config: unknown) { charts.push(config); } destroy() {} },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
// Synthetic values. "Zonulin", "Calprotectin" and "Elastase" are off the lab catalogue, so
// they keep the unit they were reported in.
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: async () => [],
  loadLabValues: async () => [
    { id: 'z1', metricName: 'Zonulin', value: 75, unit: 'nmol/L', recordedAt: '2026-03-01' },
    { id: 'z2', metricName: 'Zonulin', value: 30, unit: 'ng/mL', recordedAt: '2026-09-01' },
    { id: 'c1', metricName: 'Calprotectin', value: 40, unit: 'ug/g', recordedAt: '2026-03-01' },
    { id: 'c2', metricName: 'Calprotectin', value: 55, unit: 'µg/g', recordedAt: '2026-09-01' },
    { id: 'e1', metricName: 'Elastase', value: 210, unit: 'µg/g', recordedAt: '2026-03-01' },
    { id: 'e2', metricName: 'Elastase', value: 190, unit: 'µg/g', recordedAt: '2026-09-01' },
  ],
  loadMedicationHistory: async () => [],
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
import { HistoryPanel } from './HistoryPanel';

afterEach(() => { cleanup(); charts.length = 0; });

const chartHeading = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll('.metric-chart-container')].find(c => c.querySelector('h3')?.textContent === title);

describe('US-21 AC3a — mixed units in the history lightbox', () => {
  it('US-21 AC3a: a test reported in two units shows the note and draws no line', async () => {
    const { container } = render(<HistoryPanel />);
    await waitFor(() => expect(chartHeading(container, 'Elastase')).toBeTruthy());
    const zonulin = chartHeading(container, 'Zonulin');
    expect(zonulin).toBeTruthy();
    expect(zonulin!.textContent).toContain('Units vary between reports');
    expect(zonulin!.querySelector('canvas')).toBeNull();
    await waitFor(() => expect(charts).toHaveLength(2));
    expect(charts.some(c => c.data.datasets[0].data.some((p: { y: number }) => p.y === 75))).toBe(false);
  });

  it('US-21 AC3a: two spellings of one unit are one line, labelled with the shown unit', async () => {
    const { container } = render(<HistoryPanel />);
    await waitFor(() => expect(charts.length).toBeGreaterThan(0));
    expect(chartHeading(container, 'Calprotectin')!.textContent).not.toContain('Units vary between reports');
    const chart = charts.find(c => c.data.datasets[0].data.some((p: { y: number }) => p.y === 40));
    expect(chart.data.datasets[0].data.map((p: { y: number }) => p.y)).toEqual([40, 55]);
    expect(chart.options.scales.y.title.text).toBe('µg/g');
  });

  it('US-21 AC3a control: a test in one unit is charted as before', async () => {
    render(<HistoryPanel />);
    await waitFor(() => expect(charts.length).toBeGreaterThan(0));
    const chart = charts.find(c => c.data.datasets[0].data.some((p: { y: number }) => p.y === 210));
    expect(chart.data.datasets[0].data.map((p: { y: number }) => p.y)).toEqual([210, 190]);
    expect(chart.options.scales.y.title.text).toBe('µg/g');
  });
});
