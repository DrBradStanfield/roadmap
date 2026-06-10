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
import { BACKEND_KEY, migrateLocalInto, useBusyRun, type Backend } from './connect';
import { BackendPickerModal } from './backend-picker';
import { RemindersControl } from './reminders-control';

const LABELS: Record<Exclude<Backend, 'local'>, string> = {
  dropbox: 'Dropbox',
  'google-drive': 'Google Drive',
  github: 'GitHub',
  'self-host': 'your own server',
};

export function SyncControl({ backend, reconnect }: { backend: Backend; reconnect?: 'google-drive' }) {
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
      await migrateLocalInto(gd);
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
    content = (
      <div className="hr-sync hr-sync-cloud">
        <span className="hr-sync-status">✓ Synced to {LABELS[backend]}</span>
        <button className="hr-sync-link" onClick={() => setPickerOpen(true)}>Change</button>
        <span className="hr-sync-detail">Your health data lives only in {LABELS[backend]} — never on Dr Brad's servers.</span>
        <RemindersControl backend={backend} />
      </div>
    );
  } else {
    content = (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">Saved on this device</span>
        <button className="hr-sync-btn" onClick={() => setPickerOpen(true)}>Choose where to save</button>
        <span className="hr-sync-detail">Your health data is only in this browser. Save it to your own cloud to sync across your phone and computer.</span>
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
