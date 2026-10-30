// @vitest-environment jsdom
/**
 * US-06 AC4a: a history chart is drawn again only when what it shows changes.
 * Ticking another metric's box leaves it alone, and choosing a medication
 * change in its list shows that change's number on the same chart, with no
 * redraw. With reduced motion asked for, charts appear without the draw-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
const chart = vi.hoisted(() => ({ made: [] as any[], destroyed: 0, updates: [] as unknown[] }));
vi.mock('chart.js', () => ({
  Chart: class {
    static register() {}
    options: any;
    constructor(_canvas: unknown, config: { options: unknown }) { chart.made.push(config); this.options = config.options; }
    destroy() { chart.destroyed++; }
    update(mode?: unknown) { chart.updates.push(mode); }
  },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: async () => [
    { id: 'l1', metricType: 'ldl', value: 3, recordedAt: '2026-08-01' },
    { id: 'l2', metricType: 'ldl', value: 2.4, recordedAt: '2026-10-01' },
    { id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-08-01' },
  ],
  loadLabValues: async () => [
    { id: 'z1', metricName: 'Zinc', value: 12, unit: 'µmol/L', recordedAt: '2026-08-01' },
    { id: 'z2', metricName: 'Zinc', value: 13, unit: 'µmol/L', recordedAt: '2026-09-01' },
    { id: 'z3', metricName: 'Zinc', value: 14, unit: 'µmol/L', recordedAt: '2026-10-01' },
  ],
  loadMedicationHistory: async () => ['started', 'dose_changed'].map((changeType, i) => ({
    id: `h${i}`, medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20 + 20 * i, doseUnit: 'mg', changeType,
    recordedAt: ['2026-08-15T12:00:00Z', '2026-09-15T12:00:00Z'][i],
  })),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
import { HistoryPanel } from './HistoryPanel';

afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  chart.made.length = 0; chart.destroyed = 0; chart.updates.length = 0;
});

const ldlCharts = () => chart.made.filter(c => c.data.datasets[0].data.length === 2);
const labCharts = () => chart.made.filter(c => c.data.datasets[0].data.length === 3);
const shownNumbers = (config: any) =>
  Object.values(config.options.plugins.annotation.annotations as Record<string, { label: { display: boolean; content: string } }>)
    .filter(pin => pin.label.display).map(pin => pin.label.content);

async function open() {
  const view = render(<HistoryPanel />);
  await waitFor(() => expect(view.container.querySelectorAll('ol.metric-chart-events button')).toHaveLength(2));
  await waitFor(() => expect(ldlCharts().length).toBeGreaterThan(0));
  return view;
}

describe('US-06 AC4a — history charts are not redrawn for nothing', () => {
  it('US-06 AC4a: ticking another metric\'s box leaves the LDL and lab charts as they are', async () => {
    const view = await open();
    await waitFor(() => expect(view.container.querySelectorAll('canvas')).toHaveLength(3));
    const made = ldlCharts().length;
    const madeLab = labCharts().length;
    const destroyed = chart.destroyed;
    fireEvent.click(view.getByRole('checkbox', { name: /Weight/ }));
    await waitFor(() => expect(view.container.querySelectorAll('canvas')).toHaveLength(2));
    expect(ldlCharts()).toHaveLength(made);
    expect(labCharts()).toHaveLength(madeLab);
    expect(chart.destroyed).toBe(destroyed + 1); // the weight chart only
  });

  it('US-06 AC4a: choosing a medication change shows its number on the same chart, without a redraw', async () => {
    const view = await open();
    const made = chart.made.length;
    const destroyed = chart.destroyed;
    fireEvent.focus(view.container.querySelectorAll('ol.metric-chart-events button')[1]);
    expect(chart.made).toHaveLength(made);
    expect(chart.destroyed).toBe(destroyed);
    expect(shownNumbers(ldlCharts().at(-1))).toEqual(['2']);
    expect(chart.updates.at(-1)).toBe('none');
    fireEvent.click(view.container.querySelectorAll('ol.metric-chart-events button')[0]);
    expect(chart.made).toHaveLength(made);
    expect(shownNumbers(ldlCharts().at(-1))).toEqual(['1']);
  });

  it('US-06 AC4a: with reduced motion asked for, charts are drawn without animation', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
    await open();
    expect(chart.made.every(c => c.options.animation === false)).toBe(true);
  });

  it('US-06 AC4a control: without it, charts keep their default animation', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    await open();
    expect(chart.made.some(c => c.options.animation === false)).toBe(false);
  });
});
