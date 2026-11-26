/**
 * US-52 AC16: the one-use sets are bounded. The code set (and any set marked `oneUse`) keeps every
 * live id: room comes only from expired ids, and while every id held is live it refuses a new one,
 * saying so by name once an hour. The confirm-receipt set at its bound holds no new key, and the
 * shared claim store alone decides the claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
const shared = vi.hoisted(() => ({ claimed: new Set<string>(), up: true, calls: 0 }));
vi.mock('./single-use-claims.server', () => ({
  claimSingleUse: vi.fn(async (key: string) => {
    shared.calls++;
    if (!shared.up) return 'unavailable';
    if (shared.claimed.has(key)) return 'spent';
    shared.claimed.add(key);
    return 'claimed';
  }),
}));

import * as Sentry from '@sentry/react-router';
import { claimCode, claimProposal, CODE_LIFETIME_SECONDS, resetMcpMemory } from './mcp-grants.server';
import { createQuotaCounter, createRateLimiter, MAX_TRACKED_KEYS } from './rate-limiter';

const T0 = 1_000_000;

interface OneUseSet { name: string; lifeMs: number; maxKeys: number; take: (id: string) => boolean; reset: () => void }

const small = (make: (maxKeys: number) => (id: string) => boolean, name: string): OneUseSet => {
  let take = make(3);
  return { name, lifeMs: 1000, maxKeys: 3, take: (id) => take(id), reset: () => { take = make(3); } };
};

const SETS: OneUseSet[] = [
  { name: 'mcp spent codes', lifeMs: CODE_LIFETIME_SECONDS * 1000, maxKeys: MAX_TRACKED_KEYS, take: claimCode, reset: resetMcpMemory },
  small((maxKeys) => {
    const quota = createQuotaCounter(1, 1000, 100_000, { name: 'test one-use quota', maxKeys, oneUse: true });
    return (id) => quota.take(id, 1);
  }, 'test one-use quota'),
  small((maxKeys) => createRateLimiter(1, 1000, 100_000, { name: 'test one-use limiter', maxKeys, oneUse: true }), 'test one-use limiter'),
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const set of SETS) set.reset();
  resetMcpMemory();
  Object.assign(shared, { claimed: new Set<string>(), up: true, calls: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Fill the set with live ids, one ms apart from T0, so `id-0` expires first. */
function fill(set: OneUseSet): void {
  for (let i = 0; i < set.maxKeys; i++) {
    vi.setSystemTime(T0 + Math.min(i, set.lifeMs / 2));
    expect(set.take(`id-${i}`)).toBe(true);
  }
}

describe.each(SETS)('US-52 AC16: $name', (set) => {
  it('refuses a spent id for its whole life, and takes it again only after', () => {
    expect(set.take('a')).toBe(true);
    expect(set.take('a')).toBe(false);
    vi.setSystemTime(T0 + set.lifeMs - 1);
    expect(set.take('a')).toBe(false);
    vi.setSystemTime(T0 + set.lifeMs);
    expect(set.take('a')).toBe(true);
  });

  it('every id live at the bound: refuses a new id, forgets none, and says so by name alone', () => {
    fill(set);
    expect(set.take('new')).toBe(false);
    expect(set.take('another')).toBe(false);
    for (const i of [0, 1, set.maxKeys - 1]) expect(set.take(`id-${i}`)).toBe(false); // still spent
    const capture = vi.mocked(Sentry.captureMessage);
    expect(capture).toHaveBeenCalledTimes(1); // once an hour, not once a refusal
    expect(capture.mock.calls[0][1]).toEqual({ level: 'warning', tags: { feature: 'rate_limit', map: set.name } });
    expect(vi.mocked(console.error).mock.calls).toEqual([[`In-memory limit map full: ${set.name}`]]);
  });

  it('at the bound, with one id expired: room comes from that id, and every live one stays spent', () => {
    fill(set);
    vi.setSystemTime(T0 + set.lifeMs); // id-0 has expired; id-1 lives one ms longer
    expect(set.take('new')).toBe(true);
    expect(set.take('new')).toBe(false);
    expect(set.take('another')).toBe(false); // at the bound again, every id live
    expect(set.take('id-1')).toBe(false);
    expect(set.take(`id-${set.maxKeys - 1}`)).toBe(false);
  });
});

describe('US-52 AC16: mcp spent confirm receipts', () => {
  const LIFE = 15 * 60_000;
  const claim = (receipt: string, at = T0) => claimProposal(receipt, 'conn', LIFE, at);

  async function fillReceipts(): Promise<void> {
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) expect(await claim(`r-${i}`, T0 + Math.min(i, 1000))).toBe('claimed');
  }

  it('below the bound, this machine refuses a repeat without asking the store', async () => {
    expect(await claim('a')).toBe('claimed');
    const calls = shared.calls;
    expect(await claim('a', T0 + LIFE - 1)).toBe('spent');
    expect(shared.calls).toBe(calls);
  });

  it('every key live at the bound: a fresh receipt is decided by the shared store, once', async () => {
    await fillReceipts();
    const calls = shared.calls;
    expect(await claim('fresh', T0 + 2000)).toBe('claimed');
    expect(await claim('fresh', T0 + 2001)).toBe('spent'); // not held here: the store refuses it
    expect(shared.calls).toBe(calls + 2);
    expect(await claim('r-0', T0 + 2002)).toBe('spent'); // every held key still refused here
    expect(shared.calls).toBe(calls + 2);
    expect(vi.mocked(Sentry.captureMessage).mock.calls.map((c) => c[0])).toEqual(['In-memory limit map full']);
  });

  it('every key live at the bound, the store unavailable: the unavailable refusal, and nothing written', async () => {
    await fillReceipts();
    shared.up = false;
    expect(await claim('fresh', T0 + 2000)).toBe('unavailable');
    expect(shared.claimed.size).toBe(MAX_TRACKED_KEYS);
    shared.up = true;
    expect(await claim('fresh', T0 + 2001)).toBe('claimed'); // the retry asks the store, which decides
  });
});
