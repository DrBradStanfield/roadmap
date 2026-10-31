/**
 * Sync status control (rendered inside the plan panel). Shows where the data
 * lives and opens the BackendPickerModal to choose/switch — switching copies
 * the current cloud down to this device first, so nothing is ever stranded.
 *
 * A provider that could not be read this session is NAMED, never replaced by the
 * guest pitch (US-09 AC13): Drive keeps its own inline Reconnect button (GIS
 * popup fallback — one click, no modal), every other provider gets Retry.
 *
 * openBackendPicker() (src/lib/storage-notice.tsx) is the only way in; the
 * listener below is the only listener.
 */
import React, { useEffect, useState } from 'react';
import { gisReady, GoogleDriveAdapter, isSyncPending, preloadGis, SYNC_PENDING_EVENT } from '../src/storage';
import { googleDriveConfig } from './google-config';
import { adapterFor, connectRefusal, forgetBackend, liftLocalInto, PROVIDER_LABELS, rememberBackend, storageState, useBusyRun, type Backend } from './connect';
import { BackendPickerModal } from './backend-picker';
import { RemindersControl } from './reminders-control';
import { remindersSupported } from './reminders';
import { openBackendPicker, OPEN_PICKER_EVENT, PLAN_STORAGE_CTA, StorageSentence } from '../src/lib/storage-notice';
import { safeGetItem, safeSetItem } from '../src/lib/storage';

/** US-09 AC19: the picker was opened once in this browser (a side key, never the record). */
const STORAGE_CTA_SEEN_KEY = 'hr_storage_cta_seen';
/** The same, for this page's life, in case storage throws. */
let storageCtaSeen = false;

/** "Still waiting to sync": driven by the store's pending-sync marker, set by a
 *  failed cloud save or a failed connect-time lift and cleared by the next
 *  successful cloud save. The store fires SYNC_PENDING_EVENT on every flip, so
 *  this is true only while data is genuinely unsynced; no polling. */
function usePendingSync(backend: Backend): boolean {
  const [pendingSync, setPendingSync] = useState(false);
  useEffect(() => {
    if (backend === 'local') return;
    const check = () => setPendingSync(isSyncPending());
    check();
    window.addEventListener(SYNC_PENDING_EVENT, check);
    return () => window.removeEventListener(SYNC_PENDING_EVENT, check);
  }, [backend]);
  return pendingSync;
}

/** US-09 AC30: the top bar's label, from the real storage state (storageState's
 *  three, plus pending sync), so it never claims what is not true. A reconnect
 *  session runs on 'local', so it is asked first. */
function storageBarLabel(backend: Backend, reconnect: Exclude<Backend, 'local'> | undefined, pendingSync: boolean): string {
  // Only Drive can re-auth in place; the others only try the read again, as the panel says.
  if (reconnect) return reconnect === 'google-drive' ? 'Sign in to Google again' : 'Retry';
  if (backend === 'local') return 'Sign in';
  return pendingSync ? 'Saving…' : PROVIDER_LABELS[backend];
}

/** One reconnect at a time across the bar and the panel (both mount the hook). */
let reconnectInFlight = false;

/** US-09 AC30: said instead of starting a popup the browser would block. */
export const GIS_LOADING = 'Google is loading. Tap again.';

/** US-09 AC13: the way back to a provider that could not be read this session,
 *  shared by the plan panel and the top bar so the two cannot drift. Drive
 *  re-auths through the GIS popup FALLBACK (~1 h token), which works even with
 *  the exchange endpoint down and needs this click's user gesture, so it starts
 *  synchronously inside the click; local edits made while signed out merge up
 *  before the reload. The others can only try the read again. */
function useReconnect(reconnect?: Exclude<Backend, 'local'>) {
  const { busy, error, setError, run } = useBusyRun();
  // GIS loads on mount, so the click can open the popup synchronously.
  useEffect(() => { if (reconnect === 'google-drive') preloadGis(); }, [reconnect]);
  const reconnectNow = (): void => {
    if (reconnect !== 'google-drive') { location.reload(); return; }
    // Still loading: a popup started now would outlast the click and be blocked.
    if (!gisReady()) { preloadGis(); setError(GIS_LOADING); return; }
    if (reconnectInFlight) return;
    reconnectInFlight = true;
    void run(async () => {
      try {
        const gd = new GoogleDriveAdapter(googleDriveConfig());
        await gd.connectViaPopup().catch((error: unknown) => { connectRefusal(error); throw error; });
        await liftLocalInto(gd, 'google-drive');
        rememberBackend('google-drive');
        location.reload();
      } finally {
        reconnectInFlight = false;
      }
    });
  };
  return { busy, error, run, reconnectNow };
}

/** US-09 AC30: the top bar's storage button, where "Supercharge this tool" sat.
 *  A record that could not be read runs the panel's own reconnect; every other
 *  state opens the one picker, which SyncControl hosts (AC13). */
