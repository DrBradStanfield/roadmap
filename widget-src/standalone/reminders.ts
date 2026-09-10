/**
 * Client half of the §10 email-reminders model.
 *
 * Opt-in:  compute the forward schedule from the user's file, read the
 *          account email from the connected cloud provider HERE (only Google
 *          sends a signed ID token instead — it grants nothing; US-17 AC7:
 *          no storage credential ever leaves the browser), POST both to
 *          Brad's server, and save the returned capability token in the
 *          user's OWN cloud file (it follows them across devices).
 *          Since US-17 this is DEFAULT-ON: autoEnrolReminders() runs the same
 *          path unprompted at app load (silent proof, no popup) for any
 *          connected cloud whose file records no decision yet. The old
 *          three-barrier opt-in produced ~1 enrolment in two months.
 * Re-push: on every app load (and tab-hide), recompute the schedule and
 *          push it — so the server's copy tracks the user's data without the
 *          server ever seeing that data. Deliberately UNCONDITIONAL (no
 *          changed-since-last-push dedup): the push doubles as the token
 *          validity probe, and the 404 path below is the ONLY way the app
 *          learns about an email-link unsubscribe. A dedup cache made that
 *          discovery unreachable (found in the 2026-06-10 e2e test) — the
 *          cost of always pushing is one idempotent ~200-byte POST per visit.
 * Cancel:  POST cancel (row deleted server-side), flip the file's opt-in to
 *          'cancelled' (a status flip, not a delete, so the LWW merge carries
 *          the cancel to every device).
 *
 * All POSTs use the text/plain CORS simple-request protocol (remix-serve
 * can't answer preflights) — same as the Google token exchange.
 */
import {
  computeCurrentReminderSchedule,
  flushRoadmapStore,
  getReminderOptIn,
  setReminderOptIn,
} from '../src/lib/roadmap-data';
import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter } from '../src/storage';
import { trackProductEvent } from '../src/lib/server-api';
import { SHOPIFY_SURFACE } from '../src/lib/build-flags';
import { safeGetItem, safeSetItem } from '../src/lib/storage';
import { Sentry } from '../src/lib/sentry';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import type { Backend } from './connect';

const REMINDERS_API_URL = 'https://health-tool-app.fly.dev/api/reminders-v2';

/** Set once the provider has NO email to give (a GitHub PAT without the email
 *  permission, a pre-openid Drive grant). That answer won't change on its own,
 *  so auto-enrolment stops asking; the manual toggle still works and asks the
 *  user to type the address once. Never set on a transient failure. */
const AUTO_ENROL_BLOCKED_KEY = 'hr_reminders_autoenrol_blocked';

/** Thrown by the manual path when the provider has no email: the control
 *  answers by showing a one-time typed field — never a silent enrolment. */
export class ReminderEmailNeeded extends Error {
  constructor() {
    super('We could not read the email on your cloud account — type the address reminders should go to.');
    this.name = 'ReminderEmailNeeded';
  }
}

/** Survives a reload so the enrolment notice isn't lost to one refresh. */
export const ENROL_NOTICE_KEY = 'hr_reminders_notice';

/** Reminders need an account email the browser can read — §10 scopes them to these three. */
export type ReminderBackend = 'google-drive' | 'dropbox' | 'github';
export function remindersSupported(backend: Backend): backend is ReminderBackend {
  return backend === 'google-drive' || backend === 'dropbox' || backend === 'github';
}

async function post(body: unknown, keepalive = false): Promise<Response> {
  return fetch(REMINDERS_API_URL, {
    method: 'POST',
    // No Content-Type header → text/plain → CORS simple request (no preflight).
    body: JSON.stringify(body),
    keepalive,
  });
}

/**
 * Who the reminders go to, read in the browser (US-17 AC7). Google: a fresh
 * signed ID token (verified server-side; it grants nothing). Dropbox and
 * GitHub: the account email itself. Null = the provider has no email to give
 * (never a transient failure — those throw, and the caller retries).
 */
