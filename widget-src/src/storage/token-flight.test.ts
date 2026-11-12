/**
 * US-09 AC47: one sign-in refresh at a time per page, per provider and
 * refresh token. The flight module's table. Synthetic tokens; no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { refreshOnce } from './token-flight';

/** A run whose promise settles only when the test says so. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const run = vi.fn(() => new Promise<T>((res, rej) => { resolve = res; reject = rej; }));
  return { run, resolve: (v: T) => resolve(v), reject: (e: unknown) => reject(e) };
}

describe('US-09 AC47: refreshOnce', () => {
  it('two callers join one flight: one run, the same result for both', async () => {
    const { run, resolve } = held<{ outcome: string }>();
    const first = refreshOnce('google-drive', 'test-refresh-a', run);
    const second = refreshOnce('google-drive', 'test-refresh-a', run);
    const answer = { outcome: 'ok' };
    resolve(answer);
    expect(await first).toBe(answer);
    expect(await second).toBe(answer);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a flight that fails: both callers see the same failure, and the module itself clears nothing', async () => {
    const { run, reject } = held<string>();
    const first = refreshOnce('dropbox', 'test-refresh-a', run);
    const second = refreshOnce('dropbox', 'test-refresh-a', run);
    const failure = new Error('test-failure');
    reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
    // What a refusal clears is the adapter's call (Drive: invalid_grant only);
    // the flight only hands the answer on and forgets the key.
    const next = held<string>();
    const third = refreshOnce('dropbox', 'test-refresh-a', next.run);
    next.resolve('again');
    await expect(third).resolves.toBe('again');
  });

  it('a caller arriving after the flight settled starts a new flight', async () => {
    const first = held<string>();
    const one = refreshOnce('google-drive', 'test-refresh-a', first.run);
    first.resolve('one');
    await one;
    const second = held<string>();
    const two = refreshOnce('google-drive', 'test-refresh-a', second.run);
    second.resolve('two');
    expect(await two).toBe('two');
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it('a different refresh token, or another provider, gets its own flight', async () => {
    const a = held<string>();
    const b = held<string>();
    const c = held<string>();
    const pa = refreshOnce('google-drive', 'test-refresh-a', a.run);
    const pb = refreshOnce('google-drive', 'test-refresh-b', b.run);
    const pc = refreshOnce('dropbox', 'test-refresh-a', c.run);
    a.resolve('a');
    b.resolve('b');
    c.resolve('c');
    expect([await pa, await pb, await pc]).toEqual(['a', 'b', 'c']);
    expect([a.run, b.run, c.run].map((run) => run.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('a run that throws before its first await still fails every caller and frees the key', async () => {
    const run = vi.fn((): Promise<string> => { throw new Error('test-sync-failure'); });
    await expect(refreshOnce('google-drive', 'test-refresh-c', run)).rejects.toThrow('test-sync-failure');
    const next = held<string>();
    const after = refreshOnce('google-drive', 'test-refresh-c', next.run);
    next.resolve('fresh');
    await expect(after).resolves.toBe('fresh');
  });
});
