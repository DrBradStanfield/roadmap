// @vitest-environment jsdom
/**
 * US-07 AC3: new or changed suggestions glow for 3 s, then fade for 0.5 s, once
 * the plan has settled (3 s after mount). Pins the behaviour phase by phase, the
 * pure `transition` by table, and Brad's P7 decision (2026-11-10): the first
 * suggestions after an empty plan glow, and nothing glows while the PDF email box
 * pulses (`held`); once it stops, what is new since the hold began glows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Suggestion } from '@roadmap/health-core/types';
import { planOf, transition, useHighlights, type Glow, type GlowEvent } from './useHighlights';
import { NO_HIGHLIGHTS } from '../components/PlanCards';

const s = (id: string, title = `${id} title`, description = `${id} words`): Suggestion =>
  ({ id, category: 'general', priority: 'info', title, description });

function mount(list: Suggestion[] | undefined, held = false) {
  let renders = 0;
  let props = { list, held };
  const hook = renderHook((p: { list: Suggestion[] | undefined; held: boolean }) => { renders++; return useHighlights(p.list, p.held); }, { initialProps: props });
  return {
    ...hook,
    renders: () => renders,
    show: (next: Suggestion[] | undefined) => { props = { ...props, list: next }; hook.rerender(props); },
    hold: (on: boolean) => { props = { ...props, held: on }; hook.rerender(props); },
    /** The suggestions and the hold change in one commit. */
    set: (next: Suggestion[] | undefined, on: boolean) => { props = { list: next, held: on }; hook.rerender(props); },
    glowing: () => [...hook.result.current.highlighted].sort(),
    fading: () => [...hook.result.current.fadingOut].sort(),
  };
}
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** A plan that has settled on [a, b]. */
function settled() {
  const h = mount([s('a'), s('b')]);
  tick(3100);
  return h;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('US-07 AC3: useHighlights', () => {
  it('nothing glows while the plan settles (first 3 s): a change then becomes the baseline', () => {
    const h = mount([s('a')]);
    tick(1000);
    h.show([s('a'), s('b')]);
    expect(h.glowing()).toEqual([]);
    tick(2100); // settled now, on [a, b]
    h.show([s('a'), s('b')]);
    expect(h.glowing()).toEqual([]);
    h.show([s('a'), s('b'), s('c')]);
    expect(h.glowing()).toEqual(['c']);
  });

  it('P7 (Brad 2026-11-10): the first batch after an empty plan now glows (it never did)', () => {
    const h = mount(undefined);
    tick(3100);
    h.show([s('a'), s('b')]);
    expect(h.glowing()).toEqual(['a', 'b']);
    tick(3000);
    expect(h.fading()).toEqual(['a', 'b']);
    tick(500);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
  });

  it('a new id glows, fades at 3 s, and is still at 3.5 s', () => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    expect(h.glowing()).toEqual(['c']);
    expect(h.fading()).toEqual([]);
    tick(2999);
    expect(h.glowing()).toEqual(['c']);
    tick(1);
    expect(h.glowing()).toEqual([]);
    expect(h.fading()).toEqual(['c']);
    tick(500);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
    // The glow's plan is the new baseline: showing it again does not glow.
    h.show([s('a'), s('b'), s('c')]);
    expect(h.glowing()).toEqual([]);
  });

  it('a changed title or description glows; an unchanged one does not', () => {
    const h = settled();
    h.show([s('a', 'new title'), s('b')]);
    expect(h.glowing()).toEqual(['a']);
    tick(3500);
    h.show([s('a', 'new title'), s('b', 'b title', 'new words')]);
    expect(h.glowing()).toEqual(['b']);
  });

  it('a removed id glows nothing', () => {
    const h = settled();
    h.show([s('a')]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
  });

  it('a second change mid-glow restarts the glow: every id new against the settled plan, from the second change', () => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(2000);
    // c stays in the glow: the baseline moves only when a fade completes.
    h.show([s('a'), s('b'), s('c'), s('d')]);
    expect(h.glowing()).toEqual(['c', 'd']);
    tick(2999);
    expect(h.glowing()).toEqual(['c', 'd']);
    tick(1);
    expect(h.fading()).toEqual(['c', 'd']);
  });

  it('a second change mid-glow that drops the first new id glows only the second', () => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(1000);
    h.show([s('a'), s('b'), s('d')]);
    expect(h.glowing()).toEqual(['d']);
  });

  it('a new change mid-fade cancels the fade and glows again', () => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(3200);
    expect(h.fading()).toEqual(['c']);
    h.show([s('a'), s('b'), s('c'), s('d')]);
    expect(h.fading()).toEqual([]);
    expect(h.glowing()).toEqual(['c', 'd']);
    tick(500); // the cancelled fade's timer must not end the new glow
    expect(h.glowing()).toEqual(['c', 'd']);
  });

  it.each([['glow', 1000], ['fade', 3200]])('a change undone mid-%s ends it at once, and nothing glows later', (_, at) => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(at);
    h.show([s('a'), s('b')]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
    tick(10_000);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);    h.show([s('a'), s('b'), s('c')]); // the baseline stayed the settled plan, so c is new again
    expect(h.glowing()).toEqual(['c']);
  });

  it('today: a new array with identical content mid-glow restarts the glow, so it fades 3 s after the copy', () => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(2000);
    h.show([s('a'), s('b'), s('c')]);
    expect(h.glowing()).toEqual(['c']);
    tick(1500); // 3.5 s after the first change: would be still without the restart
    expect(h.glowing()).toEqual(['c']);
    tick(1500);
    expect(h.fading()).toEqual(['c']);
  });

  it('P7 (Brad 2026-11-10): the plan going empty, then refilling, now glows every refilled card (it never did)', () => {
    const h = settled();
    h.show([]);
    h.show([s('a'), s('b'), s('c')]);
    expect(h.glowing()).toEqual(['a', 'b', 'c']);
    tick(3500);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
  });

  it('nothing changed while still: no new state, so no extra render', () => {
    const h = settled();
    const before = h.renders();
    h.show([s('a'), s('b')]);
    expect(h.renders()).toBe(before + 1); // the rerender itself, no state update after it
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
  });
});

