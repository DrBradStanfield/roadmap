// @vitest-environment jsdom
/**
 * US-62 AC12, AC13, AC31: the onboarding of the record the screen shows, one
 * state per record. The page-level journeys are pinned in
 * HealthTool.onboarding-pins.test.tsx; these check the hook's own rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, StrictMode, createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import type { FormStage, RecordHoldings } from '@roadmap/health-core/mappings';

// The erase the screen shows: HealthTool's React state (D5).
const shown = { erase: 'erase-1' };
const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: (name: string, meta?: unknown) => { tracked.calls.push([name, meta]); } }));

import { transition, useOnboarding, waitsOn, type Landing, type LandingEvent, type LandingField } from './useOnboarding';

const EMPTY: RecordHoldings = { saved: [], medications: [], screenings: [], supplements: [], documents: [], labValues: [] };
// The land action HealthTool passes in; frames run at once here.
const land = vi.fn();
const setup = (stage: FormStage, strict = false) => renderHook(
  ({ stage }: { stage: FormStage }) => useOnboarding(stage, EMPTY, true, shown.erase, land),
  { initialProps: { stage }, wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined },
);

beforeEach(() => {
  land.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  shown.erase = 'erase-1';
  tracked.calls = [];
  localStorage.clear();
});

describe('US-62 AC13: a step counts only when this tab answered it', () => {
  it('a rise after an answer here sends the step that was asked; a rise with none sends nothing', () => {
    const view = setup(1);
    act(() => view.result.current.answered(null));
    view.rerender({ stage: 2 });
    expect(tracked.calls).toEqual([['onboarding_step', { step: 'measurements' }]]);
    view.rerender({ stage: 3 }); // no answer given here since
    expect(tracked.calls).toHaveLength(1);
  });

  it('a change from another writer clears the answer', () => {
    const view = setup(1);
    act(() => { view.result.current.answered(null); view.result.current.clearAnswered(); });
    view.rerender({ stage: 2 });
    expect(tracked.calls).toEqual([]);
  });

  it('the answer belongs to its record: one given before an erase does not count a rise on the next record', () => {
    const view = setup(1);
    act(() => view.result.current.answered(null));
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
    act(() => view.result.current.answered(null));
    view.rerender({ stage: 4 });
    expect(tracked.calls.map(([n]) => n)).toEqual(['onboarding_step', 'onboarding_done']);
    expect(view.result.current.planReady).toBe(true);
    act(() => view.result.current.dismissPlanReady());
    expect(view.result.current.planReady).toBe(false);
    // The next record's onboarding, ended here, shows no card: this browser has seen it.
    shown.erase = 'erase-2';
    view.rerender({ stage: 3 });
    act(() => view.result.current.answered(null));
    view.rerender({ stage: 4 });
    expect(view.result.current.planReady).toBe(false);
  });

  it('an erase hides the card shown for the record before it', () => {
    const view = setup(3);
    act(() => view.result.current.answered(null));
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

describe('US-62 AC25b: the landing, decided by the hook from two facts', () => {
  const W = 'weightKg' as const;
  const Y = 'birthYear' as const;
  const open = (lands: LandingField | null, settled: boolean): Landing => ({ kind: 'open', lands, settled });
  const awaiting = (settled: boolean, field: LandingField = W): Landing => ({ kind: 'awaiting', field, settled });
  const spent: Landing = { kind: 'spent' };
  const events: Array<[string, LandingEvent]> = [
    ['answered(weightKg)', { type: 'answered', lands: W }],
    ['answered(null)', { type: 'answered', lands: null }],
    ['settled(complete)', { type: 'settled', complete: true }],
    ['settled(incomplete)', { type: 'settled', complete: false }],
    ['ended', { type: 'ended' }],
    ['left', { type: 'left' }],
    ['foreign', { type: 'foreign' }],
    ['completed', { type: 'completed' }],
  ];
  const stay = (s: Landing) => ({ next: s, land: false });
  // f: every state by every event, the land flag included.
  it.each<[string, Landing, Array<{ next: Landing; land: boolean }>]>([
    // events: answered(weightKg), answered(null), settled(complete), settled(incomplete), ended, left, foreign, completed
    ['open(null,false)', open(null, false), [stay(open(W, false)), stay(open(null, false)), stay(open(null, false)), stay(open(null, false)), stay(spent), stay(open(null, false)), stay(open(null, false)), stay(open(null, false))]],
    ['open(null,true)', open(null, true), [stay(open(W, false)), stay(open(null, false)), stay(open(null, true)), stay(open(null, true)), stay(spent), stay(open(null, false)), stay(open(null, false)), stay(open(null, true))]],
    ['open(weightKg,false)', open(W, false), [stay(open(W, false)), stay(open(null, false)), stay(open(W, true)), stay(open(W, true)), stay(awaiting(false)), stay(open(null, false)), stay(open(null, false)), stay(open(W, false))]],
    ['open(weightKg,true)', open(W, true), [stay(open(W, false)), stay(open(null, false)), stay(open(W, true)), stay(open(W, true)), { next: spent, land: true }, stay(open(null, false)), stay(open(null, false)), stay(open(W, true))]],
    ['awaiting(false)', awaiting(false), [stay(awaiting(false)), stay(spent), { next: spent, land: true }, stay(awaiting(true)), stay(awaiting(false)), stay(spent), stay(awaiting(false)), stay(awaiting(false))]],
    ['awaiting(true)', awaiting(true), [stay(awaiting(false)), stay(spent), { next: spent, land: true }, stay(awaiting(true)), stay(awaiting(true)), stay(spent), stay(awaiting(true)), { next: spent, land: true }]],
    ['spent', spent, events.map(() => stay(spent))],
  ])('f: %s', (_, from, to) => {
    events.forEach(([name, event], i) => expect([name, transition(from, event)]).toEqual([name, to[i]]));
  });

  // H53: each landing remembers the field it waits on.
  it.each<[string, Landing, LandingEvent, Landing]>([
    ['open(birthYear) + ended', open(Y, false), { type: 'ended' }, awaiting(false, Y)],
    ['awaiting(birthYear) + answered(null)', awaiting(false, Y), { type: 'answered', lands: null }, spent],
    ['open(weightKg) + answered(null)', open(W, false), { type: 'answered', lands: null }, open(null, false)],
    ['awaiting(birthYear) + answered(weightKg)', awaiting(true, Y), { type: 'answered', lands: W }, awaiting(false, W)],
  ])('H53 f: %s', (_, from, event, next) => {
    expect(transition(from, event)).toEqual({ next, land: false });
  });

  it.each<[string, Landing, boolean]>([
    ['open(weightKg, not settled)', open(W, false), true],
    ['open(weightKg, settled)', open(W, true), false],
    ['open(birthYear)', open(Y, false), false],
    ['awaiting(weightKg)', awaiting(false, W), true],
    ['awaiting(birthYear)', awaiting(false, Y), false],
    ['spent', spent, false],
  ])('H53 waitsOn(%s, weightKg) is %s', (_, landing, waits) => {
    expect(waitsOn(landing, W)).toBe(waits);
  });

  it('US-62 AC31a, H53: a chat weight answers only while the step is open or the landing waits on a typed weight', () => {
    const year = setup(3);
    act(() => year.result.current.answered('birthYear'));
    year.rerender({ stage: 4 }); // ended on the year: awaiting its rest
    act(() => year.result.current.chatWeight(false)); // a typed weight's save is pending: no answer
    act(() => year.result.current.rested());
    expect(land).toHaveBeenCalledTimes(1);
    land.mockClear();
    const weight = setup(3);
    act(() => weight.result.current.answered('weightKg'));
    weight.rerender({ stage: 4 }); // ended on the typed weight
    act(() => { weight.result.current.chatWeight(false); weight.result.current.rested(); }); // the chat's weight replaces it
    expect(land).not.toHaveBeenCalled();
    const asked = setup(1);
    act(() => asked.result.current.chatWeight(true)); // the step is open: the chat's weight answers it
    asked.rerender({ stage: 2 });
    expect(tracked.calls).toContainEqual(['onboarding_step', { step: 'measurements' }]);
  });

  it('e: the field at rest before the render that ends the onboarding: the land action runs exactly once', () => {
    const view = setup(3);
    act(() => { view.result.current.answered('birthYear'); view.result.current.rested(); });
    expect(land).not.toHaveBeenCalled();
    view.rerender({ stage: 4 });
    expect(land).toHaveBeenCalledTimes(1);
    act(() => view.result.current.rested());
    expect(land).toHaveBeenCalledTimes(1);
  });

  it('the ending first, then the field at rest: lands once; leaving the field first lands nothing', () => {
    const view = setup(3);
    act(() => view.result.current.answered('birthYear'));
    view.rerender({ stage: 4 });
    expect(land).not.toHaveBeenCalled();
    act(() => view.result.current.rested());
    expect(land).toHaveBeenCalledTimes(1);
    shown.erase = 'erase-2'; // a new record: its own landing
    view.rerender({ stage: 3 });
    act(() => view.result.current.answered('birthYear'));
    view.rerender({ stage: 4 });
    act(() => { view.result.current.left(); view.result.current.rested(); });
    expect(land).toHaveBeenCalledTimes(1);
  });

  it('g: with "Your plan is ready." shown the landing is no longer open: an ending on sex spends it, one on a typed weight awaits its rest', () => {
    const silent = setup(3);
    act(() => silent.result.current.answered(null)); // sex, last
    silent.rerender({ stage: 4 });
    expect(silent.result.current.planReady).toBe(true);
    act(() => { silent.result.current.answered('birthYear'); silent.result.current.rested(); }); // open would only wait for an ending
    expect(land).not.toHaveBeenCalled(); // spent
    localStorage.clear();
    const typed = setup(3);
    act(() => typed.result.current.answered('birthYear'));
    typed.rerender({ stage: 4 });
    expect(typed.result.current.planReady).toBe(true);
    act(() => typed.result.current.rested()); // awaiting: the rest alone lands it
    expect(land).toHaveBeenCalledTimes(1);
  });

  it('g: onboarding_done is sent once under StrictMode', () => {
    const view = setup(3, true);
    act(() => view.result.current.answered('birthYear'));
    view.rerender({ stage: 4 });
    view.rerender({ stage: 4 });
    expect(tracked.calls.filter(([n]) => n === 'onboarding_done')).toHaveLength(1);
  });

  it('never lands for a record complete when first shown, or one another writer completed (D6)', () => {
    const first = setup(4);
    act(() => { first.result.current.answered('birthYear'); first.result.current.rested(); });
    const other = setup(3);
    other.rerender({ stage: 4 }); // a rise with no answer given here
    act(() => { other.result.current.answered('birthYear'); other.result.current.rested(); });
    expect(land).not.toHaveBeenCalled();
  });

  it('R1: a change this tab did not make abandons a landing not yet ended here, but not one awaiting its rest', () => {
    const before = setup(3);
    act(() => { before.result.current.answered('birthYear'); before.result.current.clearAnswered(); before.result.current.rested(); });
    before.rerender({ stage: 4 }); // its answer is no longer this tab's: nothing ends here
    expect(land).not.toHaveBeenCalled();
    const during = setup(3);
    act(() => during.result.current.answered('birthYear'));
    during.rerender({ stage: 4 }); // ended here: awaiting the weight's rest
    act(() => { during.result.current.clearAnswered(); during.result.current.rested(); }); // another writer's change during the wait
    expect(land).toHaveBeenCalledTimes(1);
  });

  it('R4: a rest heard while the four answers dipped lands once they hold again', () => {
    const view = setup(3);
    act(() => view.result.current.answered('birthYear'));
    view.rerender({ stage: 4 }); // "72" ended it: awaiting
    act(() => view.result.current.answered('birthYear'));
    view.rerender({ stage: 1 }); // cleared: the stage falls
    act(() => { view.result.current.answered('birthYear'); view.result.current.rested(); }); // "72" again, its rest before its commit
    expect(land).not.toHaveBeenCalled();
    view.rerender({ stage: 4 });
    expect(land).toHaveBeenCalledTimes(1);
    view.rerender({ stage: 1 });
    view.rerender({ stage: 4 });
    expect(land).toHaveBeenCalledTimes(1);
  });
});
