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

type Settle = 'resolves' | 'rejects';
const failure = new Error('test-failure');

describe('US-09 AC47: refreshOnce', () => {
  it.each<Settle>(['resolves', 'rejects'])('two callers join one flight that %s: one run, the same outcome for both', async (settle) => {
    const flight = held<{ outcome: string }>();
    const first = refreshOnce('google-drive', 'test-refresh-a', flight.run);
    const second = refreshOnce('google-drive', 'test-refresh-a', flight.run);
    const answer = { outcome: 'ok' };
    if (settle === 'resolves') {
      flight.resolve(answer);
      expect(await first).toBe(answer);
      expect(await second).toBe(answer);
    } else {
      flight.reject(failure);
      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
    }
    expect(flight.run).toHaveBeenCalledTimes(1);
  });

  // What a refusal clears is the adapter's call (Drive: invalid_grant only);
  // the flight only hands the answer on and forgets the key.
  it.each([
    ['resolved', 'test-refresh-c', (key: string) => { const f = held<string>(); const p = refreshOnce('dropbox', key, f.run); f.resolve('one'); return p; }, 'one'],
    ['was refused', 'test-refresh-d', (key: string) => { const f = held<string>(); const p = refreshOnce('dropbox', key, f.run); f.reject(failure); return p; }, failure],
    ['threw before its first await', 'test-refresh-e', (key: string) => refreshOnce('dropbox', key, (): Promise<string> => { throw failure; }), failure],
  ])('after a flight that %s, the next caller starts a new flight', async (_label, key, settled, outcome) => {
    // The settled flight's own caller sees its answer, a throw included.
    expect(await settled(key).catch((error: unknown) => error)).toBe(outcome);
    const next = held<string>();
    const after = refreshOnce('dropbox', key, next.run);
    next.resolve('fresh');
    await expect(after).resolves.toBe('fresh');
    expect(next.run).toHaveBeenCalledTimes(1);
  });

  // Not in a table: three flights at once, each with its own key.
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
});
