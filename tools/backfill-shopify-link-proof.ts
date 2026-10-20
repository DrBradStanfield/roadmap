#!/usr/bin/env tsx
/**
 * One-time backfill for US-09 AC27: copy each linked profile's Shopify customer
 * id into its auth user's admin-written `app_metadata`, the only proof the
 * server now accepts. Without it every existing link answers as a guest.
 *
 * A link is copied only when all of these hold:
 * - the auth user was made by our server: admin `createUser({ email_confirm: true })`
 *   confirms the email in the same instant and sends no confirmation email,
 *   while a public sign-up gets `confirmation_sent_at` and confirms later or never;
 * - the profile row and the user's `user_metadata` name the same customer;
 * - the user never signed in, so never held a session that could edit its own metadata;
 * - no other auth user, linked or not, claims that customer id in either metadata.
 * Everything else is skipped and counted. Idempotent: a proven link is left alone.
 *
 * Reads auth.users through SESSION_DATABASE_URL in a READ ONLY transaction (the
 * admin API exposes neither confirmation_sent_at nor every user: listUsers fails
 * past ~300 rows); writes through the Supabase admin API. Prints counts only.
 *
 * Usage (dry run is the default; --execute writes):
 *   npx tsx --env-file=.env tools/backfill-shopify-link-proof.ts
 *   npx tsx --env-file=.env tools/backfill-shopify-link-proof.ts --execute
 */
import { pathToFileURL } from 'url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

export interface AuthRow {
  id: string;
  createdAt: string;
  emailConfirmedAt: string | null;
  confirmationSentAt: string | null;
  lastSignInAt: string | null;
  userClaim: string | null;
  appClaim: string | null;
  appMetadata: Record<string, unknown>;
  /** the profile's shopify_customer_id, null when unlinked */
  profileCustomerId: string | null;
}

export interface Plan {
  counts: {
    auth_users: number;
    linked_profiles: number;
    already_proven: number;
    to_write: number;
    skipped_not_server_created: number;
    skipped_app_metadata_conflict: number;
    skipped_user_metadata_missing: number;
    skipped_user_metadata_differs: number;
    skipped_signed_in: number;
    skipped_duplicate_claim: number;
  };
  writes: Array<{ userId: string; customerId: string; appMetadata: Record<string, unknown> }>;
}

/** createUser with email_confirm stamps the confirmation within milliseconds. */
const SERVER_CONFIRM_WINDOW_MS = 5_000;
const serverCreated = (u: AuthRow) => u.confirmationSentAt == null && u.emailConfirmedAt != null
  && Math.abs(Date.parse(u.emailConfirmedAt) - Date.parse(u.createdAt)) <= SERVER_CONFIRM_WINDOW_MS;

/** Decide, without side effects, which links get admin-written proof. */
export function planBackfill(users: AuthRow[]): Plan {
  const claimants = new Map<string, Set<string>>();
  for (const u of users) {
    for (const claim of [u.userClaim, u.appClaim]) {
      if (claim) claimants.set(claim, (claimants.get(claim) ?? new Set()).add(u.id));
    }
  }
  const linked = users.filter(u => u.profileCustomerId);
  const counts: Plan['counts'] = {
    auth_users: users.length, linked_profiles: linked.length, already_proven: 0, to_write: 0,
    skipped_not_server_created: 0, skipped_app_metadata_conflict: 0, skipped_user_metadata_missing: 0,
    skipped_user_metadata_differs: 0, skipped_signed_in: 0, skipped_duplicate_claim: 0,
  };
  const writes: Plan['writes'] = [];
  for (const u of linked) {
    const customerId = u.profileCustomerId!;
    if (u.appClaim === customerId) { counts.already_proven++; continue; }
    if (u.appClaim) { counts.skipped_app_metadata_conflict++; continue; }
    if (!serverCreated(u)) { counts.skipped_not_server_created++; continue; }
    if (!u.userClaim) { counts.skipped_user_metadata_missing++; continue; }
    if (u.userClaim !== customerId) { counts.skipped_user_metadata_differs++; continue; }
    if (u.lastSignInAt) { counts.skipped_signed_in++; continue; }
    if (claimants.get(customerId)!.size > 1) { counts.skipped_duplicate_claim++; continue; }
    counts.to_write++;
    writes.push({ userId: u.id, customerId, appMetadata: { ...u.appMetadata, shopify_customer_id: customerId } });
  }
  return { counts, writes };
}

export interface Deps {
  readRows: () => Promise<AuthRow[]>;
  update: (userId: string, appMetadata: Record<string, unknown>) => Promise<boolean>;
  readAppClaim: (userId: string) => Promise<string | null>;
}

/** Dry run unless execute; returns the plan counts plus, on execute, written and verified counts. */
export async function run(deps: Deps, execute: boolean) {
  const plan = planBackfill(await deps.readRows());
  const result = { mode: execute ? 'execute' : 'dry-run', ...plan.counts, written: 0, verified: 0, write_failed: 0 };
  if (!execute) return result;
  for (const w of plan.writes) {
    if (!(await deps.update(w.userId, w.appMetadata))) { result.write_failed++; continue; }
    result.written++;
    if ((await deps.readAppClaim(w.userId)) === w.customerId) result.verified++;
  }
  return result;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function readRows(databaseUrl: string): Promise<AuthRow[]> {
  const db = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await db.query(`
      SELECT u.id, u.created_at, u.email_confirmed_at, u.confirmation_sent_at, u.last_sign_in_at,
             u.raw_user_meta_data->>'shopify_customer_id' AS user_claim,
             u.raw_app_meta_data->>'shopify_customer_id' AS app_claim,
             coalesce(u.raw_app_meta_data, '{}'::jsonb) AS app_metadata,
             p.shopify_customer_id AS profile_customer_id
      FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id`);
    await db.query('ROLLBACK');
    return rows.map(r => ({
      id: r.id, createdAt: iso(r.created_at)!, emailConfirmedAt: iso(r.email_confirmed_at),
      confirmationSentAt: iso(r.confirmation_sent_at), lastSignInAt: iso(r.last_sign_in_at),
      userClaim: r.user_claim, appClaim: r.app_claim, appMetadata: r.app_metadata, profileCustomerId: r.profile_customer_id,
    }));
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, SESSION_DATABASE_URL: databaseUrl } = process.env;
  if (!url || !key || !databaseUrl) {
    console.error('SUPABASE_URL, SUPABASE_SERVICE_KEY and SESSION_DATABASE_URL are required (npx tsx --env-file=.env ...)');
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } }).auth.admin;
  run({
    readRows: () => readRows(databaseUrl),
    update: async (id, appMetadata) => !(await admin.updateUserById(id, { app_metadata: appMetadata })).error,
    readAppClaim: async id => {
      const claim = (await admin.getUserById(id)).data?.user?.app_metadata?.shopify_customer_id;
      return claim == null ? null : String(claim);
    },
  }, process.argv.includes('--execute'))
    .then(result => console.log(JSON.stringify(result, null, 1)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Backfill failed'); process.exit(1); });
}
