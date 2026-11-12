/**
 * Claims that work once across every machine and restart: one row per spent
 * key in `single_use_claims` (supabase/rls-policies.sql). The table is
 * content-free: the caller passes a hash, never the thing it names, and a kind.
 * Service role only.
 */
import { supabaseAdmin } from './supabase-client.server';

/** Rows older than this are deleted as each claim is made: every kind's claim lives less. */
const KEEP_MS = 60 * 60_000;
/** A claim not answered in this long is abandoned and reads as 'unavailable'. */
export const CLAIM_TIMEOUT_MS = 5_000;

const noop = (): void => undefined;

export type ClaimOutcome = 'claimed' | 'spent' | 'unavailable';
/** `createdAt`: the row's created_at exactly as PostgREST printed it (microseconds kept), or null if it did not say. */
export type ClaimResult = { outcome: 'claimed'; createdAt: string | null } | { outcome: 'spent' | 'unavailable' };

/**
 * A plain INSERT that returns its row's created_at (an insert with returning,
 * not the `.update().select()` trap in CLAUDE.md). A unique violation (23505)
 * means the key was claimed before. Anything else, a missing table or client
 * or an abort by `signal` included, is 'unavailable', and each caller decides
 * what that means.
 */
export async function insertClaim(key: string, kind: string, signal: AbortSignal): Promise<ClaimResult> {
  if (!supabaseAdmin) return { outcome: 'unavailable' };
  let reply: { data: { created_at?: unknown } | null; error: { code?: string } | null };
  try {
    reply = await supabaseAdmin.from('single_use_claims').insert({ key, kind }).select('created_at').abortSignal(signal).single();
  } catch {
    return { outcome: 'unavailable' };
  }
  if (reply.error) return { outcome: reply.error.code === '23505' ? 'spent' : 'unavailable' };
  const createdAt = reply.data?.created_at;
  return { outcome: 'claimed', createdAt: typeof createdAt === 'string' ? createdAt : null };
}

/** One claim on its own 5 s limit, then this kind's rows older than an hour go, never waited for. */
export async function claimSingleUse(key: string, kind: string): Promise<ClaimOutcome> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLAIM_TIMEOUT_MS);
  try {
    const { outcome } = await insertClaim(key, kind, abort.signal);
    // Housekeeping, never waited for: the claim stands whatever it does, and old rows go with a later claim.
    if (outcome === 'claimed') void sweepSingleUse(kind, KEEP_MS);
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deletes this kind's rows older than `keepMs`, on the caller's `signal` or its
 * own 5 s limit. Silent: a failure leaves them for the next sweep.
 */
export function sweepSingleUse(kind: string, keepMs: number, signal?: AbortSignal): Promise<void> {
  return bounded(() => supabaseAdmin?.from('single_use_claims').delete().eq('kind', kind).lt('created_at', new Date(Date.now() - keepMs).toISOString()), signal);
}

/**
 * Frees one claim: this key and kind, and only the row made at `createdAt`,
 * the exact string `insertClaim` returned, so a later claim of the same key
 * (after a sweep) is never touched. Bounded and silent, like the sweep.
 */
export function releaseSingleUse(key: string, kind: string, createdAt: string): Promise<void> {
  return bounded(() => supabaseAdmin?.from('single_use_claims').delete().eq('kind', kind).eq('key', key).eq('created_at', createdAt));
}

/** A delete with a time limit, so a stalled one lets go of its socket. Both outcomes are swallowed. */
function bounded(build: () => { abortSignal(signal: AbortSignal): PromiseLike<unknown> } | undefined, signal?: AbortSignal): Promise<void> {
  try {
    const query = build();
    return query ? Promise.resolve(query.abortSignal(signal ?? AbortSignal.timeout(CLAIM_TIMEOUT_MS))).then(noop, noop) : Promise.resolve();
  } catch {
    // A query that cannot even be built is the same: skipped.
    return Promise.resolve();
  }
}
