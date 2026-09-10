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
 * Email verification (Brad, 2026-09-10 — no storage credential ever reaches
 * this server):
 *  - google-drive: a signed ID token, verified via Google's tokeninfo endpoint
 *    (aud must be OUR client id). It grants nothing; the Drive access token
 *    never touches us. The old popup fallback (a Drive ACCESS token) is gone.
 *  - dropbox / github / typed: the BROWSER reads the account email from the
 *    provider and sends only the address. The server cannot tell that address
 *    from a typed one, so every such write goes through enrolByEmail's
 *    existing-row rule (refresh only, never a token) — the same posture the
 *    typed lane has held since US-23.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { REMINDER_CATEGORIES } from '../../packages/health-core/src/reminders';
import { SCHEDULE_LABELS } from '../../packages/health-core/src/reminder-schedule';
import { APP_BASE_URL } from './email.server';
import { supabaseAdmin } from './supabase.server';

// ---------------------------------------------------------------------------
// Types & validation
// ---------------------------------------------------------------------------

/**
 * 'typed' (US-23) is the lane where the address was TYPED at the PDF capture.
 * Since 2026-09-10 every lane's consent gate is delivery: the plan-ready email
 * (US-22) must not bounce, and the cron holds a 3-day quiet period before the
 * first reminder so the bounce/complaint webhook has time to un-enrol a bad
 * address. 'google-drive' means VERIFIED: only upsertVerifiedOptin writes it,
 * from a signed ID token. The widget's no-ID-token Drive fallback enrols as
 * 'typed', so the column doubles as the proof flag (review 2026-09-10).
 */
export type ReminderV2Provider = 'google-drive' | 'dropbox' | 'github' | 'typed';

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
  created_at: string; // ISO — the typed lane's quiet period is measured from this
}

const CATEGORY_SET = new Set<string>(REMINDER_CATEGORIES);

/**
 * Schedule payload from the client — length-capped, known categories only, and
 * labels validated against health-core's SCHEDULE_LABELS allow-list. Labels
 * stopped being free text the day the typed lane opened (US-23 AC8): a cloud
 * opt-in can only email its own verified address, but a typed enrolment names
 * someone ELSE'S inbox — an 80-char free-text field here would be an
 * attacker-controlled message delivered by our sender domain.
 */
export const scheduleSchema = z
  .array(
    z
      .object({
        category: z.string().refine((c) => CATEGORY_SET.has(c), 'unknown category'),
        label: z.string().min(1).max(80),
        dueAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          // A regex-valid impossible date ('2026-99-99') survives to the email
          // builders, where new Date().toISOString() THROWS — poisoning every
          // future send for that row (daily cron error, no email, forever).
          .refine((d) => !Number.isNaN(Date.parse(d)), 'not a real date'),
      })
      .refine(
        (item) => (SCHEDULE_LABELS[item.category as keyof typeof SCHEDULE_LABELS] ?? []).includes(item.label),
        'unknown label',
      ),
  )
  .max(20);

/**
 * The per-email rate-limit KEY (never the stored address): lowercase, `+tag`
 * stripped, and dots dropped for Gmail — otherwise one inbox owner has
 * unlimited free keys for one victim (review 2026-09-10).
 */
export function emailLimiterKey(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  let user = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') user = user.replace(/\./g, '');
  return `${user}@${domain}`;
}

// ---------------------------------------------------------------------------
// Capability token
// ---------------------------------------------------------------------------

