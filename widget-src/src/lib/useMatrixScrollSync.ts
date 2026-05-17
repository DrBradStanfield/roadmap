import { useCallback, useEffect, useRef } from 'react';

/**
 * Shared horizontal-scroll synchronisation for matrix-style layouts where
 * each row has its own `overflow-x: auto` strip and rows must scroll in
 * lockstep — i.e. dragging row 3 also moves row 1's date headers + rows 2/4.
 *
 * Two consumers today: BloodTestTimeline (live blood-test matrix) and
 * ReviewTable (lab-upload review matrix). Improvements made here propagate
 * to both automatically.
 *
 * Usage:
 *   const sync = useMatrixScrollSync(columnsLength);
 *   <div ref={sync.registerHeader} onScroll={sync.onScroll}>…</div>
 *   {rows.map((r, i) =>
 *     <div ref={el => sync.registerRow(i, el)} onScroll={sync.onScroll}>…</div>
 *   )}
 *
 * Behaviour:
 *   - All registered scroll containers stay in sync horizontally.
 *   - On initial mount, scroll all containers to the rightmost position
 *     (newest column visible by default). Subsequent column-count changes
 *     do NOT re-yank the scroll position — a mid-review date edit that
 *     merges columns would otherwise scroll the user away from their work.
 */
export function useMatrixScrollSync(columnsLength: number) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<Array<HTMLDivElement | null>>([]);
  const isSyncingRef = useRef(false);
  const didInitRef = useRef(false);

  const registerHeader = useCallback((el: HTMLDivElement | null) => {
    headerRef.current = el;
  }, []);

  const registerRow = useCallback((index: number, el: HTMLDivElement | null) => {
    rowsRef.current[index] = el;
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isSyncingRef.current) return;
    const sl = (e.currentTarget as HTMLDivElement).scrollLeft;
    isSyncingRef.current = true;
    const targets = [headerRef.current, ...rowsRef.current];
    for (const el of targets) {
      if (el && el !== e.currentTarget) el.scrollLeft = sl;
    }
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  }, []);

  // Jump to far-right ONCE, after the first render that has scrollable
  // content. `columnsLength` is in deps so we re-try if the first render
  // had nothing to scroll (matrix data loads async). Once we've jumped,
  // didInitRef latches and subsequent column changes don't re-yank.
  useEffect(() => {
    if (didInitRef.current) return;
    const targets = [headerRef.current, ...rowsRef.current].filter(Boolean) as HTMLDivElement[];
    if (targets.length === 0) return;
    const max = targets[0].scrollWidth - targets[0].clientWidth;
    if (max <= 0) return;
    for (const el of targets) el.scrollLeft = max;
    didInitRef.current = true;
  }, [columnsLength]);

  return { registerHeader, registerRow, onScroll };
}
