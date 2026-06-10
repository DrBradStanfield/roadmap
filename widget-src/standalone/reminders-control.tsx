/**
 * Email-reminders toggle (§10), rendered under the sync status line for
 * cloud-connected backends. One line each way:
 *   off: "Get an email when a check-up is due" + [Turn on]
 *   on:  "✓ Email reminders on → user@example.com" + [Turn off]
 *
 * Opt-in uses the SAME cloud account that stores the data — the provider
 * vouches for the email, so nobody can point reminders at someone else's
 * inbox. The capability token lives in the user's cloud file.
 */
import React, { useState } from 'react';
import { getReminderOptIn } from '../src/lib/roadmap-data';
import { cancelReminders, optInToReminders, remindersSupported } from './reminders';
import type { Backend } from './connect';

export function RemindersControl({ backend }: { backend: Backend }) {
  // Not useBusyRun: that scaffold leaves busy=true on success (its flows end
  // in a reload). This toggle stays on the page, so busy must reset.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The opt-in lives in the user's file; local state just re-renders on change.
  const [, setVersion] = useState(0);

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

  const turnOn = wrap(() => optInToReminders(backend).then(() => undefined));
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
      ) : (
        <>
          <span className="hr-sync-detail">Get an email when a check-up or blood test comes due.</span>
          <button className="hr-sync-link" disabled={busy} onClick={() => void turnOn()}>
            {busy ? 'Setting up…' : 'Turn on email reminders'}
          </button>
        </>
      )}
      {error && <span className="hr-sync-error">{error}</span>}
    </div>
  );
}