export function mintCapabilityToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The one place the unsubscribe URL's shape is known (cron + capture route). */
export function buildUnsubscribeUrl(token: string): string {
  return `${APP_BASE_URL}/reminders-v2/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Server-side annual floor (US-23 AC6 as an INTEGRITY bound, not just UX).
 * The client seeds the same floor, but the server cannot trust the client:
 * the capture endpoint is reachable by any storefront visitor, so an attacker
 * who knows a typed user's email could push a schedule whose every date is
 * decades out — silently switching off the retention engine for that user.
 * Clamping on WRITE turns that attack from "silent kill switch" into "at
 * worst, degraded to an annual check-in". Pure date arithmetic on data we
 * already hold — the server stays a dumb scheduler. Deliberately NOT applied
 * to tombstones (schedule=[] via unsubscribe): an explicit off stays off.
 */
export function ensureAnnualFloor(
  schedule: StoredScheduleItem[],
  now: Date = new Date(),
): StoredScheduleItem[] {
  const horizon = new Date(now);
  horizon.setUTCMonth(horizon.getUTCMonth() + 12);
  const horizonYmd = horizon.toISOString().slice(0, 10);
  if (schedule.some((item) => item.dueAt <= horizonYmd)) return schedule;
  return [
    ...schedule,
    { category: 'annual_checkin', label: 'Annual health check-in', dueAt: horizonYmd },
  ];
}

// ---------------------------------------------------------------------------
// Provider email verification
// ---------------------------------------------------------------------------

/**
 * Resolve the email a Google ID token vouches for, or null. Google validates
 * the signature; we check the token was minted for OUR app. The ID token is
 * the one credential still accepted: it can read nothing and write nothing.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!res.ok) return null;
    const claims = (await res.json()) as Record<string, string>;
    const ourClientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    if (!ourClientId || claims.aud !== ourClientId) return null;
    if (claims.email_verified !== 'true' || !claims.email) return null;
    return claims.email.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB operations (service role; table is RLS-deny to everyone else)
// ---------------------------------------------------------------------------

function requireAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin;
}

/**
 * The result of a write. A token is present whenever the caller has earned it:
 * always on a new row, and on an existing one only when the caller PROVED the
 * inbox (the Google-verified lane). The address lane's existing-row refresh
 * carries no token — see enrolByEmail.
 */
export type Enrolment = { isNew: true; token: string } | { isNew: false; token?: string };

/**
 * Credential-free enrolment (Dropbox, GitHub, typed — US-17 AC7/AC8). Anyone
 * can POST anyone's email, so a write here may only ever CREATE a fresh row
 * or refresh the SCHEDULE of an existing one. Three attacks the shape of this
 * function exists to kill (adversarial reviews 2026-08-14 and 2026-09-10):
 *  - never rotate an existing row's token: an upsert on email would, and the
 *    victim's own device's next schedule push would 404 into "you
 *    unsubscribed" — a silent unsubscribe by anyone knowing their email. The
 *    lookup alone cannot promise that: a Google-verified write landing between
 *    it and the write would be replaced by this lane. So the write itself is a
 *    plain INSERT, and the unique index on email is the referee — a 23505
 *    means the row was created by its owner in the gap, and we answer isNew
 *    false with no token and no schedule refresh (their write is fresher);
 *  - never RETURN an existing row's token: that would hand the cancel
 *    capability to whoever typed the address;
 *  - a refresh keeps LAST_SENT and PROVIDER: resetting cooldowns would let one
 *    re-capture/day turn "a few emails a year" into daily re-sends, and a
 *    provider flip would rewrite the per-lane ratio.
 * The refresh CAN refill a tombstone (schedule=[] after an email-link
 * unsubscribe): a user re-enrolling their own address is re-consenting; the
 * accepted residual is that an attacker can do the same, bounded to rare
 * reminder-cadence emails each carrying the one-click off switch.
 * Returns whether this CREATED an enrolment (isNew drives the one-time
 * plan-ready email, the reminder_optin count and this lane's only token
 * handout — a refresh returns no token at all). 'google-drive' is not in this
 * function's provider type on purpose: that value MEANS verified, and only
 * upsertVerifiedOptin may write it.
 */
export async function enrolByEmail(
  email: string,
  provider: Exclude<ReminderV2Provider, 'google-drive'>,
  schedule: StoredScheduleItem[],
): Promise<Enrolment> {
  const normalized = email.toLowerCase();
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('id')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 lookup failed: ${error.message}`);

  if (data) {
    const { error: updateError } = await requireAdmin()
      .from('reminder_optin_v2')
      .update({ schedule: ensureAnnualFloor(schedule), updated_at: new Date().toISOString() })
      .eq('email', normalized);
    if (updateError) throw new Error(`reminder_optin_v2 refresh failed: ${updateError.message}`);
    return { isNew: false };
  }
  const token = await writeOptinRow(normalized, provider, schedule, null, false);
  // null = the owner's verified write won the race; leave their row alone.
  return token ? { isNew: true, token } : { isNew: false };
}

/**
 * Google-verified enrolment: the address came from a signed ID token, so this
 * caller IS the inbox owner and may replace their own row. The token is ALWAYS
 * returned, new row or not: the same person on a new device has nothing in
 * their file yet, and withholding it there means schedule pushes never start
 * and toggle-off is a no-op. Cooldowns are preserved either way; the token is
 * KEPT only when the row was itself Google-verified. Any other row may be a
 * squatter's (an address-only optin naming this inbox before its owner
 * arrived), and keeping its token would keep the squatter's cancel capability
 * alive across the victim's verification — so it rotates (review 2026-09-10),
 * and the rotated token goes back to the owner in the same reply.
 */
