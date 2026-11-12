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

export type ClaimOutcome = 'claimed' | 'spent' | 'unavailable';

/**
 * A plain INSERT: a unique violation (23505) means the key was claimed before.
 * Anything else, a missing table or client or a timeout included, is
 * 'unavailable', and the caller fails closed. Never `.update().select()` (CLAUDE.md gotcha).
 */
export async function claimSingleUse(key: string, kind: string): Promise<ClaimOutcome> {
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
  try {
    await supabaseAdmin.from('single_use_claims').delete().eq('kind', kind).lt('created_at', new Date(Date.now() - KEEP_MS).toISOString());
  } catch {
    // Housekeeping only: the claim stands, and the old rows go with the next one.
  }
  return 'claimed';
}
