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

const { claimSingleUse } = await import('./single-use-claims.server');
const { resetClaimsState } = await import('./single-use-claims.test-helpers');

beforeEach(() => resetClaimsState(claims.state!));
afterEach(() => vi.useRealTimers());

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
});
