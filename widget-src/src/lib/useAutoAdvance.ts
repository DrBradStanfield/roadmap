import { useEffect, useRef } from 'react';

/**
 * Auto-advance focus once a typed value is complete: fires immediately, or
 * after a short wait when the current digits could still extend to another
 * valid value (weight "25" might become "250"; inches "1" might become "11").
 * Owns the timer: each call cancels the previous pending advance, null only
 * cancels it (the value is no longer complete), and unmount cleans up. With
 * `frame`, an immediate advance waits for the next frame, also cancelled by
 * the next call. A wait ends in an advance only if, when it ends, the focus
 * is in the field where the value was typed (still, or back again): leaving
 * and coming back before it ends still advances (US-02 AC6b). "The field" is
 * the DOM element focused when the wait was scheduled: if the box remounts
 * during the wait (a layout change), there is no move, by design. The
 * field-specific "could this extend?" predicate stays at the call site.
 */
export function useAutoAdvance(frame = false): (opts: { ambiguous: boolean; advance: () => void } | null) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    timer.current = raf.current = null;
  };
  useEffect(() => cancel, []);
  return (opts) => {
    cancel();
    if (!opts) return;
    if (opts.ambiguous) {
      const from = document.activeElement;
      timer.current = setTimeout(() => { if (document.activeElement === from) opts.advance(); }, 800);
    }
    else if (frame) raf.current = requestAnimationFrame(opts.advance);
    else opts.advance();
  };
}
