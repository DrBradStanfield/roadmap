#!/usr/bin/env tsx
/**
 * One-time backfill for US-09 AC27: copy each linked profile's Shopify customer
 * id into its auth user's admin-written `app_metadata`, the only proof the
 * server now accepts. Without it every existing link answers as a guest.
 *
 * A link is copied only when all of these hold:
 * - the auth user was made by our server: admin `createUser({ email_confirm: true })`
 *   confirms the email in the same instant and sends no confirmation email. A
 *   public sign-up with email confirmation on gets `confirmation_sent_at` and
 *   confirms later or never. Under autoconfirm it would get neither and pass
 *   this gate; the never-signed-in gate below carries that case, and public
 *   sign-up is off before this runs (runbook step a);
 * - the profile row and the user's `user_metadata` name the same customer;
 * - the user never signed in, so never held a session that could edit its own metadata;
 * - no other auth user, linked or not, claims that customer id in either metadata.
 * Everything else is skipped and counted. Idempotent: a proven link is left alone.
 *
 * Reads every auth user through SESSION_DATABASE_URL in a READ ONLY transaction
 * (the admin API cannot list every user: listUsers fails past ~300 rows). That
 * connection does not verify the server certificate, so it only narrows the
 * candidates: each is read again over HTTPS (admin getUserById plus the profile
 * row) and every gate runs on that record; a disagreement skips it. Writes go
 * through the admin API. Prints counts only.
 *
 * Accepted residual (orchestrator, 2026-10-21): the duplicate-claimant gate
 * still rests on the pg read alone, since no HTTPS API lists every user. Only
 * someone able to intercept that connection during this one-off admin run could
 * hide a second claimant; live showed 0 duplicates, and sign-up is off first.
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

type Verdict = Exclude<keyof Plan['counts'], 'auth_users' | 'linked_profiles'>;

/** Every gate, in order, for one linked user; `claimants` maps a customer id to the users claiming it. */
function classify(u: AuthRow, claimants: Map<string, Set<string>>): Verdict {
  const customerId = u.profileCustomerId!;
  if (u.appClaim === customerId) return 'already_proven';
  if (u.appClaim) return 'skipped_app_metadata_conflict';
  if (!serverCreated(u)) return 'skipped_not_server_created';
  if (!u.userClaim) return 'skipped_user_metadata_missing';
  if (u.userClaim !== customerId) return 'skipped_user_metadata_differs';
  if (u.lastSignInAt) return 'skipped_signed_in';
  if ((claimants.get(customerId)?.size ?? 0) > 1) return 'skipped_duplicate_claim';
  return 'to_write';
}

/** Decide, without side effects, which links get admin-written proof. */
export function planBackfill(users: AuthRow[]): Plan & { claimants: Map<string, Set<string>> } {
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
    const verdict = classify(u, claimants);
    counts[verdict]++;
    if (verdict === 'to_write') {
      writes.push({ userId: u.id, customerId: u.profileCustomerId!, appMetadata: { ...u.appMetadata, shopify_customer_id: u.profileCustomerId! } });
    }
  }
  return { counts, writes, claimants };
}

export interface Deps {
  readRows: () => Promise<AuthRow[]>;
  /** The same row read again over HTTPS (admin API + REST), or null if it cannot be read. */
  confirm: (userId: string) => Promise<AuthRow | null>;
  update: (userId: string, appMetadata: Record<string, unknown>) => Promise<boolean>;
  readAppClaim: (userId: string) => Promise<string | null>;
}

/**
 * Dry run unless execute. The pg read is not certificate-verified, so it only
 * narrows candidates: each one is read again over HTTPS and every gate runs on
 * that record; any disagreement skips it. Returns counts only.
 */
export async function run(deps: Deps, execute: boolean) {
  const plan = planBackfill(await deps.readRows());
  const result = {
    mode: execute ? 'execute' : 'dry-run', ...plan.counts,
    confirmed: 0, skipped_admin_mismatch: 0, written: 0, verified: 0, write_failed: 0,
  };
  const confirmed: Plan['writes'] = [];
  for (const w of plan.writes) {
    const fresh = await deps.confirm(w.userId);
    if (!fresh || fresh.id !== w.userId || fresh.profileCustomerId !== w.customerId
      || classify(fresh, plan.claimants) !== 'to_write') { result.skipped_admin_mismatch++; continue; }
    result.confirmed++;
    confirmed.push({ ...w, appMetadata: { ...fresh.appMetadata, shopify_customer_id: w.customerId } });
  }
  if (!execute) return result;
  for (const w of confirmed) {
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
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const admin = supabase.auth.admin;
  const text = (v: unknown) => (v == null ? null : String(v));
  run({
    readRows: () => readRows(databaseUrl),
    confirm: async id => {
      const { data, error } = await admin.getUserById(id);
      const u = data?.user;
      if (error || !u) return null;
      const profile = await supabase.from('profiles').select('shopify_customer_id').eq('id', id).maybeSingle();
      if (profile.error || !profile.data) return null;
      return {
        id: u.id, createdAt: u.created_at, emailConfirmedAt: u.email_confirmed_at ?? null,
        confirmationSentAt: u.confirmation_sent_at ?? null, lastSignInAt: u.last_sign_in_at ?? null,
        userClaim: text(u.user_metadata?.shopify_customer_id), appClaim: text(u.app_metadata?.shopify_customer_id),
        appMetadata: u.app_metadata ?? {}, profileCustomerId: profile.data.shopify_customer_id,
      };
    },
    update: async (id, appMetadata) => !(await admin.updateUserById(id, { app_metadata: appMetadata })).error,
    readAppClaim: async id => {
      const claim = (await admin.getUserById(id)).data?.user?.app_metadata?.shopify_customer_id;
      return claim == null ? null : String(claim);
    },
  }, process.argv.includes('--execute'))
    .then(result => console.log(JSON.stringify(result, null, 1)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Backfill failed'); process.exit(1); });
}