export async function upsertVerifiedOptin(
  email: string,
  schedule: StoredScheduleItem[],
): Promise<Enrolment> {
  const normalized = email.toLowerCase();
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('provider, token, last_sent')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 lookup failed: ${error.message}`);
  const existing = data && { token: data.provider === 'google-drive' ? data.token : undefined, last_sent: data.last_sent };
  // The verified lane may replace its own row, so it never loses the race.
  const token = await writeOptinRow(normalized, 'google-drive', schedule, existing, true);
  return data ? { isNew: false, token } : { isNew: true, token };
}

/**
 * The one raw row write. `existing` (the pre-write row, null when absent)
 * lets a Google-verified re-enrolment PRESERVE the token (so the links in
 * every email already in their inbox keep working) and the cooldowns (so an
 * item sent yesterday isn't re-sent tomorrow — review 2026-08-14). The caller
 * decides whether the token is trustworthy enough to keep.
 * `mayReplace` says whether this caller owns the address: only the verified
 * lane passes true, and only it upserts (so it always returns a token). Every
 * other lane INSERTs and lets the unique index on email decide: a 23505 means
 * an owner's row appeared between enrolByEmail's lookup and here, and
 * returning null (rather than overwriting their provider, token and last_sent)
 * is what keeps that race from becoming the silent-unsubscribe attack. Private
 * on purpose.
 */
async function writeOptinRow(
  email: string,
  provider: ReminderV2Provider,
  schedule: StoredScheduleItem[],
  existing: { token?: string; last_sent?: Record<string, string> } | null,
  mayReplace: true,
): Promise<string>;
async function writeOptinRow(
  email: string,
  provider: ReminderV2Provider,
  schedule: StoredScheduleItem[],
  existing: { token?: string; last_sent?: Record<string, string> } | null,
  mayReplace: false,
): Promise<string | null>;
async function writeOptinRow(
  email: string,
  provider: ReminderV2Provider,
  schedule: StoredScheduleItem[],
  existing: { token?: string; last_sent?: Record<string, string> } | null,
  mayReplace: boolean,
): Promise<string | null> {
  const token = existing?.token ?? mintCapabilityToken();
  const row = {
    email: email.toLowerCase(),
    provider,
    token,
    schedule: ensureAnnualFloor(schedule),
    last_sent: existing?.last_sent ?? {},
    updated_at: new Date().toISOString(),
  };
  const table = requireAdmin().from('reminder_optin_v2');
  const { error } =
    mayReplace ? await table.upsert(row, { onConflict: 'email' }) : await table.insert(row);
  if (error) {
    if (error.code === '23505') return null; // unique_violation on email — the owner got there first
    throw new Error(`reminder_optin_v2 write failed: ${error.message}`);
  }
  return token;
}

/**
 * Replace the schedule for the opt-in owning this token. False = no such
 * token, OR the row is a tombstone (schedule=[] from an email-link
 * unsubscribe): a device that pushed to a tombstone would otherwise refill it
 * every visit, undoing the click — false makes the device flip its file to
 * cancelled instead (review 2026-09-10).
 */
export async function updateScheduleByToken(
  token: string,
  schedule: StoredScheduleItem[],
): Promise<boolean> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('schedule')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 token lookup failed: ${error.message}`);
  if (!data || (data.schedule as StoredScheduleItem[]).length === 0) return false;
  const { error: updateError } = await requireAdmin()
    .from('reminder_optin_v2')
    .update({ schedule: ensureAnnualFloor(schedule), updated_at: new Date().toISOString() })
    .eq('token', token);
  if (updateError) throw new Error(`reminder_optin_v2 update failed: ${updateError.message}`);
  return true;
}

/**
 * US-23 AC2, every lane since 2026-09-10 — a fresh enrolment gets no reminder
 * for its first 3 days. Delivery of the plan-ready email is the consent gate,
 * and its bounce/complaint arrives within minutes-to-hours; the quiet period
 * makes the race between "webhook deletes the row" and "cron mails an overdue
 * item the morning after capture" unlosable. Measured from created_at — never
 * updated_at, which refreshes touch — so a re-capture can't re-arm it and a
 * schedule push can't hold it open.
 */
