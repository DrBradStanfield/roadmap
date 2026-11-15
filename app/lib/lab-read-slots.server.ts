/**
 * How many lab reads `/api/app/v1/lab-read` runs at once (US-52 AC7e). In
 * memory, per process: each read holds its pages (a body of up to 25 MB) for up
 * to 90 s, on one machine with 1 GB of memory. The phone's lock no longer holds
 * one read at a time, so this does. The gate admits a read through `admit`, once
 * its signature verifies and before it charges anything (app-gate.server.ts).
 */

/** Reads in flight on this machine. */
export const MAX_READS_IN_FLIGHT = 10;
/** Reads in flight for one verified key: the app sends at most 5 at once. */
export const MAX_READS_PER_KEY = 5;

export function createReadSlots(total = MAX_READS_IN_FLIGHT, perKey = MAX_READS_PER_KEY) {
  let inFlight = 0;
  const byKey = new Map<string, number>();
  return {
    /** A machine slot and a slot for this key together, and one release that runs once; or null, holding neither. */
    admit(keyId: string): (() => void) | null {
      const n = byKey.get(keyId) ?? 0;
      if (inFlight >= total || n >= perKey) return null;
      inFlight++;
      byKey.set(keyId, n + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        inFlight--;
        const left = byKey.get(keyId)! - 1;
        if (left) byKey.set(keyId, left); else byKey.delete(keyId);
      };
    },
    inFlight: () => inFlight,
  };
}

export type ReadSlots = ReturnType<typeof createReadSlots>;
export const labReadSlots = createReadSlots();
