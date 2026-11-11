// @vitest-environment jsdom
// US-62 AC37: when the value page's chart cannot load (offline, its lazy chunk
// refused), only the chart's place says so. The page's Add form and its saved
// values stay, and the whole-tool error never shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => '' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart's chunk cannot be fetched, as offline: the lazy import rejects.
vi.mock('./HistoryPanel', () => {
  throw new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/HistoryPanel.js');
});

const CHART_TEXT = 'The chart could not load. Check your connection, then reload the page to see it.';
const ldl = (id: string, value: number, day: string) =>
  ({ id, metricType: 'ldl', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'manual' }) as any;

// Each test is a fresh page load: a new ValuePage module, so its lazy chart import starts unasked.
let ValuePage: typeof import('./ValuePage').ValuePage;
let Sentry: typeof import('../lib/sentry').Sentry;
const page = (history: any[]) => (
  <ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'ldl' }} history={history} labValues={[]}
    ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>
);

beforeEach(async () => {
  // A mocked module's factory result is kept across resetModules, so its calls are cleared here.
  vi.clearAllMocks();
  vi.resetModules();
  ({ ValuePage } = await import('./ValuePage'));
  ({ Sentry } = await import('../lib/sentry'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The chart's words in its place, never the whole-tool error, and the rest of the page standing. */
async function expectChartLineOnly(container: HTMLElement, values: string[]) {
  expect(await screen.findByText(CHART_TEXT, {}, { timeout: 10_000 })).toBeDefined();
  expect(screen.getByText(CHART_TEXT).className).toBe('md-page-empty');
  expect(screen.queryByText('Something went wrong')).toBeNull();
  expect(screen.queryByText(/The health tool encountered an error/)).toBeNull();
  expect(screen.queryByText('Loading chart…')).toBeNull();
  // The rest of the page stands: its title, the Add form and the saved values in the history.
  expect(screen.getByRole('heading', { name: 'LDL Cholesterol' })).toBeDefined();
  expect(screen.getByText('Add a value')).toBeDefined();
  expect(container.querySelector('.md-page input')).not.toBeNull();
  const shown = [...container.querySelectorAll('.md-history .bt-value-num')].map(n => n.textContent);
  expect(shown).toEqual(values);
  // The error is reported once, tagged with the chart's feature, with no component stack.
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  expect(vi.mocked(Sentry.captureException).mock.calls[0][1]).toEqual({ tags: { feature: 'value_page_chart' } });
}

describe('US-62 AC37: a value page whose chart cannot load keeps the page', () => {
  it('shows the chart-only words in the chart\'s place, never the whole-tool error, and keeps the form and the saved value', async () => {
    // No values yet: no chart. A value is added; the parent re-reads and the chart is asked for.
    const view = render(page([]));
    expect(screen.getByText('No values yet.')).toBeDefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    view.rerender(page([ldl('l1', 2.8, '2026-06-01')]));
    await expectChartLineOnly(view.container, ['2.8mmol/L']);
  });

  it('says the same when a page that already has values is opened offline', async () => {
    // The page opens with two saved values, so it asks for the chart at once.
    const view = render(page([ldl('l2', 3.1, '2026-07-01'), ldl('l1', 2.8, '2026-06-01')]));
    await expectChartLineOnly(view.container, ['3.1mmol/L', '2.8mmol/L']);
  });
});
