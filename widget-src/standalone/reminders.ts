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
  getShownErase,
  isKnownMinorNow,
  setReminderOptIn,
} from '../src/lib/roadmap-data';
import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter } from '../src/storage';
import { trackProductEvent } from '../src/lib/server-api';
import { SHOPIFY_SURFACE } from '../src/lib/build-flags';
import { safeGetItem, safeRemoveItem, safeSetItem } from '../src/lib/storage';
import { Sentry } from '../src/lib/sentry';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import type { Backend } from './connect';
import type { FileReminderOptIn } from '@roadmap/health-core';

const REMINDERS_API_URL = 'https://health-tool-app.fly.dev/api/reminders-v2';

/** Set once the provider has NO email to give (a GitHub PAT without the email
 *  permission, a pre-openid Drive grant). That answer won't change on its own,
 *  so auto-enrolment stops asking; the manual toggle still works and asks the
 *  user to type the address once. Never set on a transient failure. */
const AUTO_ENROL_BLOCKED_KEY = 'hr_reminders_autoenrol_blocked';

/** A fresh connect may bring a token that CAN give an email (a new GitHub PAT
 *  with the permission, a new openid Drive grant) — let auto-enrolment ask again. */
export function clearAutoEnrolBlock(): void {
  safeRemoveItem(AUTO_ENROL_BLOCKED_KEY);
}

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

type Identity = { provider: 'google-drive'; idToken: string } | { provider: ReminderBackend | 'typed'; email: string };

/**
 * Who the reminders go to, read in the browser (US-17 AC7). Google: a fresh
 * signed ID token (verified server-side; it grants nothing) — or, with none to
 * hand, the remembered address sent as provider 'typed', because on the server
 * 'google-drive' MEANS verified. Dropbox and GitHub: the account email itself.
 * Null = the provider has no email to give (never a transient failure — those
 * throw, and the caller retries).
 */
async function identityFor(backend: ReminderBackend): Promise<Identity | null> {
  if (backend === 'google-drive') {
    const drive = new GoogleDriveAdapter(googleDriveConfig());
    const idToken = await drive.getReminderIdToken();
    if (idToken) return { provider: 'google-drive', idToken };
    const email = drive.accountEmail();
    return email ? { provider: 'typed', email } : null;
  }
  if (backend === 'dropbox') return { provider: 'dropbox', email: await new DropboxAdapter(dropboxConfig()).accountEmail() };
  const email = await new GitHubAdapter().accountEmail();
  return email ? { provider: 'github', email } : null;
}

/**
 * True from the moment this page's cloud switch cancels the old row until the
 * new enrolment lands (US-17 AC12). While true, the old token's row is a
 * tombstone the switch owns: a push would refill it, or 404 into a
 * "cancelled" nobody chose. A switch that never cancels holds nothing.
 * SWITCH_CANCELLED_KEY carries the same fact (as the old token) to the next
 * visit, because the tombstone outlives the page; the flag covers a browser
 * whose storage is blocked.
 */
let switchHoldsOldToken = false;
const SWITCH_CANCELLED_KEY = 'hr_reminders_switch_cancelled';

/** The same decision in the file: both absent, or the same status, token and provider. */
function sameOptIn(a: FileReminderOptIn | undefined, b: FileReminderOptIn | undefined): boolean {
  return a?.status === b?.status && a?.token === b?.token && a?.provider === b?.provider;
}

/** One address, however the provider cased or padded it. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The ID token for a Drive-verified cancel (hard delete); null on any other lane or failure. */
async function cancelProofFor(backend: Backend): Promise<string | null> {
  if (backend !== 'google-drive') return null;
  return new GoogleDriveAdapter(googleDriveConfig()).getReminderIdToken().catch(() => null);
}

/** A cancel, with the ID token only when there is one: the route's zod
 *  `.optional()` takes a missing key but answers null with a 400 (US-17 AC1b). */
function postCancel(token: string, idToken: string | null, keepalive = false): Promise<Response> {
  return post({ op: 'cancel', token, ...(idToken ? { idToken } : {}) }, keepalive);
}

