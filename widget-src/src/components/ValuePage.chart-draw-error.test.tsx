// @vitest-environment jsdom
// US-62 AC37: the chart's code loads, then the chart throws while it draws.
// The same boundary catches it: the chart's place says so, the rest of the
// page stays, and the whole-tool error never shows. Synthetic values.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => '' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chunk loads; drawing the chart throws, as a chart library bug would.
const { DRAW_ERROR } = vi.hoisted(() => ({ DRAW_ERROR: "Cannot read properties of undefined (reading 'getBoundingClientRect')" }));
vi.mock('./HistoryPanel', () => ({
  TimeSeriesChart: () => { throw new TypeError(DRAW_ERROR); },
  MixedUnitsNote: () => null,
}));
import { ValuePage } from './ValuePage';

const CHART_TEXT = 'The chart could not load. Check your connection, then reload the page to see it.';
const ldl = (id: string, value: number, day: string) =>
  ({ id, metricType: 'ldl', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'manual' }) as any;

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-62 AC37: a value page whose chart throws while drawing keeps the page', () => {
  it('shows the chart-only words in the chart\'s place, never the whole-tool error, and reports the draw error once with the tag', async () => {
    const view = render(
      <ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'ldl' }} labValues={[]}
        history={[ldl('l2', 3.1, '2026-07-01'), ldl('l1', 2.8, '2026-06-01')]}
        ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>,
    );

    expect(await screen.findByText(CHART_TEXT, {}, { timeout: 10_000 })).toBeDefined();
    expect(screen.getByText(CHART_TEXT).className).toBe('md-page-empty');
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText(/The health tool encountered an error/)).toBeNull();
    expect(screen.queryByText('Loading chart…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'LDL Cholesterol' })).toBeDefined();
    expect(screen.getByText('Add a value')).toBeDefined();
    expect(view.container.querySelector('.md-page input')).not.toBeNull();
    const shown = [...view.container.querySelectorAll('.md-history .bt-value-num')].map(n => n.textContent);
    expect(shown).toEqual(['3.1mmol/L', '2.8mmol/L']);
    // The draw error itself is what goes, tagged with the chart's feature, with no component stack.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, hint] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect((error as Error).message).toBe(DRAW_ERROR);
    expect(hint).toEqual({ tags: { feature: 'value_page_chart' } });
  });
});

// The chart's tag is not one of the scrub's strict features (`upload`, `upload_review`,
// US-13 AC9), so its event takes the default scrub. That is the right path: a chart error
// comes from the chart library, not from record text.
describe('US-62 AC37: the chart\'s Sentry tag takes the default scrub, not the upload\'s strict one', () => {
  it('keeps the error\'s own type and message and the tag, where the strict scrub would replace them', async () => {
    const { scrubEvent } = await vi.importActual<typeof import('../lib/sentry')>('../lib/sentry');
    const event = (feature: string) => ({
      type: undefined,
      tags: { feature },
      exception: { values: [{ type: 'TypeError', value: DRAW_ERROR, mechanism: { type: 'generic', handled: true } }] },
    }) as any;

    const chart = scrubEvent(event('value_page_chart'));
    expect(chart?.tags).toEqual({ feature: 'value_page_chart' });
    expect(chart?.exception?.values?.[0]).toMatchObject({ type: 'TypeError', value: DRAW_ERROR });
    // The control: the same event under the upload review's tag takes the strict scrub.
    const review = scrubEvent(event('upload_review'));
    expect(review?.exception?.values?.[0]).toMatchObject({ type: 'Error', value: 'Health record operation failed' });
  });
});
