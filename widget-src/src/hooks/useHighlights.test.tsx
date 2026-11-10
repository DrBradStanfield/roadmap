// @vitest-environment jsdom
/**
 * US-07 AC3: new or changed suggestions glow for 3 s, then fade for 0.5 s, once
 * the plan has settled (3 s after mount). Pins today's behaviour, phase by phase,
 * so the hook's state can be made explicit without changing what the cards show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Suggestion } from '@roadmap/health-core/types';
import { useHighlights } from './useHighlights';
import { NO_HIGHLIGHTS } from '../components/PlanCards';

const s = (id: string, title = `${id} title`, description = `${id} words`): Suggestion =>
  ({ id, category: 'general', priority: 'info', title, description });

function mount(list: Suggestion[] | undefined) {
  let renders = 0;
  const hook = renderHook(({ list }: { list: Suggestion[] | undefined }) => { renders++; return useHighlights(list); }, { initialProps: { list } });
  return {
    ...hook,
    renders: () => renders,
    show: (next: Suggestion[] | undefined) => hook.rerender({ list: next }),
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

  it('the first batch after an empty plan never glows', () => {
    const h = mount(undefined);
    tick(3100);
    h.show([s('a'), s('b')]);
    expect(h.glowing()).toEqual([]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
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

  it('the plan going empty, then refilling, does not glow (a first batch again)', () => {
    const h = settled();
    h.show([]);
    h.show([s('a'), s('b'), s('c')]);
    expect(h.result.current.highlighted).toBe(NO_HIGHLIGHTS);
    tick(10_000);
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
