/**
 * Email-reminders toggle (§10), rendered under the sync status line for
 * cloud-connected backends. One line each way:
 *   off: "Get an email when a check-up is due" + [Turn on]
 *   on:  "✓ Email reminders on → user@example.com" + [Turn off]
 *
 * Opt-in goes to the email of the SAME cloud storage that stores the data,
 * read in the browser (US-17 AC7 — no storage credential leaves it). When the
 * provider has none to give (a GitHub token without the email permission),
 * the control asks for the address once. The capability token lives in the
 * user's cloud file.
 *
 * Turning on opens a small inline step that also offers the MicroVitamin
 * mailing list (Dr Brad's supplement company; US-23 AC11) as an OPT-IN with a
 * TYPED email (§10: no harvesting at cloud-connect — the deliberate act of
 * typing + ticking is the consent). The typed address goes to Klaviyo only;
 * the reminder row never stores it.
 */
import { useEffect, useReducer, useState } from 'react';
import { getReminderOptIn } from '../src/lib/roadmap-data';
import { EMAIL_REGEX } from '../src/lib/email';
import { REMOTE_CHANGED_EVENT } from '../src/storage/roadmap-store';
import { cancelReminders, ENROL_NOTICE_KEY, optInToReminders, ReminderEmailNeeded, remindersSupported } from './reminders';
import { busy as isBusy, INITIAL_STEP, shown, transition, type FormEdit, type ToggleForm } from './reminders-toggle-machine';
import type { Backend } from './connect';

const failure = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong — please retry.');

export function RemindersControl({ backend }: { backend: Backend }) {
  // The toggle's mode, one step (H116); on or off is the record's, read below.
  const [step, send] = useReducer(transition, INITIAL_STEP);
  // The opt-in lives in the user's file; local state just re-renders on change.
  const [, setVersion] = useState(0);

  // The load-time schedule push clears a stale opt-in when the user
  // unsubscribed from an email link (404), and another device's choice is
  // merged in (US-17 AC17) — re-render when either happens.
  useEffect(() => {
    const onChange = () => {
      setVersion((v) => v + 1);
      if (getReminderOptIn()?.status === 'active') send({ type: 'recordOn' });
    };
    window.addEventListener('hr:reminders-changed', onChange);
    window.addEventListener(REMOTE_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener('hr:reminders-changed', onChange);
      window.removeEventListener(REMOTE_CHANGED_EVENT, onChange);
    };
  }, []);

  if (!remindersSupported(backend)) return null;
  const optIn = getReminderOptIn();
  const active = optIn?.status === 'active';

  const busy = isBusy(step);
  const view = shown(step);
  const edit = (change: FormEdit) => send({ type: 'edit', edit: change });

  const turnOn = async (form: ToggleForm): Promise<void> => {
    send({ type: 'submit' });
    try {
      const marketingEmail = form.wantsUpdates ? form.typedEmail.trim() : undefined;
      if (marketingEmail !== undefined && !EMAIL_REGEX.test(marketingEmail)) {
        throw new Error('That email doesn’t look right — please check it (or untick the box).');
      }
      const email = form.needsEmail ? form.reminderEmail.trim() : undefined;
      if (email !== undefined && !EMAIL_REGEX.test(email)) {
        throw new Error('That email doesn’t look right — please check it.');
      }
      const result = await optInToReminders(backend, { marketingEmail, email });
      send(result.refreshed ? { type: 'onRefreshed', email: result.email } : { type: 'onDone' });
    } catch (e) {
      send({ type: 'onFailed', message: failure(e), needsEmail: e instanceof ReminderEmailNeeded });
    }
  };
  const turnOff = async (): Promise<void> => {
    send({ type: 'off' });
    try {
      await cancelReminders();
      send({ type: 'offDone' });
    } catch (e) {
      send({ type: 'offFailed', message: failure(e) });
    }
  };

  return (
    <div className="hr-reminders">
      {active ? (
        <>
          <span className="hr-sync-status">✓ Email health reminders on → {optIn!.email}</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => void turnOff()}>
            {step.phase === 'turningOn' ? 'Setting up…' : busy ? 'Turning off…' : 'Turn off'}
          </button>
          {/* US-17 AC1/AC5: default-on must never be silent. Wherever the
              control renders, it states exactly what leaves the device. */}
          <span className="hr-reminders-disclosure">
            We’ll email you when a check-up or blood test comes due. What reaches Dr Brad’s server:
            the NAME and due date of each check-up (for example “Colonoscopy — due May 2027”), plus
            your email address (the one on your cloud account, or the one you typed).
          </span>
        </>
      ) : view.phase === 'asking' ? (
        <div className="hr-sync-form">
          <span className="hr-sync-detail">
            Reminders go to the email address of your connected cloud storage.
          </span>
          {view.form.needsEmail && (
            <input
              type="email"
              placeholder="Email for your reminders"
              aria-label="Email for your reminders"
              value={view.form.reminderEmail}
              readOnly={busy}
              onChange={(e) => edit({ reminderEmail: e.target.value })}
            />
          )}
          <label className="hr-sync-detail">
            <input
              type="checkbox"
              checked={view.form.wantsUpdates}
              onChange={(e) => edit({ wantsUpdates: e.target.checked })}
            />{' '}
            Also add me to the MicroVitamin mailing list (Dr Brad’s supplement company). Unsubscribe anytime.
          </label>
          {view.form.wantsUpdates && (
            <input
              type="email"
              placeholder="Your email for the MicroVitamin list"
              aria-label="Email for the MicroVitamin mailing list"
              value={view.form.typedEmail}
              readOnly={busy}
              onChange={(e) => edit({ typedEmail: e.target.value })}
            />
          )}
          <span>
            <button className="hr-sync-link" disabled={busy} onClick={() => void turnOn(view.form)}>
              {busy ? 'Setting up…' : 'Turn on reminders'}
            </button>{' '}
            <button className="hr-sync-link" disabled={busy} onClick={() => send({ type: 'dismiss' })}>
              Cancel
            </button>
          </span>
        </div>
      ) : view.phase === 'refreshed' ? (
        <span className="hr-sync-detail">
          Reminders are already set up for {view.email} — we refreshed your schedule. To turn them off,
          use the link in any reminder email.
        </span>
      ) : (
        <>
          <span className="hr-sync-detail">Get an email when a check-up or blood test comes due.</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => send({ type: 'open' })}>
            Turn on email health reminders
          </button>
        </>
      )}
      {view.error && <span className="hr-sync-error">{view.error}</span>}
    </div>
  );
}

