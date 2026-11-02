// @vitest-environment jsdom
// US-12 AC20: on the history charts a limit is a hollow dot at its bound,
// left out of the line, and its tooltip reads with its symbol.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
const { charts } = vi.hoisted(() => ({ charts: [] as any[] }));
vi.mock('chart.js', () => ({
  Chart: class { static register() {} constructor(_canvas: unknown, config: unknown) { charts.push(config); } destroy() {} update() {} },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: async () => [
    { id: 'm1', metricType: 'hdl', value: 1.2, recordedAt: '2026-06-01' },
    { id: 'm2', metricType: 'hdl', value: 60 / 38.67, recordedAt: '2026-07-01', comparator: '>' },
    { id: 'm3', metricType: 'hdl', value: 1.3, recordedAt: '2026-08-01' },
  ],
  loadLabValues: async () => [
    { id: 'v1', metricName: 'Made-up marker 7', value: 3, unit: 'U/L', referenceLow: 1, referenceHigh: 5, recordedAt: '2026-06-01', source: 'lab_import', createdAt: '2026-06-01' },
    { id: 'v2', metricName: 'Made-up marker 7', value: 0.5, unit: 'U/L', referenceLow: 1, referenceHigh: 5, recordedAt: '2026-07-01', source: 'lab_import', createdAt: '2026-07-01', comparator: '<' },
  ],
  loadMedicationHistory: async () => [],
  getShownErase: () => '',
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/storage', async original => ({ ...await original<typeof import('../lib/storage')>(), loadUnitPreference: () => 'si' }));
import { HistoryPanel } from './HistoryPanel';
import { ValuePage } from './ValuePage';
afterEach(() => { cleanup(); charts.length = 0; });

const tooltip = (chart: any, datasetIndex: number, index: number) => {
  const dataset = chart.data.datasets[datasetIndex];
  const raw = dataset.data[index];
  return chart.options.plugins.tooltip.callbacks.label({ raw, parsed: { y: raw.y } });
};

it('US-12 AC20: a core and a lab limit plot hollow, off the line, and read with their symbol', async () => {
  render(<HistoryPanel/>);
  // Both charts mount after the loads settle; a busy runner takes a while.
  const isHdl = (c: any) => c.data.datasets[0].borderColor === '#22c55e';
  await waitFor(() => expect(charts.some(isHdl) && charts.some(c => !isHdl(c))).toBe(true), { timeout: 10_000 });
  const [hdl, lab] = [charts.filter(isHdl).at(-1), charts.filter(c => !isHdl(c)).at(-1)];

  const [line, limits] = hdl.data.datasets;
  expect(line.data).toHaveLength(2);
  expect(line.data.some((p: { limit?: string }) => p.limit)).toBe(false);
  expect(limits.showLine).toBe(false);
  expect(limits.pointBackgroundColor).toBe('transparent');
  expect(limits.data).toHaveLength(1);
  // 60 mg/dL shown in mmol/L, rounded away from the band so it stays true.
  expect(tooltip(hdl, 1, 0)).toBe('> 1.55 mmol/L');
  expect(tooltip(hdl, 0, 0)).toBe('1.2 mmol/L');

  expect(lab.data.datasets[0].data).toHaveLength(1);
  expect(lab.data.datasets[1].data).toHaveLength(1);
  expect(tooltip(lab, 1, 0)).toBe('< 0.5 U/L');
});

it('US-12 AC20: a value page lists a limit with its symbol and charts it hollow, off the line', async () => {
  const ldl = (id: string, value: number, day: string, comparator?: '<') =>
    ({ id, metricType: 'ldl', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'lab_import', ...(comparator ? { comparator } : {}) }) as any;
  const view = render(<ValuePage subject={{ kind: 'core', metric: 'ldl' }} history={[ldl('l1', 2.8, '2026-06-01'), ldl('l2', 1.5, '2026-07-01', '<')]}
    labValues={[]} ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>);
  const shown = [...view.container.querySelectorAll('.md-history .bt-value-num')].map(n => n.textContent);
  expect(shown).toEqual(['< 1.5', '2.8']);
  await waitFor(() => expect(charts.length).toBeGreaterThan(0), { timeout: 10_000 });
  const [line, limits] = charts.at(-1).data.datasets;
  expect(line.data.map((p: { y: number }) => p.y)).toEqual([2.8]);
  expect(limits.data.map((p: { y: number; limit: string }) => [p.y, p.limit])).toEqual([[1.5, '< 1.5']]);
});
