/**
 * Client half of the §10 email-reminders model.
 *
 * Opt-in:  compute the forward schedule from the user's file, prove the
 *          account email via the connected cloud provider, POST both to
 *          Brad's server, and save the returned capability token in the
 *          user's OWN cloud file (it follows them across devices).
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
import { Sentry } from '../src/lib/sentry';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import type { Backend } from './connect';

const REMINDERS_API_URL = 'https://health-tool-app.fly.dev/api/reminders-v2';

/** Reminders need a provider-verified email — §10 scopes them to these three. */
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

/** Provider proof for the opt-in (§10). Needs a user gesture (Google popup path). */
async function proofFor(backend: ReminderBackend): Promise<{ idToken: string } | { accessToken: string }> {
  if (backend === 'google-drive') {
    return new GoogleDriveAdapter(googleDriveConfig()).getReminderProof();
  }
  if (backend === 'dropbox') {
    return { accessToken: await new DropboxAdapter(dropboxConfig()).getReminderProofToken() };
  }
  return { accessToken: new GitHubAdapter().getReminderProofToken() };
}

/**
 * Turn reminders on. Returns the provider-verified email they'll go to.
 * Call from a click handler (the Google fallback path opens a popup).
 *
 * marketingEmail: the OPTIONAL typed marketing opt-in (§10 — email capture is
 * a typed step at the reminders flow, never harvested at cloud-connect). It
 * transits Brad's server straight to Klaviyo and is never stored in the
 * reminder row; reminders themselves always go to the provider-verified email.
 */
export async function optInToReminders(backend: Backend, marketingEmail?: string): Promise<string> {
  if (!remindersSupported(backend)) throw new Error('Reminders need a connected cloud account.');
  const schedule = computeCurrentReminderSchedule();
  const proof = await proofFor(backend);
  const res = await post({
    op: 'optin',
    provider: backend,
    ...proof,
    schedule,
    ...(marketingEmail ? { marketingEmail } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    // The server says WHY verification failed — map its reason to user copy.
    if (body.reason === 'github-email-permission') {
      throw new Error(
        "GitHub couldn't confirm your email — your token needs the account permission " +
          '"Email addresses (read-only)". Add it to the token (or create a new one) and retry.',
      );
    }
    throw new Error(body.error || `Could not set up reminders (${res.status}).`);
  }
  const { token, email } = (await res.json()) as { token: string; email: string };
  setReminderOptIn({ status: 'active', token, email, provider: backend });
  await flushRoadmapStore(); // the token must reach the cloud file
  return email;
}

/** Turn reminders off (server row deleted; cancel propagates via the file). */
export async function cancelReminders(): Promise<void> {
  const optIn = getReminderOptIn();
  if (!optIn) return;
  const res = await post({ op: 'cancel', token: optIn.token });
  if (!res.ok) throw new Error(`Could not turn reminders off (${res.status}). Please retry.`);
  setReminderOptIn({ ...optIn, status: 'cancelled' });
  await flushRoadmapStore();
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