export function inQuietPeriod(optin: Pick<ReminderV2Optin, 'created_at'>, todayStr: string): boolean {
  const gate = new Date(optin.created_at);
  gate.setUTCDate(gate.getUTCDate() + 3);
  return todayStr < gate.toISOString().slice(0, 10);
}

/**
 * The email unsubscribe page's action (US-23 AC5/AC8, every lane since
 * 2026-09-10). The off switch must be DURABLE against re-enrolment: deleting
 * the row would make the next replayed optin look brand new — isNew again, a
 * fresh plan-ready email again, reminders again — so the victim's one click
 * never sticks. Instead the row becomes a TOMBSTONE (schedule=[], token and
 * created_at kept): the cron has nothing to send, a replayed optin hits the
 * refresh path (isNew=false → no email), the device's next push sees false
 * and flips its own file to cancelled, and the same link keeps working if
 * clicked twice. Returns the row's provider for per-lane optout counting;
 * null = no row, or already tombstoned (don't re-count).
 */
export async function unsubscribeByToken(token: string): Promise<ReminderV2Provider | null> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('provider, schedule')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 unsubscribe lookup failed: ${error.message}`);
  if (!data || (data.schedule as StoredScheduleItem[]).length === 0) return null;
  const { error: updateError } = await requireAdmin()
    .from('reminder_optin_v2')
    .update({ schedule: [], updated_at: new Date().toISOString() })
    .eq('token', token);
  if (updateError) throw new Error(`reminder_optin_v2 tombstone failed: ${updateError.message}`);
  return data.provider as ReminderV2Provider;
}

/**
 * The widget's toggle-off and the pre-erase hook (US-17 AC1b, amended
 * 2026-09-10). A token alone TOMBSTONES (unsubscribeByToken): a hard delete
 * would make the next address-only optin brand new again — isNew, another
 * plan-ready email, every cycle — so optin→cancel→optin was a repeat-email
 * loop. Only a caller who ALSO proves the inbox with a Google ID token for the
 * row's own address gets the row deleted outright (the erase promise, kept
 * for the one lane that can prove itself).
 */
export async function cancelByToken(token: string, verifiedEmail: string | null): Promise<void> {
  if (verifiedEmail) {
    const { error } = await requireAdmin()
      .from('reminder_optin_v2')
      .delete()
      .eq('token', token)
      .eq('email', verifiedEmail.toLowerCase());
    if (error) throw new Error(`reminder_optin_v2 delete failed: ${error.message}`);
  }
  await unsubscribeByToken(token); // no-op when the delete above took the row
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
    .select('id, email, provider, schedule, last_sent, token, created_at')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`reminder_optin_v2 select failed: ${error.message}`);
  return (data ?? []) as ReminderV2Optin[];
}

/** How long a switched-off row keeps its address and token before deletion. */
export const TOMBSTONE_TTL_DAYS = 90;

/**
 * Delete tombstones — rows a toggle-off, an erase or an email-link unsubscribe
 * emptied (US-17 AC1b) — once they are older than {@link TOMBSTONE_TTL_DAYS}.
 * On every lane but Drive the row is kept rather than deleted, because a bare
 * delete let optin → cancel → optin mint a fresh plan-ready email each cycle;
 * keeping it FOREVER, address and token included, is what this bounds.
 *
 * The emptiness test runs here rather than in the filter: `schedule` is jsonb
 * and PostgREST has no length operator, so the query narrows by age and the
 * rows are checked in JS. A row with no `updated_at` is never taken.
 *
 * Residual, stated: past the window a replayed optin on that address is `isNew`
 * again and earns one more plan-ready email — at most one per address per 90
 * days, under the capture route's own 5/day limiter.
 */
export async function purgeTombstones(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - TOMBSTONE_TTL_DAYS * 86_400_000).toISOString();
  const admin = requireAdmin();
  const { data, error } = await admin
    .from('reminder_optin_v2')
    .select('id, schedule')
    .lt('updated_at', cutoff);
  if (error) throw new Error(`reminder_optin_v2 tombstone select failed: ${error.message}`);

  const ids = (data ?? [])
    .filter((row) => Array.isArray(row.schedule) && row.schedule.length === 0)
    .map((row) => row.id as string);
  if (ids.length === 0) return 0;

  const { error: delError } = await admin
    .from('reminder_optin_v2')
    .delete()
    .in('id', ids);
  if (delError) throw new Error(`reminder_optin_v2 tombstone delete failed: ${delError.message}`);
  return ids.length;
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
