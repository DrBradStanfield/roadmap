/**
 * v2 email reminders: the checks a reminder request goes through before
 * reminder-v2.server.ts acts on it (the schedule payload, the per-email
 * rate-limit key, the Google ID-token check). Moved out of that file as they
 * were, to keep it under the 500-line cap (US-64 AC23). It re-exports all
 * three, so callers and test mocks of reminder-v2.server are unchanged.
 */
import * as Sentry from '@sentry/react-router';
import * as z from '../../packages/health-core/src/zod';
import { REMINDER_CATEGORIES } from '../../packages/health-core/src/reminders';
import { SCHEDULE_LABELS } from '../../packages/health-core/src/reminder-schedule';

// ---------------------------------------------------------------------------
// Request rules
// ---------------------------------------------------------------------------

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
          // And !Number.isNaN(Date.parse(d)) under-rejects: Date.parse
          // NORMALIZES an impossible day ('2026-02-30' reads as Mar 2), so a
          // stored row later displays "due Mar 2026" in the email while the
          // calendar link keeps the raw Feb 30. Require the parsed UTC
          // year/month/day to equal the submitted YYYY-MM-DD (US-23 AC4 —
          // dueAt must be a real calendar day).
          .refine((d) => {
            const parsed = new Date(d);
            return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
          }, 'not a real date'),
      })
      .refine(
        (item) => (SCHEDULE_LABELS[item.category as keyof typeof SCHEDULE_LABELS] ?? []).includes(item.label),
        'unknown label',
      ),
  )
  .max(20);

/**
 * The per-email rate-limit KEY (never the stored address): lowercase, `+tag`
 * stripped, and for Gmail dots dropped and googlemail.com read as gmail.com
 * (US-17 AC8a). Otherwise one inbox owner has many free keys (review 2026-09-10).
 */
export function emailLimiterKey(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  const user = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `${user.replace(/\./g, '')}@gmail.com`;
  return `${user}@${domain}`;
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
      { signal: AbortSignal.timeout(10_000) }, // a stalled Google reads as unverified (US-09 AC31)
    );
    if (!res.ok) {
      // A 4xx is the token's own problem. A 5xx or 429 is Google's, and it
      // blocks every Google opt-in, so it is reported (US-17 AC7a).
      if (res.status >= 500 || res.status === 429) {
        Sentry.captureMessage('Google tokeninfo failed', { level: 'warning', tags: { feature: 'reminders_v2' }, extra: { status: res.status } });
      }
      return null;
    }
    const claims = (await res.json()) as Record<string, string>;
    const ourClientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    if (!ourClientId || claims.aud !== ourClientId) return null;
    if (claims.email_verified !== 'true' || !claims.email) return null;
    return claims.email.toLowerCase();
  } catch (error) {
    Sentry.captureException(error, { tags: { feature: 'reminders_v2' } }); // no answer from Google (US-17 AC7a)
    return null;
  }
}
