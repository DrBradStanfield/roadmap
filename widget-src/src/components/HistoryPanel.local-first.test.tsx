// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';

const mocks = vi.hoisted(() => ({
  loadAllHistory: vi.fn(), loadLabValues: vi.fn(), loadMedicationHistory: vi.fn(), chart: vi.fn(), captureException: vi.fn(),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: mocks.loadAllHistory,
  loadLabValues: mocks.loadLabValues,
  loadMedicationHistory: mocks.loadMedicationHistory,
}));
vi.mock('chart.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('chart.js')>();
  return { ...original, Chart: class {
    static register() {}
    constructor(_canvas: unknown, config: unknown) { mocks.chart(config); }
    destroy() {}
  } };
});
import { HistoryPanel } from './HistoryPanel';
beforeEach(() => {
  mocks.loadLabValues.mockResolvedValue([]);
  mocks.loadMedicationHistory.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// US-07: local-first history is one complete result, not a server page. Fifty
// rows previously exposed Load more, which appended the same file repeatedly.
describe('US-07 — complete local history', () => {
  it.each([50, 51, 101])('shows all %i measurements once without fake pagination', async (count) => {
    const rows: ApiMeasurement[] = Array.from({ length: count }, (_, index) => ({
      id: `weight-${index}`, metricType: 'weight', value: 70 + index / 10,
      recordedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    mocks.loadAllHistory.mockResolvedValue(rows);
    const view = render(<HistoryPanel initialMetric="weight" />);
    await waitFor(() => expect(mocks.chart).toHaveBeenCalled());
    expect(mocks.chart.mock.lastCall![0].data.datasets[0].data).toHaveLength(count);
    expect(view.queryByRole('button', { name: /Load more/i })).toBeNull();
    expect(mocks.loadAllHistory).toHaveBeenCalledOnce();
  });
});

// US-21 AC3b: a history read that fails ends the wait and claims nothing. Before,
// the load had no catch, so a rejected read left "Loading history..." on screen for good.
describe('US-21 AC3b — a failed history read', () => {
  it('ends Loading history, never says there are no measurements, and reports tags only', async () => {
    const error = new Error('read failed');
    mocks.loadAllHistory.mockRejectedValue(error);
    const view = render(<HistoryPanel />);
    await waitFor(() => expect(view.queryByText('Loading history...')).toBeNull());
    expect(view.queryByText('No measurements recorded yet.')).toBeNull();
    expect(view.container.querySelector('.history-panel')!.textContent).toBe('Health History');
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException).toHaveBeenCalledWith(error, { tags: { area: 'cloud-sync', op: 'load' } });
  });

  it('shows the empty state when the read succeeds with no rows', async () => {
    mocks.loadAllHistory.mockResolvedValue([]);
    const view = render(<HistoryPanel />);
    await waitFor(() => expect(view.getByText('No measurements recorded yet.')).toBeTruthy());
    expect(view.queryByText('Loading history...')).toBeNull();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it.each(['loadLabValues', 'loadMedicationHistory'] as const)('a failed %s is reported once with tags only and leaves its rows empty', async (loader) => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const error = new Error('read failed');
      mocks.loadAllHistory.mockResolvedValue([]);
      mocks[loader].mockRejectedValue(error);
      const view = render(<HistoryPanel />);
      await waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
      expect(mocks.captureException).toHaveBeenCalledWith(error, { tags: { area: 'cloud-sync', op: 'load' } });
      expect(view.getByText('No measurements recorded yet.')).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
