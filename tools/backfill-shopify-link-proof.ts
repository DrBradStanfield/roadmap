#!/usr/bin/env tsx
/**
 * One-time backfill for US-09 AC27: copy each linked profile's Shopify customer
 * id into its auth user's admin-written `app_metadata`, the only proof the
 * server now accepts. Without it every existing link answers as a guest.
 *
 * A link is copied only when the profile row (written by the server), the auth
 * user's `user_metadata` (written by `createUser`) and the account history
 * agree: the user never signed in (so never held a session that could edit its
 * own metadata), and no other user claims the same customer id. Everything else
 * is skipped and counted. Idempotent: a proven link is left alone.
 *
 * Prints counts only: no ids, emails or customer ids.
 *
 * Usage (dry run is the default; --execute writes):
 *   npx tsx --env-file=.env tools/backfill-shopify-link-proof.ts
 *   npx tsx --env-file=.env tools/backfill-shopify-link-proof.ts --execute
 */
import { pathToFileURL } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Meta = Record<string, unknown> | undefined;
export interface LinkRow {
  userId: string;
  customerId: string;
  /** null when the auth user could not be read */
  user: { app_metadata?: Meta; user_metadata?: Meta; last_sign_in_at?: string | null } | null;
}

export interface Plan {
  counts: {
    linked_profiles: number;
    already_proven: number;
    to_write: number;
    skipped_unreadable: number;
    skipped_app_metadata_conflict: number;
    skipped_user_metadata_missing: number;
    skipped_user_metadata_differs: number;
    skipped_signed_in: number;
    skipped_duplicate_claim: number;
  };
  writes: Array<{ userId: string; customerId: string; appMetadata: Record<string, unknown> }>;
}

const idOf = (meta: Meta) => (meta?.shopify_customer_id == null ? null : String(meta.shopify_customer_id));

/** Decide, without side effects, which links get admin-written proof. */
export function planBackfill(rows: LinkRow[]): Plan {
  const counts: Plan['counts'] = {
    linked_profiles: rows.length, already_proven: 0, to_write: 0, skipped_unreadable: 0,
    skipped_app_metadata_conflict: 0, skipped_user_metadata_missing: 0, skipped_user_metadata_differs: 0,
    skipped_signed_in: 0, skipped_duplicate_claim: 0,
  };
  const claims = new Map<string, number>();
  for (const row of rows) {
    const claim = idOf(row.user?.user_metadata);
    if (claim) claims.set(claim, (claims.get(claim) ?? 0) + 1);
  }
  const writes: Plan['writes'] = [];
  for (const { userId, customerId, user } of rows) {
    if (!user) { counts.skipped_unreadable++; continue; }
    const proven = idOf(user.app_metadata);
    if (proven === customerId) { counts.already_proven++; continue; }
    if (proven) { counts.skipped_app_metadata_conflict++; continue; }
    const claimed = idOf(user.user_metadata);
    if (!claimed) { counts.skipped_user_metadata_missing++; continue; }
    if (claimed !== customerId) { counts.skipped_user_metadata_differs++; continue; }
    if (user.last_sign_in_at) { counts.skipped_signed_in++; continue; }
    if ((claims.get(claimed) ?? 0) > 1) { counts.skipped_duplicate_claim++; continue; }
    counts.to_write++;
    writes.push({ userId, customerId, appMetadata: { ...(user.app_metadata ?? {}), shopify_customer_id: customerId } });
  }
  return { counts, writes };
}

async function readRows(admin: SupabaseClient): Promise<LinkRow[]> {
  const profiles: Array<{ id: string; shopify_customer_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('profiles').select('id, shopify_customer_id')
      .not('shopify_customer_id', 'is', null).order('id').range(from, from + 999);
    if (error) throw new Error('Profile read failed');
    profiles.push(...data);
    if (data.length < 1000) break;
  }
  const rows: LinkRow[] = [];
  for (const p of profiles) {
    const { data, error } = await admin.auth.admin.getUserById(p.id);
    rows.push({ userId: p.id, customerId: p.shopify_customer_id, user: error || !data?.user ? null : data.user });
  }
  return rows;
}

/** Dry run unless execute; returns the plan counts plus, on execute, written and verified counts. */
export async function run(admin: SupabaseClient, execute: boolean) {
  const plan = planBackfill(await readRows(admin));
  const result = { mode: execute ? 'execute' : 'dry-run', ...plan.counts, written: 0, verified: 0, write_failed: 0 };
  if (!execute) return result;
  for (const w of plan.writes) {
    const { error } = await admin.auth.admin.updateUserById(w.userId, { app_metadata: w.appMetadata });
    if (error) { result.write_failed++; continue; }
    result.written++;
    const { data } = await admin.auth.admin.getUserById(w.userId);
    if (idOf(data?.user?.app_metadata) === w.customerId) result.verified++;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required (npx tsx --env-file=.env ...)');
    process.exit(1);
  }
  const execute = process.argv.includes('--execute');
  run(createClient(url, key, { auth: { persistSession: false } }), execute)
    .then(result => console.log(JSON.stringify(result, null, 1)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Backfill failed'); process.exit(1); });
}
