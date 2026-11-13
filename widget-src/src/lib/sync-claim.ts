/**
 * A save's claim, taken synchronously (US-03 AC2a). React state set by one
 * call is not seen by a second call in the same render, so two commits (Enter
 * and a tap outside, two presses of Add) would both start a save. A ref is
 * seen at once: `withClaim` runs `run` only while no other run holds the
 * claim, and frees it when the run ends, a throw too (which it rethrows).
 * Resolves true when `run` ran, false when the claim was already held.
 */
export async function withClaim(claim: { current: boolean }, run: () => Promise<unknown>): Promise<boolean> {
  if (claim.current) return false;
  claim.current = true;
  try {
    await run();
    return true;
  } finally {
    claim.current = false;
  }
}
