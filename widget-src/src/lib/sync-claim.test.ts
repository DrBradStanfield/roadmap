// US-03 AC2a: the save's synchronous claim, shared by the three grids and the upload flow.
import { describe, expect, it } from 'vitest';
import { withClaim } from './sync-claim';

/** A run that waits until it is let go, counting its calls. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const run = async () => { calls += 1; await gate; };
  return { run, release, calls: () => calls };
}

describe('withClaim (US-03 AC2a)', () => {
  it('runs once, and refuses a second call made while the first runs', async () => {
    const claim = { current: false };
    const first = held();
    const one = withClaim(claim, first.run);
    expect(claim.current).toBe(true); // taken synchronously, before any await
    const other = held();
    await withClaim(claim, other.run);
    expect(other.calls()).toBe(0);
    first.release();
    await one;
    expect(first.calls()).toBe(1);
    expect(claim.current).toBe(false);
  });

  it('frees the claim after a throw, rethrows it, and runs again after', async () => {
    const claim = { current: false };
    const boom = new Error('test run failed');
    await expect(withClaim(claim, async () => { throw boom; })).rejects.toBe(boom);
    expect(claim.current).toBe(false);
    let ran = 0;
    await withClaim(claim, async () => { ran += 1; });
    expect(ran).toBe(1);
  });

  it('frees the claim after a run that throws before it returns a promise', async () => {
    const claim = { current: false };
    const run = (() => { throw new Error('test sync throw'); }) as () => Promise<unknown>;
    await expect(withClaim(claim, run)).rejects.toThrow('test sync throw');
    expect(claim.current).toBe(false);
  });
});
