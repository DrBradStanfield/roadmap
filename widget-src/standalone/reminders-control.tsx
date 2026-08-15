/**
 * Email-reminders toggle (§10), rendered under the sync status line for
 * cloud-connected backends. One line each way:
 *   off: "Get an email when a check-up is due" + [Turn on]
 *   on:  "✓ Email reminders on → user@example.com" + [Turn off]
 *
 * Opt-in uses the SAME cloud account that stores the data — the provider
 * vouches for the email, so nobody can point reminders at someone else's
 * inbox. The capability token lives in the user's cloud file.
 *
 * Turning on opens a small inline step that also offers Dr Brad's email list
 * as an OPT-IN with a TYPED email (§10: no harvesting at cloud-connect — the
 * deliberate act of typing + ticking is the consent). The typed address goes
 * to Klaviyo only; the reminder row never stores it.
 */
import { useEffect, useState } from 'react';
import { getReminderOptIn } from '../src/lib/roadmap-data';
import { EMAIL_REGEX } from '../src/lib/email';
import { cancelReminders, ENROL_NOTICE_KEY, optInToReminders, remindersSupported } from './reminders';
import type { Backend } from './connect';

export function RemindersControl({ backend }: { backend: Backend }) {
  // Not useBusyRun: that scaffold leaves busy=true on success (its flows end
  // in a reload). This toggle stays on the page, so busy must reset.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [wantsUpdates, setWantsUpdates] = useState(false);
  const [typedEmail, setTypedEmail] = useState('');
  // The opt-in lives in the user's file; local state just re-renders on change.
  const [, setVersion] = useState(0);

  // The load-time schedule push clears a stale opt-in when the user
  // unsubscribed from an email link (404) — re-render when that happens.
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1);
    window.addEventListener('hr:reminders-changed', onChange);
    return () => window.removeEventListener('hr:reminders-changed', onChange);
  }, []);

  if (!remindersSupported(backend)) return null;
  const optIn = getReminderOptIn();
  const active = optIn?.status === 'active';

  const wrap = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — please retry.');
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  };

  const resetStep = () => {
    setConfirming(false);
    setWantsUpdates(false);
    setTypedEmail('');
  };

  const turnOn = wrap(async () => {
    const marketingEmail = wantsUpdates ? typedEmail.trim() : undefined;
    if (marketingEmail !== undefined && !EMAIL_REGEX.test(marketingEmail)) {
      throw new Error('That email doesn’t look right — please check it (or untick the box).');
    }
    await optInToReminders(backend, { marketingEmail });
    resetStep();
  });
  const turnOff = wrap(() => cancelReminders());

  return (
    <div className="hr-reminders">
      {active ? (
        <>
          <span className="hr-sync-status">✓ Email health reminders on → {optIn!.email}</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => void turnOff()}>
            {busy ? 'Turning off…' : 'Turn off'}
          </button>
          {/* US-17 AC1/AC5: default-on must never be silent. Wherever the
              control renders, it states exactly what leaves the device. */}
          <span className="hr-reminders-disclosure">
            We’ll email you when a check-up or blood test comes due. What reaches Dr Brad’s server:
            the NAME and due date of each check-up (for example “Colonoscopy — due May 2027”), plus
            your cloud account’s email address. Your measurements, results and plan never leave
            your device.
          </span>
        </>
      ) : confirming ? (
        <div className="hr-sync-form">
          <span className="hr-sync-detail">
            Reminders go to the email on your connected cloud account.
          </span>
          <label className="hr-sync-detail">
            <input
              type="checkbox"
              checked={wantsUpdates}
              onChange={(e) => setWantsUpdates(e.target.checked)}
            />{' '}
            Also send me Dr Brad’s evidence-based health emails (unsubscribe anytime)
          </label>
          {wantsUpdates && (
            <input
              type="email"
              placeholder="Type your email for Dr Brad’s emails"
              aria-label="Email for Dr Brad’s health emails"
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
            />
          )}
          <span>
            <button className="hr-sync-link" disabled={busy} onClick={() => void turnOn()}>
              {busy ? 'Setting up…' : 'Turn on reminders'}
            </button>{' '}
            <button
              className="hr-sync-link"
              disabled={busy}
              onClick={() => { resetStep(); setError(null); }}
            >
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <>
          <span className="hr-sync-detail">Get an email when a check-up or blood test comes due.</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => setConfirming(true)}>
            Turn on email health reminders
          </button>
        </>
      )}
      {error && <span className="hr-sync-error">{error}</span>}
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
    <div className="hr-sync hr-reminders-notice">
      <RemindersControl backend={backend} />
      <button type="button" className="hr-sync-link hr-reminders-dismiss" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
