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
const CLAIM_TIMEOUT_MS = 5_000;

const noop = (): void => undefined;

export type ClaimOutcome = 'claimed' | 'spent' | 'unavailable';

/**
 * A plain INSERT: a unique violation (23505) means the key was claimed before.
 * Anything else, a missing table or client or a timeout included, is
 * 'unavailable', and each caller decides what that means. Never `.update().select()` (CLAUDE.md gotcha).
 * `keepMs`: this kind's rows older than this go in the sweep after a claim.
 */
export async function claimSingleUse(key: string, kind: string, keepMs = KEEP_MS): Promise<ClaimOutcome> {
  if (!supabaseAdmin) return 'unavailable';
  let error: { code?: string } | null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLAIM_TIMEOUT_MS);
  try {
    ({ error } = await supabaseAdmin.from('single_use_claims').insert({ key, kind }).abortSignal(abort.signal));
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
  if (error) return error.code === '23505' ? 'spent' : 'unavailable';
  // Housekeeping, never waited for: the claim stands whatever it does, and old rows go with a later claim.
  void sweepSingleUse(kind, keepMs);
  return 'claimed';
}

/** Deletes this kind's rows older than `keepMs`. Bounded and silent: a failure leaves them for the next sweep. */
export function sweepSingleUse(kind: string, keepMs = KEEP_MS): Promise<void> {
  return bounded(() => supabaseAdmin?.from('single_use_claims').delete().eq('kind', kind).lt('created_at', new Date(Date.now() - keepMs).toISOString()));
}

/** Frees one claim so its key can be claimed again (a chat turn that ended). Bounded and silent, like the sweep. */
export function releaseSingleUse(key: string, kind: string): Promise<void> {
  return bounded(() => supabaseAdmin?.from('single_use_claims').delete().eq('kind', kind).eq('key', key));
}

/** A delete with the claim's own time limit, so a stalled one lets go of its socket. Both outcomes are swallowed. */
function bounded(build: () => { abortSignal(signal: AbortSignal): PromiseLike<unknown> } | undefined): Promise<void> {
  try {
    const query = build();
    return query ? Promise.resolve(query.abortSignal(AbortSignal.timeout(CLAIM_TIMEOUT_MS))).then(noop, noop) : Promise.resolve();
  } catch {
    // A query that cannot even be built is the same: skipped.
    return Promise.resolve();
  }
}
