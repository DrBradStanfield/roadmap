// @vitest-environment jsdom
/**
 * US-62 AC12, AC13, AC31: the onboarding of the record the screen shows, one
 * state per record. The page-level journeys are pinned in
 * HealthTool.onboarding-pins.test.tsx; these check the hook's own rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { FormStage, RecordHoldings } from '@roadmap/health-core/mappings';

const shown = vi.hoisted(() => ({ erase: 'erase-1' }));
vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => shown.erase }));
const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: (name: string, meta?: unknown) => { tracked.calls.push([name, meta]); } }));

import { useOnboarding } from './useOnboarding';

const EMPTY: RecordHoldings = { saved: [], medications: [], screenings: [], supplements: [], documents: [], labValues: [] };
const setup = (stage: FormStage) => renderHook(
  ({ stage }: { stage: FormStage }) => useOnboarding(stage, EMPTY, true),
  { initialProps: { stage } },
);

beforeEach(() => {
  shown.erase = 'erase-1';
  tracked.calls = [];
  localStorage.clear();
});

describe('US-62 AC13: a step counts only when this tab answered it', () => {
  it('a rise after an answer here sends the step that was asked; a rise with none sends nothing', () => {
    const view = setup(1);
    act(() => view.result.current.markAnswered());
    view.rerender({ stage: 2 });
    expect(tracked.calls).toEqual([['onboarding_step', { step: 'measurements' }]]);
    view.rerender({ stage: 3 }); // no answer given here since
    expect(tracked.calls).toHaveLength(1);
  });

  it('a change from another writer clears the answer', () => {
    const view = setup(1);
    act(() => { view.result.current.markAnswered(); view.result.current.clearAnswered(); });
    view.rerender({ stage: 2 });
    expect(tracked.calls).toEqual([]);
  });

  it('the answer belongs to its record: one given before an erase does not count a rise on the next record', () => {
    const view = setup(1);
    act(() => view.result.current.markAnswered());
    shown.erase = 'erase-2';
    view.rerender({ stage: 1 });
    expect(view.result.current.epoch).toBe(2);
    view.rerender({ stage: 2 });
    expect(tracked.calls).toEqual([]);
  });
});

describe('US-62 AC31: "Your plan is ready." for the onboarding that ended here', () => {
  it('shows once the last answer given here completes the record, and Got it hides it for this browser', () => {
    const view = setup(3);
    act(() => view.result.current.markAnswered());
    view.rerender({ stage: 4 });
    expect(tracked.calls.map(([n]) => n)).toEqual(['onboarding_step', 'onboarding_done']);
    expect(view.result.current.planReady).toBe(true);
    act(() => view.result.current.dismissPlanReady());
    expect(view.result.current.planReady).toBe(false);
    // The next record's onboarding, ended here, shows no card: this browser has seen it.
    shown.erase = 'erase-2';
    view.rerender({ stage: 3 });
    act(() => view.result.current.markAnswered());
    view.rerender({ stage: 4 });
    expect(view.result.current.planReady).toBe(false);
  });

  it('an erase hides the card shown for the record before it', () => {
    const view = setup(3);
    act(() => view.result.current.markAnswered());
    view.rerender({ stage: 4 });
    expect(view.result.current.planReady).toBe(true);
    shown.erase = 'erase-2';
    view.rerender({ stage: 1 });
    expect(view.result.current.planReady).toBe(false);
  });
});

describe('US-62 AC12: About you moves low', () => {
  it('at once for a record complete when first shown', () => {
    expect(setup(4).result.current.aboutYouLow).toBe(true);
  });

  it('for a record completed later, only once its card is left (D6), and an erase starts it again', () => {
    const view = setup(3);
    view.rerender({ stage: 4 });
    expect(view.result.current.aboutYouLow).toBe(false);
    let moved = false;
    act(() => { moved = view.result.current.profileLeft(); });
    expect(moved).toBe(true); // D3: InputPanel measures its FLIP only on a move
    expect(view.result.current.aboutYouLow).toBe(true);
    shown.erase = 'erase-2';
    view.rerender({ stage: 1 });
    expect(view.result.current.aboutYouLow).toBe(false);
  });

  it('leaving the card before the four answers hold moves nothing', () => {
    const view = setup(3);
    let moved = true;
    act(() => { moved = view.result.current.profileLeft(); });
    expect(moved).toBe(false);
    expect(view.result.current.aboutYouLow).toBe(false);
  });
});
