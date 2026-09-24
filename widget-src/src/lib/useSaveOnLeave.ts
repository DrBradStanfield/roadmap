// When a matrix commits its draft (US-03 AC5; the draft is useMatrixDraft's):
// when the user LEAVES it, a tap or a focus outside `root`. Enter, the tick and
// the start of a lab upload commit through the matrix's own handler. Nothing
// else commits: not moving between cells, not the date picker (Safari never
// focuses its button, but the press lands inside), not a pause, and not the
// page being put away, which keeps the draft on the device and writes nothing.
// A touch outside that becomes a scroll is not leaving: the browser cancels
// that pointer, and a half-typed "3." must not be saved as 3.

import { useEffect, useRef, type RefObject } from 'react';

export function useSaveOnLeave(root: RefObject<HTMLElement>, save: () => unknown): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    // Leaving needs having been in: a value the chat offered to a matrix the
    // user never touched waits for them to review it. Typing counts as being
    // in: iOS leaves the focus in a cell after a tap on blank space, and a
    // second value typed there must commit on the next leave.
    let inside = false;
    // Pointers pressed outside and not cancelled: taps, until they lift.
    const pressedOutside = new Set<number>();
    const within = (e: Event) => !!root.current?.contains(e.target as Node);
    const leave = () => {
      if (!inside) return;
      inside = false;
      saveRef.current();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (within(e)) {
        inside = true;
        pressedOutside.delete(e.pointerId);
      } else pressedOutside.add(e.pointerId);
    };
    const onPointerCancel = (e: PointerEvent) => { pressedOutside.delete(e.pointerId); };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside.delete(e.pointerId) && !within(e)) leave();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (within(e)) inside = true;
      else leave();
    };
    const onInput = (e: Event) => { if (within(e)) inside = true; };

    const listeners = [
      ['pointerdown', onPointerDown],
      ['pointercancel', onPointerCancel],
      ['pointerup', onPointerUp],
      ['focusin', onFocusIn],
      ['input', onInput],
    ] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener as EventListener, true);
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener as EventListener, true);
    };
  }, [root]);
}
