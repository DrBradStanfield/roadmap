// @vitest-environment jsdom
// US-62 AC36: when the value page's chart cannot load (offline, its lazy chunk
// refused), only the chart's place says so. The page's Add form and its saved
// values stay, and the whole-tool error never shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => '' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart's chunk cannot be fetched, as offline: the lazy import rejects.
vi.mock('./HistoryPanel', () => {
  throw new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/HistoryPanel.js');
});
import { ValuePage } from './ValuePage';

const CHART_TEXT = 'The chart could not load. Check your connection, then reload the page to see it.';
const ldl = (id: string, value: number, day: string) =>
  ({ id, metricType: 'ldl', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'manual' }) as any;
const page = (history: any[]) => (
  <ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'ldl' }} history={history} labValues={[]}
    ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>
);

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-62 AC36: a value page whose chart cannot load keeps the page', () => {
  it('shows the chart-only words in the chart\'s place, never the whole-tool error, and keeps the form and the saved value', async () => {
    // No values yet: no chart. A value is added; the parent re-reads and the chart is asked for.
    const view = render(page([]));
    expect(screen.getByText('No values yet.')).toBeDefined();
    view.rerender(page([ldl('l1', 2.8, '2026-06-01')]));

    expect(await screen.findByText(CHART_TEXT, {}, { timeout: 10_000 })).toBeDefined();
    expect(screen.getByText(CHART_TEXT).className).toBe('md-page-empty');
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText(/The health tool encountered an error/)).toBeNull();
    // The rest of the page stands: its title, the Add form and the saved value in the history.
    expect(screen.getByRole('heading', { name: 'LDL Cholesterol' })).toBeDefined();
    expect(screen.getByText('Add a value')).toBeDefined();
    expect(view.container.querySelector('.md-page input')).not.toBeNull();
    const shown = [...view.container.querySelectorAll('.md-history .bt-value-num')].map(n => n.textContent);
    expect(shown).toEqual(['2.8mmol/L']);
    // The error is reported once, tagged with the chart's feature, with no component stack.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException).mock.calls[0][1]).toEqual({ tags: { feature: 'value_page_chart' } });
  });
});
