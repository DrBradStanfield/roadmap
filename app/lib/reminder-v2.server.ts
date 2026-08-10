/**
 * v2 email reminders — server half of the local-first §10 model.
 *
 * The server is a dumb scheduler. The BROWSER computes the reminder schedule
 * (health-core computeReminderSchedule) and pushes label+date items here; this
 * module stores them and the daily cron emails whatever is due. The server
 * holds the §10 minimum and nothing else:
 *   email (provider-verified) + due-item labels/dates + the capability token.
 * No user accounts, no health values, no cloud tokens at rest.
 *
 * The capability token is minted at opt-in and ALSO saved in the user's own
 * cloud file (so it follows them across devices). It is stored raw, not
 * hashed, because the daily cron must embed it in each email's unsubscribe
 * link — and §10 accepts the leak risk: the token can only touch the
 * reminder schedule (revoke + reissue if ever compromised).
 *
 * Provider email verification ("the cloud vouches for the address"):
 *  - google-drive: a signed ID token, verified via Google's tokeninfo endpoint
 *    (aud must be OUR client id). The Drive access token never touches us.
 *    Popup-fallback sessions have no ID token → one-time userinfo read instead.
 *  - dropbox: one-time get_current_account call with the access token —
 *    in memory, never stored (same transit-never-store posture as the AI §7).
 *  - github: one-time /user/emails read (needs the fine-grained PAT to have
 *    account permission "Email addresses: read" — the UI says so).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { REMINDER_CATEGORIES } from '../../packages/health-core/src/reminders';
import { supabaseAdmin } from './supabase.server';

// ---------------------------------------------------------------------------
// Types & validation
// ---------------------------------------------------------------------------

export type ReminderV2Provider = 'google-drive' | 'dropbox' | 'github';

export interface StoredScheduleItem {
  category: string;
  label: string;
  dueAt: string; // YYYY-MM-DD
}

export interface ReminderV2Optin {
  id: string;
  email: string;
  provider: ReminderV2Provider;
  schedule: StoredScheduleItem[];
  last_sent: Record<string, string>; // category → YYYY-MM-DD of last send
  token: string; // raw — the cron embeds it in the unsubscribe link
}

const CATEGORY_SET = new Set<string>(REMINDER_CATEGORIES);

/** Schedule payload from the client — length-capped, known categories only. */
export const scheduleSchema = z
  .array(
    z.object({
      category: z.string().refine((c) => CATEGORY_SET.has(c), 'unknown category'),
      label: z.string().min(1).max(80),
      dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  )
  .max(20);

// ---------------------------------------------------------------------------
// Capability token
// ---------------------------------------------------------------------------

export function mintCapabilityToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Provider email verification
// ---------------------------------------------------------------------------

export type ProviderProof =
  | { provider: 'google-drive'; idToken: string }
  | { provider: 'google-drive'; accessToken: string } // GIS popup fallback
  | { provider: 'dropbox'; accessToken: string }
  | { provider: 'github'; accessToken: string };

export type VerifyResult =
  | { email: string }
  | { reason: 'github-email-permission' | 'unverified' };

/**
 * Resolve the PROVIDER-VERIFIED email for an opt-in proof. On failure the
 * result carries a machine-readable reason (the route forwards it; the client
 * maps reason → copy — the server knows why, so the client never guesses).
 * Any provider credential seen here lives in memory for this one call and is
 * never stored or logged.
 */
export async function verifyProviderEmail(proof: ProviderProof): Promise<VerifyResult> {
  try {
    if (proof.provider === 'google-drive' && 'idToken' in proof) {
      // Google validates the signature; we check the token was minted for OUR app.
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(proof.idToken)}`,
      );
      if (!res.ok) return { reason: 'unverified' };
      const claims = (await res.json()) as Record<string, string>;
      const ourClientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
      if (!ourClientId || claims.aud !== ourClientId) return { reason: 'unverified' };
      if (claims.email_verified !== 'true' || !claims.email) return { reason: 'unverified' };
      return { email: claims.email.toLowerCase() };
    }

    if (proof.provider === 'google-drive') {
      // Popup-fallback session: no ID token exists, so do the same one-time
      // in-memory read the other providers use (requires the email scope).
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${proof.accessToken}` },
      });
      if (!res.ok) return { reason: 'unverified' };
      const info = (await res.json()) as { email?: string; email_verified?: boolean };
      if (!info.email || info.email_verified !== true) return { reason: 'unverified' };
      return { email: info.email.toLowerCase() };
    }

    if (proof.provider === 'dropbox') {
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proof.accessToken}` },
      });
      if (!res.ok) return { reason: 'unverified' };
      const account = (await res.json()) as { email?: string; email_verified?: boolean };
      if (!account.email || account.email_verified !== true) return { reason: 'unverified' };
      return { email: account.email.toLowerCase() };
    }

    // github
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${proof.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'health-plan-reminders',
      },
    });
    if (res.status === 403 || res.status === 404) return { reason: 'github-email-permission' };
    if (!res.ok) return { reason: 'unverified' };
    const emails = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return primary ? { email: primary.email.toLowerCase() } : { reason: 'unverified' };
  } catch {
    return { reason: 'unverified' };
  }
}

// ---------------------------------------------------------------------------
// DB operations (service role; table is RLS-deny to everyone else)
// ---------------------------------------------------------------------------

function requireAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin;
}

/** Create or replace an email's reminder opt-in. Returns the raw token. */
export async function upsertOptin(
  email: string,
  provider: ReminderV2Provider,
  schedule: StoredScheduleItem[],
): Promise<string> {
  const token = mintCapabilityToken();
  const { error } = await requireAdmin()
    .from('reminder_optin_v2')
    .upsert(
      {
        email: email.toLowerCase(),
        provider,
        token,
        schedule,
        last_sent: {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'email' },
    );
  if (error) throw new Error(`reminder_optin_v2 upsert failed: ${error.message}`);
  return token;
}

/** Replace the schedule for the opt-in owning this token. False = no such token. */
export async function updateScheduleByToken(
  token: string,
  schedule: StoredScheduleItem[],
): Promise<boolean> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .update({ schedule, updated_at: new Date().toISOString() })
    .eq('token', token)
    .select('id');
  if (error) throw new Error(`reminder_optin_v2 update failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Delete the opt-in owning this token (cancel / unsubscribe). */
export async function deleteByToken(token: string): Promise<boolean> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .delete()
    .eq('token', token)
    .select('id');
  if (error) throw new Error(`reminder_optin_v2 delete failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Delete the opt-in for an address (US-22 AC3/AC10 — the address bounced or
 * complained). Same DELETE semantics as unsubscribing by token: the row goes,
 * nothing is retained. Safe when no row exists, which is the common case since
 * most captured addresses never enrolled.
 */
export async function deleteByEmail(email: string): Promise<boolean> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .delete()
    .eq('email', email)
    .select('id');
  if (error) throw new Error(`reminder_optin_v2 delete-by-email failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Page through all reminder opt-ins (cron). */
export async function getOptinsBatch(
  limit: number,
  offset: number,
): Promise<ReminderV2Optin[]> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('id, email, provider, schedule, last_sent, token')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`reminder_optin_v2 select failed: ${error.message}`);
  return (data ?? []) as ReminderV2Optin[];
}

/** Record which categories were emailed today (re-send cooldown bookkeeping). */
export async function recordSent(
  id: string,
  lastSent: Record<string, string>,
): Promise<void> {
  const { error } = await requireAdmin()
    .from('reminder_optin_v2')
    .update({ last_sent: lastSent, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`reminder_optin_v2 recordSent failed: ${error.message}`);
}
