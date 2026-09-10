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
 * address. The provider column now records WHICH surface enrolled the address
 * (for the per-lane ratio), not how strongly it was verified — only
 * 'google-drive' rows written through upsertVerifiedOptin carry a proof.
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

export type Enrolment = { isNew: true; token: string } | { isNew: false };

/**
 * Credential-free enrolment (Dropbox, GitHub, typed — US-17 AC7/AC8). Anyone
 * can POST anyone's email, so a write here may only ever CREATE a fresh row
 * or refresh the SCHEDULE of an existing one. Three attacks the shape of this
 * function exists to kill (adversarial reviews 2026-08-14 and 2026-09-10):
 *  - never rotate an existing row's token: the plain upsert would, and the
 *    victim's own device's next schedule push would 404 into "you
 *    unsubscribed" — a silent unsubscribe by anyone knowing their email;
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
 * plan-ready email, the reminder_optin count and the only token handout).
 */
export async function enrolByEmail(
  email: string,
  provider: ReminderV2Provider,
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
  return { isNew: true, token: await writeOptinRow(normalized, provider, schedule, null) };
}

/**
 * Google-verified enrolment: the address came from a signed ID token, so this
 * caller IS the inbox owner and may replace their own row — token and
 * cooldowns preserved (see writeOptinRow) — and always receives the token.
 */
export async function upsertVerifiedOptin(
  email: string,
  schedule: StoredScheduleItem[],
): Promise<{ token: string; isNew: boolean }> {
  const normalized = email.toLowerCase();
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('token, last_sent')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 lookup failed: ${error.message}`);
  return { token: await writeOptinRow(normalized, 'google-drive', schedule, data), isNew: !data };
}

/**
 * The one raw row write. `existing` (the pre-write row, null when absent)
 * makes a Google-verified re-enrolment PRESERVE the token and cooldowns: a
 * typed user who later connects Drive keeps the same unsubscribe token, so the
 * links in every email already in their inbox keep working, and last_sent
 * survives so an item sent yesterday isn't re-sent tomorrow (review
 * 2026-08-14 — the same two invariants the refresh path holds). Private on
 * purpose.
 */
async function writeOptinRow(
  email: string,
  provider: ReminderV2Provider,
  schedule: StoredScheduleItem[],
  existing: { token: string; last_sent?: Record<string, string> } | null,
): Promise<string> {
  const token = existing?.token ?? mintCapabilityToken();
  const { error } = await requireAdmin()
    .from('reminder_optin_v2')
    .upsert(
      {
        email: email.toLowerCase(),
        provider,
        token,
        schedule: ensureAnnualFloor(schedule),
        last_sent: existing?.last_sent ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'email' },
    );
  if (error) throw new Error(`reminder_optin_v2 upsert failed: ${error.message}`);
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

/** Delete the opt-in owning this token — the widget's own toggle-off and the
 *  pre-erase hook (US-17 AC1b: a toggle-off DELETES the row). Token-authorised,
 *  so unlike the email link it needs no tombstone. */
export async function deleteByToken(token: string): Promise<void> {
  const { error } = await requireAdmin().from('reminder_optin_v2').delete().eq('token', token);
  if (error) throw new Error(`reminder_optin_v2 delete failed: ${error.message}`);
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
