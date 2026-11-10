import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * The record's unit system on screen, shown or held (US-34 AC7, US-04 AC1).
 *
 * A unit switch from another device never changes the meaning of a number
 * already typed. The typed text is read in the unit system on screen, so a
 * re-read that switched it mid-number would save "180" lb as 180 kg. Two states:
 * - shown: the page shows the record's unit system;
 * - held: a re-read brought one while something is being typed. The page keeps
 *   the system it shows, and the record's waits.
 *
 * "Being typed": the focus is in an input, select or textarea inside the tool
 * (`rootRef`), or a matrix draft holds text (InputPanel's `onDraftsHold`). The
 * drafts' own units are not stamped, so their text is read in the system on
 * screen when it commits.
 *
 * Events:
 * - `show(system)`: the load, or a re-read that brings another erase (US-11 AC6):
 *   applies at once, never held;
 * - `offer(system)`: any other re-read: applies at once when nothing is being
 *   typed, else held;
 * - the focus leaving a field in the root, or the drafts emptying: once nothing
 *   is being typed, the held system applies;
 * - the unit system changing here (the person's own switch): the held one is
 *   older, so it goes.
 * A record with no unit system leaves this device's as it is (useUnits).
 */
export function useHeldUnits(apply: (unitPref: unknown) => void, shown: string, rootRef: RefObject<HTMLElement | null>) {
  const held = useRef<unknown>(undefined);
  const draftsHold = useRef(false);
  const typing = useCallback(() => {
    const active = document.activeElement;
    return draftsHold.current || (!!active && !!rootRef.current?.contains(active) && active.matches('input, select, textarea'));
  }, [rootRef]);
  const show = useCallback((system: unknown) => { held.current = undefined; apply(system); }, [apply]);
  const offer = useCallback((system: unknown) => { if (typing()) held.current = system; else show(system); }, [typing, show]);
  const release = useCallback(() => { if (held.current !== undefined && !typing()) show(held.current); }, [typing, show]);
  const onDraftsHold = useCallback((holds: boolean) => { draftsHold.current = holds; release(); }, [release]);
  useEffect(() => { held.current = undefined; }, [shown]);
  // Read after the focus has moved: during focusout it is on the body even when it is going to another field.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusOut = () => requestAnimationFrame(release);
    root.addEventListener('focusout', onFocusOut);
    return () => root.removeEventListener('focusout', onFocusOut);
  }, [rootRef, release]);
  return { showUnits: show, offerUnits: offer, onDraftsHold };
}