export interface OptInResult {
  email: string;
  /** True when an address-lane optin met an ALREADY enrolled address: the
   *  server refreshed its schedule and returned no token (US-17 AC8 — a token
   *  to whoever names an address would be the cancel capability). Nothing was
   *  written to the file. The Google-verified lane always gets its token back,
   *  so it is never `refreshed`. */
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
 * `from` is the file's opt-in when that enrolment began (undefined: no decision).
 */
export async function optInToReminders(
  backend: Backend,
  { marketingEmail, email, silent }: { marketingEmail?: string; email?: string; silent?: { from: FileReminderOptIn | undefined } } = {},
): Promise<OptInResult> {
  if (!remindersSupported(backend)) throw new Error('Reminders need a connected cloud account.');
  // US-07 AC6: the plan is built for adults, and so are its reminders.
  if (isKnownMinorNow()) throw new Error('Check-up reminders are for adults aged 18 and over.');
  // The record this enrolment was asked for: a reply landing after an erase
  // the page has shown since is refused, not saved into it (US-16 AC2a).
  const erase = getShownErase();
  const schedule = computeCurrentReminderSchedule();
  const identity: Identity | null = email ? { provider: 'typed', email } : await identityFor(backend);
  if (!identity) {
    if (silent) safeSetItem(AUTO_ENROL_BLOCKED_KEY, '1');
    throw new ReminderEmailNeeded();
  }
  const res = await post({
    op: 'optin',
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
  // The silent path awaited lookups and posts since it read the file, and an
  // erase, a Turn off or another device may have decided meanwhile (US-11 AC4,
  // US-17 AC4). That decision stands: the token is not written, and its row is
  // cancelled so it cannot outlive the decision (not their opt-out, so not
  // counted). A token the file already holds active is theirs: left alone.
  const now = getReminderOptIn();
  const superseded = silent && !sameOptIn(now, silent.from);
  // A token the file already holds active is theirs: never cancelled, and
  // its switch marker stays (adversary R1).
  const held = now?.status === 'active' && now.token === reply.token;
  // The record can also refuse the token: it was erased under the page (US-16
  // AC2a). That erase is a decision made meanwhile too, so the row goes.
  if (superseded || !setReminderOptIn({ status: 'active', token: reply.token, email: reply.email, provider: backend }, erase)) {
    // The decision that superseded this enrolment (an erase, a toggle-off) owns
    // the file now: no switch marker outlives it (US-11 AC4).
    if (!held && (!superseded || now?.status !== 'active')) safeRemoveItem(SWITCH_CANCELLED_KEY);
    if (!held) {
      const cancel = await postCancel(reply.token, await cancelProofFor(backend));
      // The status code only (CLAUDE.md telemetry rule): this row has no token anywhere now.
      if (!cancel.ok) {
        const refused = new Error(`Superseded reminder row cancel failed (${cancel.status}).`);
        Sentry.captureException(refused, { tags: { area: 'reminders', op: 'superseded-cancel' } });
      }
    }
    throw new Error('Reminder enrolment superseded by a decision made meanwhile.');
  }
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
  if (isKnownMinorNow()) return; // US-07 AC6: never enrol a known minor

  const optIn = getReminderOptIn();
  if (optIn?.status === 'cancelled') return; // AC4 — their decision, on every device, forever
  if (optIn?.status === 'active' && optIn.provider === backend) return;

  try {
    if (optIn?.status === 'active') {
      // Switched clouds, same address (AC12): rows are keyed by email, so the
      // old token still owns the one row there is. Cancelling it and opting in
      // again only gets a tokenless `refreshed`, and the file never moves on.
      const identity = await identityFor(backend);
      // The lookup awaited: an erase, a toggle-off or another device may have
      // changed the opt-in meanwhile. Act only on the one we read.
      const current = getReminderOptIn();
      if (!current || !sameOptIn(current, optIn)) return;
      // Drive's identity carries an ID token, not an address; its account email is local.
      const address = identity && 'email' in identity ? identity.email
        : backend === 'google-drive' ? new GoogleDriveAdapter(googleDriveConfig()).accountEmail() : null;
      if (address && sameAddress(address, current.email)) {
        setReminderOptIn({ ...current, provider: backend });
        await flushRoadmapStore();
        return;
      }
      // The new cloud gives no address yet: keep the old row and its reminders
      // (the control still reads "on → old address") rather than cancel a row
      // nothing can replace. The next visit tries again.
      if (!identity) return;
      // Switched clouds (Drive → Dropbox): the live row points at the account
      // they left, so reminders would keep going to an inbox they no longer read
      // — and the fresh enrolment below can't replace it, because rows are keyed
      // by email. Drop it first. Deliberately NOT cancelReminders(): a storage
      // switch is not a user opting out, and must not be counted as one.
      // A refused cancel stops here: enrolling now would write the new token
      // over the old one, the only key to that row. The file keeps the old
      // opt-in, so the next visit on the new cloud tries the cancel again.
      // An earlier visit's cancel of this token already landed: a refused retry
      // proves nothing about the row, so that marker stays.
      const cancelledBefore = safeGetItem(SWITCH_CANCELLED_KEY) === optIn.token;
      switchHoldsOldToken = true;
      safeSetItem(SWITCH_CANCELLED_KEY, optIn.token);
      const res = await postCancel(optIn.token, await cancelProofFor(optIn.provider));
      if (!res.ok) {
        switchHoldsOldToken = cancelledBefore; // otherwise the old row is still live: pushes may carry on
        if (!cancelledBefore) safeRemoveItem(SWITCH_CANCELLED_KEY);
        // The status code only: no address, no schedule (CLAUDE.md telemetry rule).
        const refused = new Error(`Old reminder row cancel failed (${res.status}).`);
        Sentry.captureException(refused, { tags: { area: 'reminders', op: 'switch-cancel' } });
        throw refused;
      }
    }

    // An already-enrolled address (token lost with the file, or enrolled from
    // another lane) is refreshed server-side and nothing is written here —
    // there is no enrolment to announce, and the next visit refreshes again.
    // After a switch's cancel the file keeps the old opt-in until a new token
    // lands, so pushReminderSchedule holds off, on this visit and the next
    // (SWITCH_CANCELLED_KEY), and no 404 can mark it cancelled.
    if ((await optInToReminders(backend, { silent: { from: optIn } })).refreshed) return;
    switchHoldsOldToken = false; // the new token is in the file
    safeRemoveItem(SWITCH_CANCELLED_KEY);
    try { sessionStorage.setItem(ENROL_NOTICE_KEY, '1'); } catch { /* the live event still fires */ }
    window.dispatchEvent(new Event('hr:reminders-changed'));  // re-render the control
    window.dispatchEvent(new Event('hr:reminders-enrolled')); // show the one-time notice
  } catch (error) {
    console.warn('Reminder auto-enrolment deferred to the next visit', error);
  } finally {
    // The marker only guards an ACTIVE opt-in. Once the file holds none (an
    // erase or a toggle-off landed during this run, whatever the enrolment
    // answered), no reminder token stays on the device (US-11 AC4).
    if (getReminderOptIn()?.status !== 'active') safeRemoveItem(SWITCH_CANCELLED_KEY);
  }
}

/**
 * Erase teardown, run BEFORE "Delete all my data" wipes the file (US-17 AC1b,
 * amended 2026-09-10: the row is tombstoned — deleted outright only when a
 * Google ID token proves the inbox, because a bare token's delete re-opened
 * the plan-ready email to every optin→cancel→optin cycle). Reaching the one
 * copy that isn't on the user's device needs the capability token that lives
 * in the file we're about to destroy, so this cannot run afterwards.
 * A refused cancel throws. The erase still goes ahead (deleteUserData) and
 * sends the failure to Sentry. No retry: the token is gone.
 *
 * Not counted as an opt-out: they erased everything, they didn't judge
 * reminders. Registered as a hook by the standalone entry, because `src/`
 * (where the store lives) must never import `standalone/`.
 */
export async function cancelRemindersForErase(): Promise<void> {
  // An erase leaves no reminder token on the device, not even a cancelled one.
  safeRemoveItem(SWITCH_CANCELLED_KEY);
  const optIn = getReminderOptIn();
  if (optIn?.status !== 'active') return;
  const res = await postCancel(optIn.token, await cancelProofFor(optIn.provider));
  if (!res.ok) throw new Error(`Reminder row delete failed (${res.status}).`);
}

/** Turn reminders off (server row tombstoned, or deleted when Drive can prove
 *  the inbox; the cancel propagates via the file).
 *  `count: false`: not the user's opt-out (US-07 AC6's age gate), so not
 *  counted, as the cloud switch's cancel is not. `keepalive`: the tab is going
 *  away, so the cancel leaves at once, unproven (a tombstone), as an update does. */
export async function cancelReminders({ count = true, keepalive = false } = {}): Promise<void> {
  const optIn = getReminderOptIn();
  if (!optIn) return;
  const idToken = keepalive ? null : await cancelProofFor(optIn.provider);
  const res = await postCancel(optIn.token, idToken, keepalive);
  if (!res.ok) throw new Error(`Could not turn reminders off (${res.status}). Please retry.`);
  setReminderOptIn({ ...optIn, status: 'cancelled' });
  await flushRoadmapStore();
  // The optout:optin ratio is US-17's kill criterion — it only works if BOTH
  // sides are counted (the opt-in side has fired since 2026-08-06), and per
  // LANE: the provider tag lets the typed and cloud ratios be judged apart.
  if (count) trackProductEvent('reminder_optout', { provider: optIn.provider });
}

/**
 * Push the current schedule to the server. Fire-and-forget (reminders are
 * never allowed to break the core app). A 404 means the user unsubscribed
 * from an email link — flip the stale opt-in to cancelled so the UI offers
 * reminders again (and the cancel syncs to their other devices).
 */
export async function pushReminderSchedule(backend: Backend, keepalive = false): Promise<void> {
  const optIn = getReminderOptIn();
  if (optIn?.status !== 'active') return;
  // US-07 AC6: a known minor is due nothing, and the server fills any pushed
  // schedule with its annual check-in. So a row enrolled earlier is turned
  // off instead, for good (AC4), and not counted as their opt-out. A failure
  // is never reported: only a minor reaches it, so a Sentry event would be
  // age data. The next visit retries.
  if (isKnownMinorNow()) {
    try {
      await cancelReminders({ count: false, keepalive });
      window.dispatchEvent(new Event('hr:reminders-changed'));
    } catch { /* retried next visit */ }
    return;
  }
  // A cloud switch in this browser cancelled the old row, on this visit or an
  // earlier one, and its enrolment has not landed (US-17 AC12): a push could
  // refill the tombstone, or 404 into a "cancelled" the user never chose. A
  // switch that never cancelled holds nothing, so the old row keeps its
  // schedule current. A 404 on a token the switch cancelled is that
  // tombstone, not an email-link unsubscribe.
  const cancelledBySwitch = safeGetItem(SWITCH_CANCELLED_KEY) === optIn.token;
  if ((switchHoldsOldToken || cancelledBySwitch) && optIn.provider !== backend) return;
  try {
    const res = await post(
      { op: 'update', token: optIn.token, schedule: computeCurrentReminderSchedule() },
      keepalive,
    );
    // A 404 is about the opt-in this push carried. If the file has moved on
    // meanwhile (a switch saved a new token, an erase, a toggle), or a switch
    // cancelled this token while the request was in flight, it says nothing
    // about the current one (Codex R1, 2026-10-14).
    if (res.status === 404 && !cancelledBySwitch
      && safeGetItem(SWITCH_CANCELLED_KEY) !== optIn.token && sameOptIn(getReminderOptIn(), optIn)) {
      setReminderOptIn({ ...optIn, status: 'cancelled' });
      window.dispatchEvent(new Event('hr:reminders-changed'));
    }
  } catch (error) {
    console.warn('Reminder schedule push failed (will retry next visit)', error);
    Sentry.captureException(error, { tags: { area: 'reminders', op: 'push-schedule' } });
  }
}
