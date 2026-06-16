import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Expose a component's "prefill" function to a parent via an optional external
 * ref, captured through an internal ref so the parent always calls the latest
 * closure (no stale draft/backfill state). Clears the external ref on unmount.
 *
 * Shared by BloodTestTimeline and StartingInfoVitals — both let the chatbot
 * inject a value into their matrix (highlighted, for the user to Save). The
 * external ref being non-null also signals to HealthTool that the matrix is
 * mounted, so it routes a chat edit there rather than to the plain form field.
 */
export function usePrefillRef<T extends (...args: never[]) => unknown>(
  impl: T,
  externalRef: MutableRefObject<T | null> | undefined,
): void {
  const internalRef = useRef(impl);
  internalRef.current = impl;
  useEffect(() => {
    if (!externalRef) return;
    externalRef.current = ((...args: Parameters<T>) => internalRef.current(...args)) as T;
    return () => { if (externalRef) externalRef.current = null; };
  }, [externalRef]);
}
