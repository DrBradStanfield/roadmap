/**
 * US-36 AC9 · the claim store's own answers: a claim, a repeat, and a store
 * that does not answer in time. The flow over the wire is
 * `app/routes/mcp.hosted-guards.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimsState } from './single-use-claims.test-helpers';

const claims = vi.hoisted(() => ({ state: null as null | ClaimsState }));
vi.mock('./supabase-client.server', async (actual) => {
  const helpers = await import('./single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { claimSingleUse, insertClaim, releaseSingleUse, sweepSingleUse } = await import('./single-use-claims.server');
const { resetClaimsState } = await import('./single-use-claims.test-helpers');
const Sentry = await import('@sentry/react-router');

/** Settles after the pending microtasks and one macrotask, without moving any clock past 5 s. */
const PENDING = () => new Promise((resolve) => setTimeout(() => resolve('pending'), 20));

beforeEach(() => resetClaimsState(claims.state!));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('US-36 AC9 — a single-use claim', () => {
  it('claims a key once, then answers spent', async () => {
    expect(await claimSingleUse('a'.repeat(64), 'mcp-confirm')).toBe('claimed');
    expect(await claimSingleUse('a'.repeat(64), 'mcp-confirm')).toBe('spent');
  });

  it('a store that does not answer within five seconds reads as unavailable', async () => {
    vi.useFakeTimers();
    claims.state!.down = 'hang';
    let outcome: string | undefined;
    void claimSingleUse('b'.repeat(64), 'mcp-confirm').then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome).toBe('unavailable');
  });

  it('the old-row cleanup is not waited for: a cleanup that never settles still answers claimed at once', async () => {
    claims.state!.cleanup = 'hang';
    expect(await Promise.race([claimSingleUse('c'.repeat(64), 'mcp-confirm'), PENDING()])).toBe('claimed');
  });

  it('a cleanup that fails, or throws as it is built, changes nothing and says nothing', async () => {
    // A process listener, so a rejection left unhandled fails here by name rather than only through vitest's own report.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    try {
      for (const cleanup of ['reject', 'build-throws'] as const) {
        claims.state!.cleanup = cleanup;
        expect(await claimSingleUse(`${cleanup}`.padEnd(64, 'd'), 'mcp-confirm'), cleanup).toBe('claimed');
      }
      await PENDING();
      expect(unhandled).toEqual([]);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('the old-row cleanup is sent with a five-second abort, so a stalled one lets go of its socket (C16 follow-up)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    claims.state!.cleanup = 'hang';
    expect(await claimSingleUse('e'.repeat(64), 'mcp-confirm')).toBe('claimed');
    expect(timeout).toHaveBeenCalledWith(5_000);
    const [signal] = claims.state!.deleteSignals;
    expect(signal).toBe(timeout.mock.results.at(-1)!.value);
  });

  it('insertClaim answers the row created_at exactly as the store printed it, microseconds and offset kept', async () => {
    const abort = new AbortController();
    const claim = await insertClaim('7'.repeat(64), 'chat-turn', abort.signal);
    expect(claim.outcome).toBe('claimed');
    const createdAt = claim.outcome === 'claimed' ? claim.createdAt : null;
    expect(createdAt).toBe(claims.state!.rows.get('7'.repeat(64))!.createdAtIso);
    expect(createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
    expect((await insertClaim('7'.repeat(64), 'chat-turn', abort.signal)).outcome).toBe('spent');
    claims.state!.down = 'error';
    expect((await insertClaim('8'.repeat(64), 'chat-turn', abort.signal)).outcome).toBe('unavailable');
  });

  it("a sweep is waited for, removes only that kind's old rows, and runs on the caller's deadline when given one", async () => {
    claims.state!.rows.set('1'.repeat(64), { kind: 'chat-turn', createdAt: Date.now() - 200_000 });
    claims.state!.rows.set('2'.repeat(64), { kind: 'chat-turn', createdAt: Date.now() - 100_000 });
    claims.state!.rows.set('3'.repeat(64), { kind: 'mcp-confirm', createdAt: Date.now() - 200_000 });
    const deadline = new AbortController();
    await sweepSingleUse('chat-turn', 180_000, deadline.signal);
    expect([...claims.state!.rows.keys()].sort()).toEqual(['2'.repeat(64), '3'.repeat(64)]);
    expect(claims.state!.deleteSignals).toEqual([deadline.signal]);
  });

  it('a release deletes only its own row: key, kind and the exact created_at string', async () => {
    const abort = new AbortController();
    const mine = await insertClaim('5'.repeat(64), 'chat-turn', abort.signal);
    const createdAt = mine.outcome === 'claimed' ? mine.createdAt! : '';
    // The same instant after a JS Date round trip loses the microseconds: it names no row.
    await releaseSingleUse('5'.repeat(64), 'chat-turn', new Date(createdAt).toISOString());
    await releaseSingleUse('5'.repeat(64), 'mcp-confirm', createdAt);
    expect(claims.state!.rows.has('5'.repeat(64))).toBe(true);
    await releaseSingleUse('5'.repeat(64), 'chat-turn', createdAt);
    expect(claims.state!.rows.has('5'.repeat(64))).toBe(false);
    expect(claims.state!.deleteFilters.at(-1)).toEqual([['eq', 'kind', 'chat-turn'], ['eq', 'key', '5'.repeat(64)], ['eq', 'created_at', createdAt]]);
    expect(claims.state!.deleteSignals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("a release after a twin re-claimed the key leaves the twin's row", async () => {
    const abort = new AbortController();
    const first = await insertClaim('6'.repeat(64), 'chat-turn', abort.signal);
    const firstAt = first.outcome === 'claimed' ? first.createdAt! : '';
    claims.state!.rows.delete('6'.repeat(64)); // swept past the TTL
    expect((await insertClaim('6'.repeat(64), 'chat-turn', abort.signal)).outcome).toBe('claimed');
    await releaseSingleUse('6'.repeat(64), 'chat-turn', firstAt);
    expect(claims.state!.rows.has('6'.repeat(64))).toBe(true);
  });

  it('a release swallows a failed or unbuildable delete', async () => {
    for (const cleanup of ['reject', 'build-throws'] as const) {
      claims.state!.cleanup = cleanup;
      await expect(releaseSingleUse('6'.repeat(64), 'chat-turn', '2026-11-12T08:15:33.123456+00:00')).resolves.toBeUndefined();
    }
  });
});