async function identityFor(backend: ReminderBackend): Promise<{ idToken: string } | { email: string } | null> {
  if (backend === 'google-drive') {
    const drive = new GoogleDriveAdapter(googleDriveConfig());
    const idToken = await drive.getReminderIdToken();
    if (idToken) return { idToken };
    const email = drive.accountEmail();
    return email ? { email } : null;
  }
  if (backend === 'dropbox') return { email: await new DropboxAdapter(dropboxConfig()).accountEmail() };
  const email = await new GitHubAdapter().accountEmail();
  return email ? { email } : null;
}

export interface OptInResult {
  email: string;
  /** True when the address was ALREADY enrolled: the server refreshed its
   *  schedule and returned no token (US-17 AC8 — a token to whoever names an
   *  address would be the cancel capability). Nothing was written to the file. */
  refreshed: boolean;
}

/**
 * Turn reminders on. Returns the email they'll go to.
 *
 * marketingEmail: the OPTIONAL typed marketing opt-in (§10 — email capture is
 * a typed step at the reminders flow, never harvested at cloud-connect). It
 * transits Brad's server straight to Klaviyo and is never stored in the
 * reminder row.
 *
 * email: the typed reminders address, for the one case the provider has none
 * to give (ReminderEmailNeeded on the previous attempt). Manual path only.
 *
 * silent: the US-17 auto-enrolment path (no typed input, no error surfaced).
 */
