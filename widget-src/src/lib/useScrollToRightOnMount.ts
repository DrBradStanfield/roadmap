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
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    el.scrollLeft = max;
    didRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
