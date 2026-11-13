// @vitest-environment jsdom
// US-62 AC10a (H82): "Tap a value to correct it." shows only when the history
// holds a value to tap; with none, the page says "No values yet." alone.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ValuePage } from './ValuePage';

vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => '' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart is not under test: a stand-in, so no chart library loads.
vi.mock('./HistoryPanel', () => ({ TimeSeriesChart: () => null, MixedUnitsNote: () => null }));

const HINT = 'Tap a value to correct it.';
const waist = (id: string, value: number, day: string) =>
  ({ id, metricType: 'waist', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: day, source: 'manual' }) as any;
const page = (history: any[]) => (
  <ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'waist' }} history={history} labValues={[]}
    ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={vi.fn()} onClose={() => {}} dirtyRef={{ current: false }}/>
);

afterEach(cleanup);

describe('US-62 AC10a (H82): the correct-it hint needs a value to tap', () => {
  it('an empty history says "No values yet." and no hint', () => {
    render(page([]));
    expect(screen.getByText('No values yet.')).toBeDefined();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('a history with a value shows the hint, and loses it again when the value goes', () => {
    const view = render(page([waist('w1', 90, '2026-06-01')]));
    expect(screen.queryByText('No values yet.')).toBeNull();
    expect(screen.getByText(HINT)).toBeDefined();
    view.rerender(page([]));
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
