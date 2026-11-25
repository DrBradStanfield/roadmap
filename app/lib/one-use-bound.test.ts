/**
 * US-52 AC16: the one-use sets are bounded, and never forget a live spent id. Room comes only from
 * expired ids; a set full of live ones refuses the new id, holds every one it has, and says so by
 * name once an hour. One table, one row per structure, run through the same cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { CHALLENGE_TTL_MS } from './app-attest.server';
import { appLimits } from './app-gate.server';
import { claimCode, CODE_LIFETIME_SECONDS, resetMcpMemory } from './mcp-grants.server';
import { createQuotaCounter, createRateLimiter, MAX_TRACKED_KEYS } from './rate-limiter';

const T0 = 1_000_000;

interface OneUseSet { name: string; lifeMs: number; maxKeys: number; take: (id: string) => boolean; reset: () => void }

const small = (make: (maxKeys: number) => (id: string) => boolean, name: string): OneUseSet => {
  let take = make(3);
  return { name, lifeMs: 1000, maxKeys: 3, take: (id) => take(id), reset: () => { take = make(3); } };
};

const SETS: OneUseSet[] = [
  {
    name: 'app spent challenges',
    lifeMs: CHALLENGE_TTL_MS + 60_000,
    maxKeys: MAX_TRACKED_KEYS,
    take: (id) => appLimits.challenges.take(id, 1),
    reset: () => appLimits.challenges.reset(),
  },
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

  it('full of live ids: refuses a new id, forgets none, and says so by name alone', () => {
    fill(set);
    expect(set.take('new')).toBe(false);
    expect(set.take('another')).toBe(false);
    for (const i of [0, 1, set.maxKeys - 1]) expect(set.take(`id-${i}`)).toBe(false); // still spent
    const capture = vi.mocked(Sentry.captureMessage);
    expect(capture).toHaveBeenCalledTimes(1); // once an hour, not once a refusal
    expect(capture.mock.calls[0][1]).toEqual({ level: 'warning', tags: { feature: 'rate_limit', map: set.name } });
    expect(vi.mocked(console.error).mock.calls).toEqual([[`In-memory limit map full: ${set.name}`]]);
  });

  it('full, with one id expired: room comes from that id, and every live one stays spent', () => {
    fill(set);
    vi.setSystemTime(T0 + set.lifeMs); // id-0 has expired; id-1 lives one ms longer
    expect(set.take('new')).toBe(true);
    expect(set.take('new')).toBe(false);
    expect(set.take('another')).toBe(false); // full again, of live ids
    expect(set.take('id-1')).toBe(false);
    expect(set.take(`id-${set.maxKeys - 1}`)).toBe(false);
  });
});
