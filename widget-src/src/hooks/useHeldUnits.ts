import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { draftsHoldText } from '../lib/useMatrixDraft';

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
 * (`rootRef`), or a matrix draft holds text, by either of two sources:
 * - each matrix's own draft, as it reports it (`onMatrixHolds`): at mount, with
 *   what it restored, and on every change. A matrix never reports on unmount,
 *   so its last report stands while it is mounted again elsewhere. This one
 *   holds when another tab empties the copy kept on the device (Codex R2);
 * - the drafts kept on the device (`draftsHoldText`): they hold where no
 *   matrix on the page has reported one yet, as before a matrix mounts. A
 *   matrix mounted again (the window resized or turned across 768 px) reports
 *   at mount with what it restored (PR 1135 B1). No draft is kept while local
 *   health writes are stopped (US-09 AC2e); the reports alone hold then.
 * The drafts' own units are not stamped, so their text is read in the system
 * on screen when it commits.
 *
 * Events:
 * - `show(system)`: the load, or a re-read that brings another erase (US-11 AC6):
 *   applies at once, never held;
 * - `offer(system)`: any other re-read: applies at once when nothing is being
 *   typed, else held;
 * - the focus leaving a field in the root, or a matrix reporting its draft
 *   (`onMatrixHolds`): once nothing is being typed, the held system applies;
 * - the unit system changing here (the person's own switch): the held one is
 *   older, so it goes.
 * A record with no unit system leaves this device's as it is (useUnits).
 */
export function useHeldUnits(apply: (unitPref: unknown) => void, shown: string, rootRef: RefObject<HTMLElement | null>) {
  const held = useRef<unknown>(undefined);
  const matrices = useRef({ vitals: false, blood: false });
  const typing = useCallback(() => {
    const active = document.activeElement;
    return matrices.current.vitals || matrices.current.blood || draftsHoldText() || (!!active && !!rootRef.current?.contains(active) && active.matches('input, select, textarea'));
  }, [rootRef]);
  const show = useCallback((system: unknown) => { held.current = undefined; apply(system); }, [apply]);
  const offer = useCallback((system: unknown) => { if (typing()) held.current = system; else show(system); }, [typing, show]);
  const release = useCallback(() => { if (held.current !== undefined && !typing()) show(held.current); }, [typing, show]);
  const onMatrixHolds = useCallback((matrix: 'vitals' | 'blood', holds: boolean) => { matrices.current[matrix] = holds; release(); }, [release]);
  useEffect(() => { held.current = undefined; }, [shown]);
  // Read after the focus has moved: during focusout it is on the body even when it is going to another field.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusOut = () => requestAnimationFrame(release);
    root.addEventListener('focusout', onFocusOut);
    return () => root.removeEventListener('focusout', onFocusOut);
  }, [rootRef, release]);
  return { showUnits: show, offerUnits: offer, onMatrixHolds };
}
