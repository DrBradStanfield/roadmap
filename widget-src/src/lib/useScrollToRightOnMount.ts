import { useEffect, useRef } from 'react';

/**
 * Scrolls the returned element to its rightmost position on first mount —
 * once. Subsequent dep changes don't re-yank the scroll so the user isn't
 * pulled away from their current view when new data arrives.
 *
 * Used by the BloodTestTimeline matrix and StartingInfoVitals card to
 * default the view to the newest column (draft / right edge).
 */
export function useScrollToRightOnMount<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T | null>(null);
  const didRef = useRef(false);
  useEffect(() => {
    if (didRef.current) return;
    const el = ref.current;
    if (!el) return;
    // Apply once, when the scroller actually overflows. The matrix can mount
    // inside an opacity reveal (`.stage-reveal`) and other effects in the same
    // commit (focus chains, late layout) can clobber an eagerly-set scrollLeft,
    // so we re-assert across a few delayed ticks rather than a single shot.
    // Idempotent: each tick bails once `didRef` is set and only ever pins to
    // the right edge, so the user is never yanked away after they scroll.
    const timers: number[] = [];
    const apply = () => {
      if (didRef.current) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      el.scrollLeft = max;
    };
    // Spread attempts past the 300ms reveal so a late layout/focus can't win.
    [0, 60, 160, 320, 480].forEach(ms =>
      timers.push(window.setTimeout(() => { apply(); if (ms >= 320) didRef.current = true; }, ms)),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
