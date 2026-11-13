/**
 * A save's claim, taken synchronously (US-03 AC2a). React state set by one
 * call is not seen by a second call in the same render, so two commits (Enter
 * and a tap outside, two presses of Add) would both start a save. A ref is
 * seen at once: `withClaim` runs `run` only while no other run holds the
 * claim, and frees it when the run ends, a throw too (which it rethrows).
 * A call made while the claim is held does nothing.
 */
export async function withClaim(claim: { current: boolean }, run: () => Promise<unknown>): Promise<void> {
  if (claim.current) return;
  claim.current = true;
  try {
    await run();
  } finally {
    claim.current = false;
  }
}
