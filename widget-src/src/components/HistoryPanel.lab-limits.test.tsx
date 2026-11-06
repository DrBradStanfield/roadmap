// @vitest-environment jsdom
// US-12 AC20: on the history charts a limit is a hollow dot at its bound,
// left out of the line, and its tooltip reads with its symbol.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { LIMIT_NOT_GRADED } from '@roadmap/health-core';
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

it('US-12 AC21: on the value page, a limit\'s colour and note always agree, blood pressure rows included', () => {
  const vital = (id: string, metricType: string, value: number, day: string, comparator?: '<' | '>') =>
    ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'lab_import', ...(comparator ? { comparator } : {}) }) as any;
  const ctx = { grading: { sex: 'male' as const }, plan: { age: 50, idealBodyWeight: 70, heightCm: 180 }, unitOf: () => 'si' as const };
  const page = (subject: any, history: any[]) => render(<ValuePage subject={subject} history={history} labValues={[]} ctx={ctx}
    onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>);
  // Weight "> 90" against a 70 kg ideal: certainly red, so no "cannot grade"; "> 70" is open: no colour, the note.
  const weights = page({ kind: 'core', metric: 'weight' }, [vital('w1', 'weight', 90, '2026-07-01', '>'), vital('w2', 'weight', 70, '2026-08-01', '>')]);
  const cells = [...weights.container.querySelectorAll('.md-history .bt-cell-value')];
  expect(cells.map(c => [c.querySelector('.bt-value-num')?.textContent, c.getAttribute('title')])).toEqual([['> 70.0', LIMIT_NOT_GRADED], ['> 90.0', null]]);
  cleanup();
  // Blood pressure "< 125/78": open, so no colour and the note; "< 110/< 70" certainly on target.
  const bp = page({ kind: 'bp' }, [vital('s1', 'systolic_bp', 125, '2026-08-01', '<'), vital('d1', 'diastolic_bp', 78, '2026-08-01'),
    vital('s2', 'systolic_bp', 110, '2026-07-01', '<'), vital('d2', 'diastolic_bp', 70, '2026-07-01', '<')]);
  const pairs = [...bp.container.querySelectorAll('.md-history-value')];
  expect(pairs.map(p => [p.className.replace('md-history-value ', ''), p.getAttribute('title')])).toEqual([['md-status-none', LIMIT_NOT_GRADED], ['md-status-ok', null]]);
  expect(pairs[0].textContent).toContain('< 125/78');
});


it('US-12 AC20a: a blood pressure value page draws each half printed as a limit hollow, off its line', async () => {
  const vital = (id: string, metricType: string, value: number, day: string, comparator?: '<') =>
    ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'lab_import', ...(comparator ? { comparator } : {}) }) as any;
  // Jun: exact 130/85. Jul: "< 125/78", the systolic alone a limit. Aug: "118/< 70", the diastolic alone.
  render(<ValuePage subject={{ kind: 'bp' }} history={[
    vital('s1', 'systolic_bp', 130, '2026-06-01'), vital('d1', 'diastolic_bp', 85, '2026-06-01'),
    vital('s2', 'systolic_bp', 125, '2026-07-01', '<'), vital('d2', 'diastolic_bp', 78, '2026-07-01'),
    vital('s3', 'systolic_bp', 118, '2026-08-01'), vital('d3', 'diastolic_bp', 70, '2026-08-01', '<'),
  ]} labValues={[]} ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>);
  await waitFor(() => expect(charts.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
  const [systolic, diastolic] = charts.slice(-2).map(c => c.data.datasets);
  expect(systolic[0].data.map((p: { y: number }) => p.y)).toEqual([130, 118]);
  expect(systolic[1].pointBackgroundColor).toBe('transparent');
  expect(systolic[1].data.map((p: { y: number; limit: string }) => [p.y, p.limit])).toEqual([[125, '< 125']]);
  expect(diastolic[0].data.map((p: { y: number }) => p.y)).toEqual([85, 78]);
  expect(diastolic[1].data.map((p: { y: number; limit: string }) => [p.y, p.limit])).toEqual([[70, '< 70']]);
});