describe('US-07 AC3, P7 (Brad 2026-11-10): nothing glows while the email box pulses', () => {
  it('first suggestions while held glow nothing; once the hold ends they glow as one batch, then fade', () => {
    const h = mount(undefined, true);
    tick(3100);
    h.show([s('a'), s('b')]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    tick(10_000);
    h.show([s('a'), s('b'), s('c')]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    h.hold(false);
    expect(h.glowing()).toEqual(['a', 'b', 'c']);
    tick(3000);
    expect(h.fading()).toEqual(['a', 'b', 'c']);
    tick(500);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
    h.show([s('a'), s('b'), s('c')]); // the released plan is the new baseline
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
  });

  it('the hold keeps the baseline it began with: only cards new or changed against it glow', () => {
    const h = settled();
    h.hold(true);
    h.show([s('a', 'new title'), s('b'), s('c')]);
    h.show([s('a', 'new title'), s('c')]); // b dropped meanwhile: glows nothing
    h.hold(false);
    expect(h.glowing()).toEqual(['a', 'c']);
  });

  it('a hold that ends with nothing new glows nothing', () => {
    const h = settled();
    h.hold(true);
    h.show([s('a'), s('b'), s('c')]);
    h.show([s('a'), s('b')]); // undone before the email was given
    h.hold(false);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    tick(10_000);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
  });

  it.each([['glow', 1000], ['fade', 3200]])('a hold that begins mid-%s ends it at once', (_, at) => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(at);
    h.hold(true);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
    tick(10_000);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
  });

  it.each([['glow', 1000], ['fade', 3200]])('Codex R2: a card that glowed before a hold begun mid-%s does not glow again on release', (_, at) => {
    const h = settled();
    h.show([s('a'), s('b'), s('c')]);
    tick(at);
    h.hold(true);
    h.hold(false);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    h.hold(true);
    h.show([s('a'), s('b'), s('c'), s('d')]);
    h.hold(false);
    expect(h.glowing()).toEqual(['d']);
  });

  it('a plan and a hold arriving in one commit (a minor corrected to an adult): nothing glows; on release, what is new since the shown plan glows', () => {
    const h = settled();
    h.set([s('a'), s('b'), s('c')], true);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    tick(10_000);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    h.hold(false);
    expect(h.glowing()).toEqual(['c']);
  });

  it('an email never given: no card ever glows', () => {
    const h = mount([s('a')], true);
    for (const next of [[s('a'), s('b')], [s('c')], [], [s('a'), s('d')]]) {
      tick(5000);
      h.show(next);
      expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
      expect(h.result.current.fadingOut).toBe(NO_HIGHLIGHTS);
    }
  });

  it('held through the settle: the loaded plan stays the baseline, so a returning visitor sees no glow on release', () => {
    const h = mount([s('a'), s('b')], true);
    tick(3100);
    h.hold(false);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
  });
});

describe('US-07 AC3: transition, phase by event', () => {
  const P = (...ids: string[]) => planOf(ids.map(id => s(id)));
  const AB = P('a', 'b');
  const ABC = P('a', 'b', 'c');
  const ids = (...x: string[]) => new Set(x);
  const settling = (held: boolean): Glow => ({ phase: 'settling', baseline: AB, held });
  const still: Glow = { phase: 'still', baseline: AB };
  const held: Glow = { phase: 'held', baseline: AB, plan: ABC };
  const glowing: Glow = { phase: 'glowing', baseline: AB, plan: ABC, ids: ids('c') };
  const fading: Glow = { phase: 'fading', baseline: AB, plan: ABC, ids: ids('c') };
  const ABCD = P('a', 'b', 'c', 'd');
  const sync = (p: ReturnType<typeof P>, h: boolean): GlowEvent => ({ type: 'sync', plan: p, held: h });
  const settledE: GlowEvent = { type: 'settled' };
  const glowEnded: GlowEvent = { type: 'glowEnded' };
  const fadeEnded: GlowEvent = { type: 'fadeEnded' };

  it.each<[string, Glow, GlowEvent, Glow]>([
    ['settling + sync: the plan is the baseline', settling(false), sync(ABC, false), { phase: 'settling', baseline: ABC, held: false }],
    ['settling + sync held: remembered', settling(false), sync(AB, true), settling(true)],
    ['settling + settled: still', settling(false), settledE, still],
    ['settling (held) + settled: held on the loaded plan', settling(true), settledE, { phase: 'held', baseline: AB, plan: AB }],
    ['still + sync with a new id: glowing', still, sync(ABC, false), glowing],
    ['still + sync with an id gone: still on it', still, sync(P('a'), false), { phase: 'still', baseline: P('a') }],
    ['still (empty) + first plan: glowing all (P7)', { phase: 'still', baseline: P() }, sync(AB, false), { phase: 'glowing', baseline: P(), plan: AB, ids: ids('a', 'b') }],
    ['still + sync held, same plan: held', still, sync(AB, true), { phase: 'held', baseline: AB, plan: AB }],
    ['still + sync held with a new plan in one commit: held, the shown plan the baseline (Codex R2 re-check)', still, sync(ABC, true), { phase: 'held', baseline: AB, plan: ABC }],
    ['held + sync held: remembered, baseline kept', held, sync(P('a', 'c', 'd'), true), { phase: 'held', baseline: AB, plan: P('a', 'c', 'd') }],
    ['held + sync free with new ids: glowing', held, sync(ABC, false), glowing],
    ['held + sync free with a plan in the same commit: glowing on it', held, sync(ABCD, false), { phase: 'glowing', baseline: AB, plan: ABCD, ids: ids('c', 'd') }],
    ['held + sync free with nothing new: still on the plan', { phase: 'held', baseline: AB, plan: P('a') }, sync(P('a'), false), { phase: 'still', baseline: P('a') }],
    ['held (a card removed) + sync free with it back: still, nothing glows', { phase: 'held', baseline: AB, plan: P('a') }, sync(AB, false), still],
    ['glowing + glowEnded: fading', glowing, glowEnded, fading],
    ['glowing + sync with more: glowing, same baseline', glowing, sync(ABCD, false), { phase: 'glowing', baseline: AB, plan: ABCD, ids: ids('c', 'd') }],
    ['glowing + sync undone: still', glowing, sync(AB, false), still],
    ['glowing + sync held: held, the glow\'s plan the baseline (Codex R2)', glowing, sync(ABC, true), { phase: 'held', baseline: ABC, plan: ABC }],
    ['glowing + sync held with a new plan in one commit: held, the glow\'s plan the baseline', glowing, sync(ABCD, true), { phase: 'held', baseline: ABC, plan: ABCD }],
    ['fading + fadeEnded: still on the plan', fading, fadeEnded, { phase: 'still', baseline: ABC }],
    ['fading + sync with more: glowing', fading, sync(ABCD, false), { phase: 'glowing', baseline: AB, plan: ABCD, ids: ids('c', 'd') }],
    ['fading + sync undone: still', fading, sync(AB, false), still],
    ['fading + sync held: held, the glow\'s plan the baseline (Codex R2)', fading, sync(ABC, true), { phase: 'held', baseline: ABC, plan: ABC }],
  ])('%s', (_, state, event, next) => {
    expect(transition(state, event)).toEqual(next);
  });

  // Codex R2 (US-07 AC3): a hold that starts mid-glow or mid-fade starts from what
  // was shown, so a card that glowed before the hold never glows again on release.
  it.each<[string, Glow]>([['glow', glowing], ['fade', fading]])('a hold entered mid-%s: released unchanged, nothing glows; released with an edit, only that card', (_, state) => {
    const entered = transition(state, sync(ABC, true));
    expect(transition(entered, sync(ABC, false))).toEqual({ phase: 'still', baseline: ABC });
    const edited = transition(entered, sync(ABCD, true));
    expect(transition(edited, sync(ABCD, false))).toEqual({ phase: 'glowing', baseline: ABC, plan: ABCD, ids: ids('d') });
  });

  it.each<[string, Glow, GlowEvent]>([
    ['settling + the same plan', settling(false), sync(P('a', 'b'), false)],
    ['settling + the same plan and hold', settling(true), sync(P('a', 'b'), true)],
    ['still + the same plan', still, sync(P('a', 'b'), false)],
    ['still + settled', still, settledE],
    ['still + glowEnded', still, glowEnded],
    ['still + fadeEnded', still, fadeEnded],
    ['held + the same plan', held, sync(P('a', 'b', 'c'), true)],
    ['held + glowEnded', held, glowEnded],
    ['glowing + fadeEnded', glowing, fadeEnded],
    ['fading + glowEnded', fading, glowEnded],
    ['fading + settled', fading, settledE],
  ])('%s: the same state object (no re-render)', (_, state, event) => {
    expect(transition(state, event)).toBe(state);
  });
});
