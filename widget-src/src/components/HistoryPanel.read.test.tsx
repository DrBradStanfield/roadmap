// @vitest-environment jsdom
/**
 * US-06 AC4 / US-21 AC3b: what the history lightbox shows as its three reads
 * (vitals, labs, medications) land. Each read is held open here and released
 * by the test, so the order they land in is the test's choice.
 * The last block is US-21 AC3c: the boxes ticked on open never depend on that order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  charts: [] as any[], event: vi.fn(), captureException: vi.fn(),
  loadAllHistory: vi.fn(), loadLabValues: vi.fn(), loadMedicationHistory: vi.fn(),
}));
vi.mock('chart.js', () => ({
  Chart: class { static register() {} constructor(_canvas: unknown, config: unknown) { mocks.charts.push(config); } destroy() {} update() {} },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: mocks.event }));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: mocks.loadAllHistory, loadLabValues: mocks.loadLabValues, loadMedicationHistory: mocks.loadMedicationHistory,
}));
import { HistoryPanel } from './HistoryPanel';

// Synthetic values. "Zonulin" is off the lab catalogue, so its label is its own name.
const VITALS = [
  { id: 'l1', metricType: 'ldl', value: 3, recordedAt: '2026-08-01' },
  { id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-08-01' },
];
const LABS = [{ id: 'z1', metricName: 'Zonulin', value: 40, unit: 'ng/mL', recordedAt: '2026-08-01' }];
const STATIN = [{
  id: 'h1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', changeType: 'started',
  recordedAt: '2026-09-07T12:00:00Z',
}];

type Read = 'vitals' | 'labs' | 'meds';
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let reads: Record<Read, ReturnType<typeof deferred>>;
beforeEach(() => {
  reads = { vitals: deferred(), labs: deferred(), meds: deferred() };
  mocks.loadAllHistory.mockImplementation(() => reads.vitals.promise);
  mocks.loadLabValues.mockImplementation(() => reads.labs.promise);
  mocks.loadMedicationHistory.mockImplementation(() => reads.meds.promise);
});
afterEach(() => { cleanup(); mocks.charts.length = 0; vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });

async function land(read: Read, rows: unknown) { await act(async () => { reads[read].resolve(rows); }); }
async function landAll(vitals: unknown = VITALS, labs: unknown = LABS, meds: unknown = []) {
  await act(async () => { reads.vitals.resolve(vitals); reads.labs.resolve(labs); reads.meds.resolve(meds); });
}
const box = (view: ReturnType<typeof render>, name: string) => view.getByRole('checkbox', { name }) as HTMLInputElement;
const ticked = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLInputElement>('.metric-selector input')].filter(input => input.checked)
    .map(input => input.closest('label')!.textContent);

describe('US-06 AC4: the history lightbox once its reads land together (pins)', () => {
  it('shows Loading history until the reads land', () => {
    const view = render(<HistoryPanel />);
    expect(view.getByText('Loading history...')).toBeTruthy();
  });

  it('ready: every vital and every lab test is ticked and charted', async () => {
    const view = render(<HistoryPanel />);
    await landAll();
    expect(view.queryByText('Loading history...')).toBeNull();
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Weight', 'Zonulin']);
    expect(view.container.querySelectorAll('.metric-chart-container h3')).toHaveLength(3);
    expect(view.getByText('Additional Lab Results')).toBeTruthy();
  });

  it('opened on one metric: only that vital is ticked; every lab test is ticked', async () => {
    const view = render(<HistoryPanel initialMetric="weight" />);
    await landAll();
    expect(ticked(view)).toEqual(['Weight', 'Zonulin']);
  });

  it('opened from ?metric= (the Shopify page): only that vital is ticked', async () => {
    window.history.replaceState(null, '', '/?metric=ldl');
    const view = render(<HistoryPanel />);
    await landAll();
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Zonulin']);
  });

  it('a metric with no rows ticks every vital, as with none asked for', async () => {
    const view = render(<HistoryPanel initialMetric="hba1c" />);
    await landAll();
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Weight', 'Zonulin']);
  });

  it('a tick the person changes stays changed', async () => {
    const view = render(<HistoryPanel />);
    await landAll();
    fireEvent.click(box(view, 'Weight'));
    fireEvent.click(box(view, 'Zonulin'));
    expect(ticked(view)).toEqual(['LDL Cholesterol']);
    fireEvent.click(box(view, 'Zonulin'));
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Zonulin']);
  });

  it('empty: no rows anywhere says so', async () => {
    const view = render(<HistoryPanel />);
    await landAll([], null, []);
    expect(view.getByText('No measurements recorded yet.')).toBeTruthy();
  });

  it('US-21 AC3b failed: a failed vitals read shows the heading only, even when labs land, and reports tags only', async () => {
    const error = new Error('read failed');
    const view = render(<HistoryPanel />);
    await act(async () => { reads.vitals.reject(error); reads.labs.resolve(LABS); reads.meds.resolve(STATIN); });
    expect(view.container.querySelector('.history-panel')!.textContent).toBe('Health History');
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException).toHaveBeenCalledWith(error, { tags: { area: 'cloud-sync', op: 'load' } });
  });

  it('a failed lab read leaves the vitals charted and no lab section', async () => {
    const view = render(<HistoryPanel />);
    await act(async () => { reads.vitals.resolve(VITALS); reads.labs.reject(new Error('read failed')); reads.meds.resolve([]); });
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Weight']);
    expect(view.queryByText('Additional Lab Results')).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it('medication_history_viewed fires once when a chart with a marker is shown', async () => {
    const view = render(<HistoryPanel initialMetric="ldl" />);
    await landAll(VITALS, [], STATIN);
    expect(view.getByText(/Recorded start: Atorvastatin 20mg/)).toBeTruthy();
    expect(mocks.event.mock.calls).toEqual([['medication_history_viewed']]);
  });

  it('medication_history_viewed waits until a chart with a marker is ticked', async () => {
    const view = render(<HistoryPanel initialMetric="weight" />);
    await landAll(VITALS, [], STATIN);
    expect(mocks.event).not.toHaveBeenCalled();
    fireEvent.click(box(view, 'LDL Cholesterol'));
    expect(mocks.event.mock.calls).toEqual([['medication_history_viewed']]);
  });
});

describe('US-21 AC3c: the ticks on open do not depend on which read lands last', () => {
  it.each<[Read, Read, Read]>([
    ['vitals', 'meds', 'labs'],
    ['labs', 'meds', 'vitals'],
    ['vitals', 'labs', 'meds'],
  ])('%s, then %s, then %s: every vital and lab test is ticked', async (...order) => {
    const rows: Record<Read, unknown> = { vitals: VITALS, labs: LABS, meds: [] };
    const view = render(<HistoryPanel />);
    for (const read of order) await land(read, rows[read]);
    await waitFor(() => expect(view.queryByText('Loading history...')).toBeNull());
    expect(ticked(view)).toEqual(['LDL Cholesterol', 'Weight', 'Zonulin']);
  });

  it('labs landing last: a lab chart is drawn on open', async () => {
    const view = render(<HistoryPanel />);
    await land('vitals', VITALS);
    await land('meds', []);
    await land('labs', LABS);
    expect(view.container.querySelectorAll('.metric-chart-container h3')).toHaveLength(3);
  });
});
