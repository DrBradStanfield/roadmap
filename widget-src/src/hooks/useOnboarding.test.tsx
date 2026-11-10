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

// The erase the screen shows: HealthTool's React state (D5).
const shown = { erase: 'erase-1' };
const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: (name: string, meta?: unknown) => { tracked.calls.push([name, meta]); } }));

import { transition, useOnboarding, type Landing } from './useOnboarding';

const EMPTY: RecordHoldings = { saved: [], medications: [], screenings: [], supplements: [], documents: [], labValues: [] };
const setup = (stage: FormStage) => renderHook(
  ({ stage }: { stage: FormStage }) => useOnboarding(stage, EMPTY, true, shown.erase),
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

  it('D3: leaving the card when About you is already low says it moves nothing, and changes nothing', () => {
    const view = setup(4); // complete when first shown: low already
    const before = view.result.current;
    let moved = true;
    act(() => { moved = view.result.current.profileLeft(); });
    expect(moved).toBe(false);
    expect(view.result.current).toBe(before); // no re-render: no state changed
    const later = setup(3);
    later.rerender({ stage: 4 });
    let first = false;
    act(() => { first = later.result.current.profileLeft(); moved = later.result.current.profileLeft(); }); // before the move commits
    expect([first, moved]).toEqual([true, false]);
    act(() => { moved = later.result.current.profileLeft(); }); // after it
    expect(moved).toBe(false);
    expect(later.result.current.aboutYouLow).toBe(true);
  });

  it('leaving the card before the four answers hold moves nothing', () => {
    const view = setup(3);
    let moved = true;
    act(() => { moved = view.result.current.profileLeft(); });
    expect(moved).toBe(false);
    expect(view.result.current.aboutYouLow).toBe(false);
  });
});

describe('US-62 AC25 (D4): the landing at My health, once per record, for an onboarding ended here', () => {
  /** Asks for the landing as an answer is typed, and lands it at once. */
  const land = (view: ReturnType<typeof setup>) => view.result.current.landing()();
  /** The last answer given here, which asks for the landing as it is typed (a weight, the year): the record rises to stage 4. */
  const answerLast = (view: ReturnType<typeof setup>) => {
    act(() => { view.result.current.markAnswered(); view.result.current.landing(); });
    view.rerender({ stage: 4 });
  };

  it('lands once the onboarding ends here, once per record, and again after an erase', () => {
    const view = setup(3);
    expect(land(view)).toBe(false); // not the last answer yet: nothing spent
    answerLast(view);
    expect(land(view)).toBe(true);
    expect(land(view)).toBe(false); // spent for this record
    shown.erase = 'erase-2';
    view.rerender({ stage: 3 });
    answerLast(view);
    expect(land(view)).toBe(true); // the new record's own landing
    expect(land(view)).toBe(false);
  });

  it('a landing asked on one record does not land on the next', () => {
    const view = setup(3);
    answerLast(view);
    const asked = view.result.current.landing(); // the weight typed on the first record
    shown.erase = 'erase-2';
    view.rerender({ stage: 3 });
    answerLast(view);
    expect(asked()).toBe(false); // that record was erased before the jump fired
    expect(land(view)).toBe(true); // and the new record's landing is still there
  });

  it('never lands for a record complete when first shown, or one another writer completed (D6)', () => {
    expect(land(setup(4))).toBe(false);
    const view = setup(3);
    view.rerender({ stage: 4 }); // a rise with no answer given here
    expect(land(view)).toBe(false);
  });
});

describe('US-62 AC25 (D4): the landing\'s states, every state by every event', () => {
  const unended = (asked: boolean): Landing => ({ kind: 'unended', asked });
  const due: Landing = { kind: 'due' };
  const spent: Landing = { kind: 'spent' };
  it.each<[string, Landing, Record<'answered' | 'asked' | 'ended' | 'landed', Landing>]>([
    ['unended, not asked', unended(false), { answered: unended(false), asked: unended(true), ended: spent, landed: unended(false) }],
    ['unended, asked', unended(true), { answered: unended(false), asked: unended(true), ended: due, landed: unended(true) }],
    ['due', due, { answered: due, asked: due, ended: due, landed: spent }],
    ['spent', spent, { answered: spent, asked: spent, ended: spent, landed: spent }],
  ])('%s', (_, from, to) => {
    for (const [event, next] of Object.entries(to)) expect([event, transition(from, event as keyof typeof to)]).toEqual([event, next]);
  });

  it('an onboarding that ends on an answer that asked no landing spends it (R2, option iii)', () => {
    const view = setup(3);
    view.result.current.landing(); // a year typed before the last answer
    answerLastSilently(view); // sex, last: it asks nothing
    expect(view.result.current.landing()()).toBe(false);
  });
});

/** The last answer given here, one that asks no landing (sex, the chat, an upload). */
function answerLastSilently(view: ReturnType<typeof setup>) { act(() => view.result.current.markAnswered()); view.rerender({ stage: 4 }); }
