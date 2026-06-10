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
import React, { useEffect, useState } from 'react';
import { getReminderOptIn } from '../src/lib/roadmap-data';
import { EMAIL_REGEX } from '../src/lib/email';
import { cancelReminders, optInToReminders, remindersSupported } from './reminders';
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
    await optInToReminders(backend, marketingEmail);
    resetStep();
  });
  const turnOff = wrap(() => cancelReminders());

  return (
    <div className="hr-reminders">
      {active ? (
        <>
          <span className="hr-sync-status">✓ Email reminders on → {optIn!.email}</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => void turnOff()}>
            {busy ? 'Turning off…' : 'Turn off'}
          </button>
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
            Turn on email reminders
          </button>
        </>
      )}
      {error && <span className="hr-sync-error">{error}</span>}
    </div>
  );
}
