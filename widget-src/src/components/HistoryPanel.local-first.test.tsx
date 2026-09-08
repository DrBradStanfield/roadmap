// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';

const mocks = vi.hoisted(() => ({ loadAllHistory: vi.fn(), chart: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({
  loadAllHistory: mocks.loadAllHistory,
  loadLabValues: async () => [],
  loadMedicationHistory: async () => [],
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
