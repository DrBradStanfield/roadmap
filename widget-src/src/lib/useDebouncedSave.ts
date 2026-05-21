// Single shared timer for save-on-blur flows. `schedule(fn)` queues fn for
// `delayMs`, replacing any pending call. `flush()` runs the queued fn now.
// `cancel()` drops without firing. Cleans up on unmount.

import { useEffect, useRef } from 'react';

export interface DebouncedSave {
  schedule(fn: () => void): void;
  flush(): void;
  cancel(): void;
  /** Run `fn` now, cancelling anything currently scheduled. Use when a UI
   *  affordance (e.g. mobile commit ✓) needs to commit regardless of whether
   *  a prior blur had already queued a save — a plain `flush()` is a no-op on
   *  an empty queue. */
  commit(fn: () => void): void;
}

/** Pure factory — extracted so the timer behaviour can be unit-tested
 *  without a React renderer. The hook below ties cleanup to the component. */
export function createDebouncedSave(delayMs: number): DebouncedSave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  const cancel = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  const flush = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    const fn = pending;
    pending = null;
    if (fn) fn();
  };

  const schedule = (fn: () => void) => {
    if (timer != null) clearTimeout(timer);
    pending = fn;
    timer = setTimeout(() => {
      timer = null;
      const f = pending;
      pending = null;
      if (f) f();
    }, delayMs);
  };

  const commit = (fn: () => void) => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    fn();
  };

  return { schedule, flush, cancel, commit };
}

export function useDebouncedSave(delayMs: number = 500): DebouncedSave {
  const ref = useRef<DebouncedSave | null>(null);
  if (!ref.current) ref.current = createDebouncedSave(delayMs);
  // Drop pending timer on unmount; do NOT flush (component is gone, the
  // caller is responsible for any final-save coordination via beforeunload).
  useEffect(() => () => ref.current?.cancel(), []);
  return ref.current;
}
