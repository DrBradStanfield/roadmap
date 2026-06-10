/**
 * Client half of the §10 email-reminders model.
 *
 * Opt-in:  compute the forward schedule from the user's file, prove the
 *          account email via the connected cloud provider, POST both to
 *          Brad's server, and save the returned capability token in the
 *          user's OWN cloud file (it follows them across devices).
 * Re-push: on every app load (and tab-hide), recompute the schedule and
 *          update the server IF it changed — so the server's copy tracks the
 *          user's data without the server ever seeing that data.
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
/** Last schedule JSON this device successfully pushed — skip no-op updates. */
const PUSHED_KEY = 'health_roadmap_reminders_pushed';

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
async function proofFor(backend: Backend): Promise<Record<string, string>> {
  if (backend === 'google-drive') {
    return new GoogleDriveAdapter(googleDriveConfig()).getReminderProof();
  }
  if (backend === 'dropbox') {
    return { accessToken: await new DropboxAdapter(dropboxConfig()).getReminderProofToken() };
  }
  if (backend === 'github') {
    return { accessToken: new GitHubAdapter().getReminderProofToken() };
  }
  throw new Error('Reminders need a connected cloud account.');
}

/**
 * Turn reminders on. Returns the provider-verified email they'll go to.
 * Call from a click handler (the Google fallback path opens a popup).
 */
export async function optInToReminders(backend: Backend): Promise<string> {
  if (!remindersSupported(backend)) throw new Error('Reminders need a connected cloud account.');
  const schedule = computeCurrentReminderSchedule();
  const proof = await proofFor(backend);
  const res = await post({ op: 'optin', provider: backend, ...proof, schedule });
  if (res.status === 401 && backend === 'github') {
    throw new Error(
      "GitHub couldn't confirm your email — your token needs the account permission " +
        '"Email addresses (read-only)". Add it to the token (or create a new one) and retry.',
    );
  }
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({ error: '' }))) as { error?: string };
    throw new Error(error || `Could not set up reminders (${res.status}).`);
  }
  const { token, email } = (await res.json()) as { token: string; email: string };
  setReminderOptIn({ status: 'active', token, email, provider: backend });
  localStorage.setItem(PUSHED_KEY, JSON.stringify(schedule));
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
  localStorage.removeItem(PUSHED_KEY);
  await flushRoadmapStore();
}

/**
 * Push the current schedule to the server if it changed since this device
 * last pushed. Fire-and-forget (reminders are never allowed to break the
 * core app). A 404 means the user unsubscribed from an email link — clear
 * the stale opt-in so the UI offers reminders again.
 */
export async function pushReminderScheduleIfChanged(keepalive = false): Promise<void> {
  const optIn = getReminderOptIn();
  if (optIn?.status !== 'active') return;
  const schedule = computeCurrentReminderSchedule();
  const key = JSON.stringify(schedule);
  if (localStorage.getItem(PUSHED_KEY) === key) return;
  try {
    const res = await post({ op: 'update', token: optIn.token, schedule }, keepalive);
    if (res.status === 404) {
      setReminderOptIn({ ...optIn, status: 'cancelled' });
      localStorage.removeItem(PUSHED_KEY);
      return;
    }
    if (res.ok) localStorage.setItem(PUSHED_KEY, key);
  } catch (error) {
    console.warn('Reminder schedule push failed (will retry next visit)', error);
    Sentry.captureException(error, { tags: { area: 'reminders', op: 'push-schedule' } });
  }
}