export function StorageBar({ backend, reconnect }: { backend: Backend; reconnect?: Exclude<Backend, 'local'> }) {
  const pendingSync = usePendingSync(backend);
  const { busy, error, reconnectNow } = useReconnect(reconnect);
  return (
    <>
      <button
        type="button"
        className="action-btn-small"
        aria-haspopup={reconnect ? undefined : 'dialog'}
        disabled={busy}
        onClick={reconnect ? reconnectNow : openBackendPicker}
      >
        {busy ? 'Reconnecting…' : storageBarLabel(backend, reconnect, pendingSync)}
      </button>
      {error && <span className="hr-sync-error" role="alert">{error}</span>}
    </>
  );
}

export function SyncControl({ backend, reconnect, hasData = true, attention = false }: {
  backend: Backend;
  reconnect?: Exclude<Backend, 'local'>;
  /** False while the user hasn't entered any data yet — the device-tier
   *  "choose where to save" pitch stays hidden (nothing to save; Brad,
   *  2026-06-11). Cloud/reconnect states always show — data is at stake. */
  hasData?: boolean;
  /** The guest has their PDF (US-09 AC19): pulse the storage button until the picker first opens. */
  attention?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Unreadable storage counts as unseen, so the pulse lasts only this page's life.
  const [ctaSeen, setCtaSeen] = useState(() => storageCtaSeen || !!safeGetItem(STORAGE_CTA_SEEN_KEY));
  const { busy, error, run, reconnectNow } = useReconnect(reconnect);

  // Every route to the picker passes here, so any opening stops the pulse.
  useEffect(() => {
    const open = () => {
      storageCtaSeen = true;
      safeSetItem(STORAGE_CTA_SEEN_KEY, '1');
      setCtaSeen(true);
      setPickerOpen(true);
    };
    window.addEventListener(OPEN_PICKER_EVENT, open);
    return () => window.removeEventListener(OPEN_PICKER_EVENT, open);
  }, []);

  const pendingSync = usePendingSync(backend);

  // Forget the unreachable connection (no copy-down needed — this session
  // already runs on the device copy; the cloud file stays put).
  const forgetProvider = (provider: Exclude<Backend, 'local'>): Promise<void> =>
    run(async () => {
      await adapterFor(provider)?.disconnect();
      forgetBackend();
      location.reload();
    });

  const state = storageState(backend, reconnect);
  const provider = backend === 'local' ? '' : PROVIDER_LABELS[backend];
  let content: React.ReactNode;
  if (reconnect) {
    // The remembered provider could not be read this session (US-09 AC13). Name
    // it and offer the way back — never the guest "choose where to save" pitch:
    // this user HAS chosen, and their record is sitting in that provider. Drive
    // can re-auth in place (the GIS popup), so it gets that button; for the
    // others the only cure is to try the read again.
    const label = PROVIDER_LABELS[reconnect];
    const drive = reconnect === 'google-drive';
    content = (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">{label} {drive ? 'is signed out' : 'could not be reached'}</span>
        <button
          className="hr-sync-btn"
          disabled={busy}
          onClick={reconnectNow}
        >
          {drive ? (busy ? 'Reconnecting…' : `Reconnect ${label}`) : 'Retry'}
        </button>
        <span className="hr-sync-detail">
          Your record is safe in your {label}.{' '}
          {drive
            ? 'Sign in again to keep it in step. Anything you change meanwhile is kept in this browser and merges when you reconnect.'
            : `Anything you change now is kept in this browser and merges as soon as ${label} answers again.`}
        </span>
        <div className="hr-sync-more">
          <button type="button" className="hr-sync-link" onClick={() => void forgetProvider(reconnect)}>Use this browser only</button>
        </div>
        {error && <span className="hr-sync-error">{error}</span>}
      </div>
    );
  } else if (state === 'cloud') {
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
          ✓ Your health record is yours alone. It lives in your{' '}
          <button type="button" className="hr-sync-status-link" onClick={openBackendPicker}>
            {provider}
          </button>
        </span>
        {pendingSync && (
          <span className="hr-sync-detail">
            Some data in this browser is still waiting to sync to your {provider}.
            It will upload automatically. Your data is safe in this browser meanwhile.
          </span>
        )}
      </div>
    );
  } else if (!hasData) {
    // Brand-new user, nothing entered yet — no storage pitch (the picker stays
    // reachable via openBackendPicker(), e.g. the email step).
    content = null;
  } else {
    content = (
      <div className="hr-sync hr-sync-local">
        <button
          className={`hr-sync-btn hr-sync-btn-full${attention && !ctaSeen ? ' hr-sync-btn-attention' : ''}`}
          onClick={openBackendPicker}
        >
          {PLAN_STORAGE_CTA}
        </button>
        {/* Gate-free: this branch is already the guest, no-provider state. */}
        <StorageSentence surface="plan" className="hr-sync-detail" />
      </div>
    );
  }

  return (
    <>
      {content}
      {/* An unreachable provider is still the CURRENT one: the picker must copy
          it down (and fail loudly if it cannot) before any switch, or the
          record is orphaned there (US-09 AC13). */}
      {pickerOpen && <BackendPickerModal current={reconnect ?? backend} unreachable={!!reconnect} onClose={() => setPickerOpen(false)} />}
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
