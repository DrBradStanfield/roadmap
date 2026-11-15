/**
 * How many lab reads `/api/app/v1/lab-read` runs at once (US-52 AC7e). In
 * memory, per process: each read holds its pages (a body of up to 25 MB) for up
 * to 90 s, on one machine with 1 GB of memory. The phone's lock no longer holds
 * one read at a time, so this does.
 */

/** Reads in flight on this machine; one more is refused before the gate. */
export const MAX_READS_IN_FLIGHT = 10;
/** Reads in flight for one verified key: the app sends at most 5 at once. */
export const MAX_READS_PER_KEY = 5;

export function createReadSlots(total = MAX_READS_IN_FLIGHT, perKey = MAX_READS_PER_KEY) {
  let inFlight = 0;
  const byKey = new Map<string, number>();
  /** A release that runs once, however often it is called. */
  const once = (free: () => void) => { let done = false; return () => { if (!done) { done = true; free(); } }; };
  return {
    /** A machine slot and its release, or null when the machine is full. */
    take(): (() => void) | null {
      if (inFlight >= total) return null;
      inFlight++;
      return once(() => { inFlight--; });
    },
    /** A slot for this key and its release, or null when the key has `perKey` in flight. */
    takeKey(keyId: string): (() => void) | null {
      const n = byKey.get(keyId) ?? 0;
      if (n >= perKey) return null;
      byKey.set(keyId, n + 1);
      return once(() => { const left = byKey.get(keyId)! - 1; if (left) byKey.set(keyId, left); else byKey.delete(keyId); });
    },
    inFlight: () => inFlight,
  };
}

export type ReadSlots = ReturnType<typeof createReadSlots>;
export const labReadSlots = createReadSlots();