export async function optInToReminders(
  backend: Backend,
  { marketingEmail, email, silent }: { marketingEmail?: string; email?: string; silent?: boolean } = {},
): Promise<OptInResult> {
  if (!remindersSupported(backend)) throw new Error('Reminders need a connected cloud account.');
  const schedule = computeCurrentReminderSchedule();
  const identity = email ? { email } : await identityFor(backend);
  if (!identity) {
    if (silent) safeSetItem(AUTO_ENROL_BLOCKED_KEY, '1');
    throw new ReminderEmailNeeded();
  }
  const res = await post({
    op: 'optin',
    provider: backend,
    ...identity,
    schedule,
    marketingEmail, // optional — JSON.stringify drops it when undefined
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Could not set up reminders (${res.status}).`);
  }
  const reply = (await res.json()) as { token?: string; email: string };
  if (!reply.token) return { email: reply.email, refreshed: true };
  setReminderOptIn({ status: 'active', token: reply.token, email: reply.email, provider: backend });
  await flushRoadmapStore(); // the token must reach the cloud file
  // reminder_optin is counted by the SERVER when the row lands (every lane) —
  // only it knows the enrolment happened, and abuse enrolments count too.
  return { email: reply.email, refreshed: false };
}

/**
 * Default-on enrolment (US-17 AC1, Brad 2026-08-11): connecting a cloud IS the
 * consent, so reminders start ON and stay on until the user turns them off.
 * A user who reads the notice and clicks away is enrolled — that is the point
 * of an opt-out model, and the reason ~1 person in two months opted in under
 * the old three-barrier flow.
 *
 * Runs once per app load, and does nothing when the file already records a
 * decision: 'active' (enrolled already) or 'cancelled' (AC4 — the user's own
 * opt-out rides the file to every device and must never be undone here).
 * Silent by construction: no popup, and a failure is never surfaced — an
 * enrolment the user didn't ask for must not produce an error they didn't ask
 * for either. The next visit retries, unless the provider has no email to
 * give (then only the manual toggle, which asks for one, can enrol).
 *
 * AC1b is the knowing cost: every cloud-connecting user's due dates + labels +
 * account email now reach the server, where before only explicit opt-ins
 * did. AC5 still holds — no measurement, value or reasoning goes with
 * them, and the visible statement of exactly that ships alongside (AC1).
 */
export async function autoEnrolReminders(backend: Backend): Promise<void> {
  // Shopify surface only. The Pages / self-host build is marketed as "no Brad
  // server" and runs uploads + chat on the user's OWN key; enrolling THAT user
  // unprompted would post their account email to Brad's server at page load,
  // which is the one thing they chose that build to avoid. They keep the manual
  // toggle. (Also: trackProductEvent no-ops off-Shopify, so a Pages opt-out
  // would be invisible to the very ratio this decision reverts on.)
  if (!SHOPIFY_SURFACE) return;
  if (!remindersSupported(backend)) return; // AC6: no cloud → no account email → never enrolled
  if (safeGetItem(AUTO_ENROL_BLOCKED_KEY)) return;

  const optIn = getReminderOptIn();
  if (optIn?.status === 'cancelled') return; // AC4 — their decision, on every device, forever
  if (optIn?.status === 'active' && optIn.provider === backend) return;

  try {
    // Switched clouds (Drive → Dropbox): the live row points at the account
    // they left, so reminders would keep going to an inbox they no longer read
    // — and the fresh enrolment below can't replace it, because rows are keyed
    // by email. Drop it first. Deliberately NOT cancelReminders(): a storage
    // switch is not a user opting out, and must not be counted as one.
    if (optIn?.status === 'active') await post({ op: 'cancel', token: optIn.token });

    // An already-enrolled address (token lost with the file, or enrolled from
    // another lane) is refreshed server-side and nothing is written here —
    // there is no enrolment to announce, and the next visit refreshes again.
    if ((await optInToReminders(backend, { silent: true })).refreshed) return;
    try { sessionStorage.setItem(ENROL_NOTICE_KEY, '1'); } catch { /* the live event still fires */ }
    window.dispatchEvent(new Event('hr:reminders-changed'));  // re-render the control
    window.dispatchEvent(new Event('hr:reminders-enrolled')); // show the one-time notice
  } catch (error) {
    console.warn('Reminder auto-enrolment deferred to the next visit', error);
  }
}

/**
 * Erase teardown, run BEFORE "Delete all my data" wipes the file (US-17 AC1b:
 * "if a toggle-off arrives, the server row is DELETED"). Deleting everything
 * has to reach the one copy that isn't on the user's device — and the
 * capability token that authorises that delete lives in the file we're about
 * to destroy, so this cannot run afterwards.
 *
 * Not counted as an opt-out: they erased everything, they didn't judge
 * reminders. Registered as a hook by the standalone entry, because `src/`
 * (where the store lives) must never import `standalone/`.
 */
export async function cancelRemindersForErase(): Promise<void> {
  const optIn = getReminderOptIn();
  if (optIn?.status !== 'active') return;
  const res = await post({ op: 'cancel', token: optIn.token });
  if (!res.ok) throw new Error(`Reminder row delete failed (${res.status}).`);
}

/** Turn reminders off (server row deleted; cancel propagates via the file). */
export async function cancelReminders(): Promise<void> {
  const optIn = getReminderOptIn();
  if (!optIn) return;
  const res = await post({ op: 'cancel', token: optIn.token });
  if (!res.ok) throw new Error(`Could not turn reminders off (${res.status}). Please retry.`);
  setReminderOptIn({ ...optIn, status: 'cancelled' });
  await flushRoadmapStore();
  // The optout:optin ratio is US-17's kill criterion — it only works if BOTH
  // sides are counted (the opt-in side has fired since 2026-08-06), and per
  // LANE: the provider tag lets the typed and cloud ratios be judged apart.
  trackProductEvent('reminder_optout', { provider: optIn.provider });
}

/**
 * Push the current schedule to the server. Fire-and-forget (reminders are
 * never allowed to break the core app). A 404 means the user unsubscribed
 * from an email link — flip the stale opt-in to cancelled so the UI offers
 * reminders again (and the cancel syncs to their other devices).
 */
export async function pushReminderSchedule(keepalive = false): Promise<void> {
  const optIn = getReminderOptIn();
  if (optIn?.status !== 'active') return;
  try {
    const res = await post(
      { op: 'update', token: optIn.token, schedule: computeCurrentReminderSchedule() },
      keepalive,
    );
    if (res.status === 404) {
      setReminderOptIn({ ...optIn, status: 'cancelled' });
      window.dispatchEvent(new Event('hr:reminders-changed'));
    }
  } catch (error) {
    console.warn('Reminder schedule push failed (will retry next visit)', error);
    Sentry.captureException(error, { tags: { area: 'reminders', op: 'push-schedule' } });
  }
}
