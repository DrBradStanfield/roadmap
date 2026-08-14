/**
 * Sync status control (rendered inside the plan panel). Shows where the data
 * lives and opens the BackendPickerModal to choose/switch — switching copies
 * the current cloud down to this device first, so nothing is ever stranded.
 *
 * The Drive "signed out" state keeps its own inline Reconnect button (GIS popup
 * fallback — one click, no modal).
 *
 * Phase 5 (website): after the "Get Your Personalized Plan" email step, fire
 * `window.dispatchEvent(new Event('hr:open-backend-picker'))` to auto-open the
 * picker once — the listener below already handles it.
 */
import React, { useEffect, useState } from 'react';
import { GoogleDriveAdapter } from '../src/storage';
import { googleDriveConfig } from './google-config';
import { BACKEND_KEY, liftLocalInto, PROVIDER_LABELS, useBusyRun, type Backend } from './connect';
import { BackendPickerModal } from './backend-picker';
import { RemindersControl } from './reminders-control';
import { remindersSupported } from './reminders';

export function SyncControl({ backend, reconnect, hasData = true }: {
  backend: Backend;
  reconnect?: 'google-drive';
  /** False while the user hasn't entered any data yet — the device-tier
   *  "choose where to save" pitch stays hidden (nothing to save; Brad,
   *  2026-06-11). Cloud/reconnect states always show — data is at stake. */
  hasData?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { busy, error, run } = useBusyRun();

  useEffect(() => {
    const open = () => setPickerOpen(true);
    window.addEventListener('hr:open-backend-picker', open);
    return () => window.removeEventListener('hr:open-backend-picker', open);
  }, []);

  // Reconnect via the GIS popup FALLBACK (~1 h token) — works even with the
  // exchange endpoint down; needs this click's user gesture. Local edits made
  // while signed out merge up before the reload.
  const reconnectDrive = (): Promise<void> =>
    run(async () => {
      const gd = new GoogleDriveAdapter(googleDriveConfig());
      await gd.connectViaPopup();
      await liftLocalInto(gd, 'google-drive');
      localStorage.setItem(BACKEND_KEY, 'google-drive');
      location.reload();
    });

  // Forget the pending Google Drive connection (no copy-down needed — this
  // session already runs on the device copy; the Drive file stays put).
  const forgetDrive = (): Promise<void> =>
    run(async () => {
      await new GoogleDriveAdapter(googleDriveConfig()).disconnect();
      localStorage.removeItem(BACKEND_KEY);
      location.reload();
    });

  let content: React.ReactNode;
  if (reconnect === 'google-drive') {
    // Google Drive remembered but its short-lived token is gone (endpoint down /
    // revoked). Re-auth needs a user click (browsers block popups at page load).
    content = (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">Google Drive — signed out</span>
        <button className="hr-sync-btn" disabled={busy} onClick={() => void reconnectDrive()}>
          {busy ? 'Reconnecting…' : 'Reconnect Google Drive'}
        </button>
        <span className="hr-sync-detail">
          Your data is safe in your Google Drive. Sign in again to keep syncing — anything you change
          meanwhile is saved on this device and merges when you reconnect.
        </span>
        <div className="hr-sync-more">
          <button type="button" className="hr-sync-link" onClick={() => void forgetDrive()}>Use this device only</button>
        </div>
        {error && <span className="hr-sync-error">{error}</span>}
      </div>
    );
  } else if (backend !== 'local') {
    // Single clean line: the privacy promise IS the status (the ✓ now leads it).
    // The reminders toggle moved out to its own plan section (RemindersSection,
    // wired via the remindersSection prop in app.tsx). The provider NAME is the
    // affordance — clicking it opens the picker (the manage/Account surface),
    // where the user can switch the cloud or log off this device. There is no
    // separate "Account" link; the picker is the only home for log-off +
    // switch-storage, so the name must open it (not link out to the cloud site).
    content = (
      <div className="hr-sync hr-sync-cloud">
        <span className="hr-sync-status">
          ✓ Your health data is yours alone — it never leaves your{' '}
          <button type="button" className="hr-sync-status-link" onClick={() => setPickerOpen(true)}>
            {PROVIDER_LABELS[backend]}
          </button>
        </span>
      </div>
    );
  } else if (!hasData) {
    // Brand-new user, nothing entered yet — no storage pitch (the picker stays
    // reachable via the hr:open-backend-picker event, e.g. the email step).
    content = null;
  } else {
    content = (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">Saved on this device only</span>
        <button className="hr-sync-btn" onClick={() => setPickerOpen(true)}>Save to your cloud</button>
        <span className="hr-sync-detail">Connect your own Google Drive or Dropbox so your plan is backed up and you can track changes over time — Dr Brad never stores your health data.</span>
      </div>
    );
  }

  return (
    <>
      {content}
      {pickerOpen && <BackendPickerModal current={backend} onClose={() => setPickerOpen(false)} />}
    </>
  );
}

/**
 * Email-reminders as its own labelled section of the plan (Brad, 2026-06-15:
 * "that should be in the email-reminders section, not at the top"). Rendered
 * via the remindersSection prop in app.tsx, near the foot of the plan. Returns
 * null for backends that can't do reminders (local / WebDAV) — same gate as the
 * inline control used, so nothing renders where reminders aren't possible.
 */
export function RemindersSection({ backend }: { backend: Backend }) {
  if (!remindersSupported(backend)) return null;
  return (
    <section className="hr-reminders-section">
      <h3 className="hr-reminders-heading">Email reminders</h3>
      <div className="hr-sync hr-sync-cloud">
        <RemindersControl backend={backend} />
      </div>
    </section>
  );
}
