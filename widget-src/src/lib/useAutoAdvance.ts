import { useEffect, useRef } from 'react';

/**
 * Auto-advance focus once a typed value is complete: fires immediately, or
 * after a short wait when the current digits could still extend to another
 * valid value (weight "25" might become "250"; inches "1" might become "11").
 * Owns the timer: each call cancels the previous pending advance, and unmount
 * cleans up. The field-specific "could this extend?" predicate stays at the
 * call site.
 */
export function useAutoAdvance(): (opts: { ambiguous: boolean; advance: () => void }) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return ({ ambiguous, advance }) => {
    if (timer.current) clearTimeout(timer.current);
    if (ambiguous) timer.current = setTimeout(advance, 800);
    else advance();
  };
}
