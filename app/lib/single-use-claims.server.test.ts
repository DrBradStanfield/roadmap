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

const { claimSingleUse } = await import('./single-use-claims.server');
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
});
