#!/usr/bin/env tsx
/**
 * One-time repair for issue #309 (US-09 AC27a): link the profiles that the auth
 * trigger filed with no customer id between AC27 going live (2026-10-21) and
 * its fix. Supabase Auth inserts the user before it writes app_metadata, so
 * the trigger saw no customer id; the server then refused the link, and every
 * later turn hit "email exists" and stayed a guest.
 *
 * Candidates are every profile created since 2026-10-21 with no customer id,
 * read in pages (guests among them carry no proof and are skipped), so an
 * orphan whose refusal was never audited is found too. One is linked only
 * when all of these hold, each read over HTTPS:
 * - the profile's shopify_customer_id is null;
 * - its auth user's admin-written app_metadata names a customer (the proof);
 * - no profile already holds that customer id.
 * The write is conditional on the column still being null. Prints counts only.
 *
 * Usage (dry run is the default; --execute writes):
 *   npx tsx --env-file=.env tools/repair-trigger-first-links.ts
 *   npx tsx --env-file=.env tools/repair-trigger-first-links.ts --execute
 */
import { pathToFileURL } from 'url';
import { createClient } from '@supabase/supabase-js';

export interface Candidate {
  /** the profile's shopify_customer_id; undefined when no profile row exists */
  profileCustomerId: string | null | undefined;
  /** app_metadata.shopify_customer_id on the auth user, null when absent */
  proof: string | null;
  /** whether another profile already holds the proven customer id */
  proofTaken: boolean;
}

export type Verdict = 'link' | 'already_linked' | 'no_profile' | 'no_proof' | 'customer_taken';

export function verdict(c: Candidate): Verdict {
  if (c.profileCustomerId === undefined) return 'no_profile';
  if (c.profileCustomerId !== null) return 'already_linked';
  if (!c.proof) return 'no_proof';
  return c.proofTaken ? 'customer_taken' : 'link';
}

/** Every id the pager yields, page after page, until a short page. */
export async function allPages(page: (from: number, to: number) => Promise<string[]>, size = 500): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += size) {
    const batch = await page(from, from + size - 1);
    ids.push(...batch);
    if (batch.length < size) return ids;
  }
}

async function main(execute: boolean): Promise<void> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Not audit rows: a refusal that failed before its audit row still leaves an orphan.
  const ids = await allPages(async (from, to) => {
    const { data, error } = await db.from('profiles').select('id')
      .is('shopify_customer_id', null).gte('created_at', '2026-10-21').order('id').range(from, to);
    if (error) throw new Error('Profile scan failed');
    return (data ?? []).map((r) => r.id as string);
  });

  const counts: Record<Verdict | 'linked' | 'write_failed', number> =
    { link: 0, already_linked: 0, no_profile: 0, no_proof: 0, customer_taken: 0, linked: 0, write_failed: 0 };
  for (const id of ids) {
    const { data: profile, error: pErr } = await db.from('profiles').select('shopify_customer_id').eq('id', id).maybeSingle();
    if (pErr) throw new Error('Profile read failed');
    const { data: auth, error: aErr } = await db.auth.admin.getUserById(id);
    if (aErr) throw new Error('Auth user read failed');
    const proof = typeof auth.user?.app_metadata?.shopify_customer_id === 'string' ? auth.user.app_metadata.shopify_customer_id as string : null;
    let proofTaken = false;
    if (proof) {
      const { data: holder, error: hErr } = await db.from('profiles').select('id').eq('shopify_customer_id', proof).maybeSingle();
      if (hErr) throw new Error('Customer lookup failed');
      proofTaken = holder !== null;
    }
    const v = verdict({ profileCustomerId: profile ? profile.shopify_customer_id : undefined, proof, proofTaken });
    counts[v]++;
    if (v !== 'link' || !execute) continue;
    // No .select(): PostgREST returns [] after a self-mutating WHERE. Verify apart.
    const { error: wErr } = await db.from('profiles').update({ shopify_customer_id: proof }).eq('id', id).is('shopify_customer_id', null);
    const { data: after } = await db.from('profiles').select('id').eq('id', id).eq('shopify_customer_id', proof!).maybeSingle();
    if (wErr || !after) { counts.write_failed++; continue; }
    counts.linked++;
    await db.from('audit_logs').insert({ user_id: id, action: 'IDENTITY_LINK_REPAIRED', resource_type: 'user', resource_id: id });
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', candidates: ids.length, ...counts }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.includes('--execute')).catch((e) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
}