/**
 * The "you're enrolled" notice for US-17's default-on enrolment — Brad's second
 * non-negotiable constraint: default-on must be VISIBLE, never silent.
 *
 * It renders ABOVE the whole widget, not inside the plan panel, and that is the
 * point. The plan panel is slide 2 of the mobile tab layout and every connect
 * path ends in a reload onto the *input* tab, so a notice living there would
 * mount off-screen and be seen by nobody on the majority surface. It is also
 * absent from the no-data-yet render branch — exactly the user who just
 * connected a cloud.
 *
 * It is the control itself, not a copy of it: same state, same off switch, same
 * disclosure — so turning reminders off is one click from the sentence that
 * told you they were on. It survives a reload (sessionStorage) and stays until
 * dismissed, because a disclosure the user blinked past is not a disclosure.
 */
export function RemindersEnrolledNotice({ backend }: { backend: Backend }) {
  const [shown, setShown] = useState(() => {
    try { return sessionStorage.getItem(ENROL_NOTICE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    const onEnrolled = () => setShown(true);
    window.addEventListener('hr:reminders-enrolled', onEnrolled);
    return () => window.removeEventListener('hr:reminders-enrolled', onEnrolled);
  }, []);

  if (!shown) return null;
  const dismiss = (): void => {
    try { sessionStorage.removeItem(ENROL_NOTICE_KEY); } catch { /* nothing to clear */ }
    setShown(false);
  };
  return (
    <div className="hr-sync hr-page-notice">
      <RemindersControl backend={backend} />
      <button type="button" className="hr-sync-link hr-page-notice-dismiss" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
