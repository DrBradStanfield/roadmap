// When a typed blood pressure half moves the focus on by itself (US-02 AC6, US-75 AC2).
// One rule for both clients: the web's pressure boxes read it through
// widget-src/src/lib/blood-test-cell.ts, the iPhone's sheet through the engine's
// optional door `bpSysAdvance` (ios/engine/entry.ts, US-02 AC12).

/**
 * Systolic → diastolic auto-advance decision (US-02 AC6).
 * 'advance': unambiguous complete value (3 digits, 100–250) — move focus now.
 * 'defer': plausible 2-digit systolic (60–99) that the user might still extend —
 *          advance after a short pause unless another key arrives.
 * 'stay': prefix ('12' → 120), out-of-range, or non-numeric; and always while
 *         the diastolic holds text, so a typed diastolic is never jumped into.
 */
export type BpAdvance = 'advance' | 'defer' | 'stay';
export function bpSysAdvance(typed: string, diastolic = ''): BpAdvance {
  const t = typed.trim();
  if (diastolic !== '' || !/^\d+$/.test(t)) return 'stay';
  const n = Number(t);
  if (t.length >= 3) return n >= 100 && n <= 250 ? 'advance' : 'stay';
  if (t.length === 2) return n >= 60 && n <= 99 ? 'defer' : 'stay';
  return 'stay';
}

/** Diastolic → the next box (US-75 AC2): a complete diastolic, two digits 40–99 (no third digit
 *  stays in range) or three digits 100–150, moves on at once; anything else stays. */
export function bpDiaAdvance(typed: string): Exclude<BpAdvance, 'defer'> {
  const t = typed.trim();
  if (!/^\d{2,3}$/.test(t)) return 'stay';
  const n = Number(t);
  return n >= 40 && n <= 150 ? 'advance' : 'stay';
}
