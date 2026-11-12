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
import { gisReady, GoogleDriveAdapter, isSyncPending, preloadGis, SAVE_STATUS_EVENT, SYNC_PENDING_EVENT } from '../src/storage';
import { currentSaveStatus } from '../src/lib/roadmap-data';
import type { SaveStatus } from '@roadmap/health-core/save-state';
import { googleDriveConfig } from './google-config';
import { adapterFor, connectRefusal, forgetBackend, liftLocalInto, rememberBackend, storageState, useBusyRun, type Backend } from './connect';
import { PROVIDERS } from './providers';
import { BackendPickerModal } from './backend-picker';
import { RemindersControl } from './reminders-control';
import { remindersSupported } from './reminders';
import { openBackendPicker, openSignin, OPEN_PICKER_EVENT, PLAN_STORAGE_CTA, StorageSentence } from '../src/lib/storage-notice';
import { safeGetItem, safeSetItem } from '../src/lib/storage';
import { useIsMobile } from '../src/lib/useIsMobile';
import { LOCAL_SAVE_EVENT, localSaveRefused } from '../src/storage/local-storage-adapter';

/** US-09 AC19: the picker was opened once in this browser (a side key, never the record). */
const STORAGE_CTA_SEEN_KEY = 'hr_storage_cta_seen';
/** The same, for this page's life, in case storage throws. */
let storageCtaSeen = false;

/** What a connected record's save is doing: the session's save status (US-09
 *  AC30), and the store's pending-sync marker ("still waiting to sync"), set by
 *  a failed cloud save or a failed connect-time lift and cleared by the next
 *  successful cloud save. Each fires its event on every change; no polling. */
interface SaveFacts { status: SaveStatus; pendingSync: boolean }
const readSaveFacts = (): SaveFacts => ({ status: currentSaveStatus(), pendingSync: isSyncPending() });
function useSaveFacts(backend: Backend): SaveFacts {
  // Read at mount, so the first frame never says a false Synced.
  const [facts, setFacts] = useState<SaveFacts>(() => (backend === 'local' ? { status: 'saved', pendingSync: false } : readSaveFacts()));
  useEffect(() => {
    if (backend === 'local') return;
    const check = () => setFacts(readSaveFacts());
    check();
    const events = [SYNC_PENDING_EVENT, SAVE_STATUS_EVENT];
    for (const name of events) window.addEventListener(name, check);
    return () => { for (const name of events) window.removeEventListener(name, check); };
  }, [backend]);
  return facts;
}

/** US-01 AC5: said while this browser's storage refused the record's last
 *  save. The change stays on screen, as a refused cloud save's does. */
const LOCAL_SAVE_REFUSED = 'Could not save on this device (local storage may be full). Your latest changes show here but are not saved.';

/** True while a refused save on this device has stored none of its change;
 *  the adapter fires the event on every flip, so no polling. */
function useLocalSaveRefused(backend: Backend): boolean {
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (backend !== 'local') return;
    const check = () => setRefused(localSaveRefused());
    check();
    window.addEventListener(LOCAL_SAVE_EVENT, check);
    return () => window.removeEventListener(LOCAL_SAVE_EVENT, check);
  }, [backend]);
  return refused;
}

/** US-01 AC5: said while this device refuses the record's saves. Beside the storage button,
 *  and on a phone also atop My health and Chat, since the button sits in the Account tab (US-62 AC34). */
export function LocalSaveAlert({ backend }: { backend: Backend }) {
  const localRefused = useLocalSaveRefused(backend);
  return localRefused ? <span className="hr-sync-error" role="alert">{LOCAL_SAVE_REFUSED}</span> : null;
}

/** US-09 AC30: a connected record's save words (lead A1 step d, owner 2026-11-12),
 *  as the iPhone says them (SyncStatusText.swift). */
const SAVING_TO = (provider: string) => `Saving to ${provider}…`;
const NOT_SYNCED_ON_DEVICE = 'Not synced yet. Your changes are on this device.';
const NOT_SYNCED = 'Not synced yet.';
const SYNCED_TO = (provider: string) => `Synced to ${provider}`;

/** The device copy holds the unsynced changes: this session's failed save
 *  wrote its device copy, and the marker still stands (another tab's log-off
 *  deletes both). The marker alone never says so: it is set before that write
 *  (US-09 AC4), and it outlives a save that lands when its release cannot read
 *  the device copy (a newer app's, or corrupt). */
const deviceHolds = ({ status, pendingSync }: SaveFacts): boolean =>
  pendingSync && status === 'not-saved-on-device';

/** US-09 AC30: the title line's words, from the real storage state (storageState's
 *  three, the session's save status and the device marker), so they never claim
 *  what is not true. A reconnect session runs on 'local', so it is asked first. */
function storageBarLabel(backend: Backend, reconnect: Exclude<Backend, 'local'> | undefined, facts: SaveFacts, problemsOnly: boolean): string {
  // Only Drive can re-auth in place; the others only try the read again, as the panel says.
  if (reconnect) return reconnect === 'google-drive' ? 'Sign in to Google again' : 'Retry';
  if (backend === 'local') return 'Sign in';
  // Status, not a call to action (Brad 2026-11-09). A marker set while the
  // session is saved stands over a device copy its release could not read, or
  // another tab's write: not synced, and nothing claimed of the device. On a
  // phone a retry over a set marker keeps the problem shown, in words true
  // whatever the device holds (F3).
  const provider = PROVIDERS[backend].label;
  if (facts.status === 'saving') return problemsOnly && facts.pendingSync ? NOT_SYNCED : SAVING_TO(provider);
  if (deviceHolds(facts)) return NOT_SYNCED_ON_DEVICE;
  return facts.status === 'saved' && !facts.pendingSync ? SYNCED_TO(provider) : NOT_SYNCED;
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

/** US-09 AC30: the title line's storage state. A record that could not be read runs the
 *  panel's own reconnect; a guest's Sign in opens the one picker, which SyncControl hosts
 *  (AC13). A connected record's state is text: the storage card's provider link opens the
 *  picker. On a phone (US-62 AC34) Account draws no Sign in here, since the storage card's
 *  button is the one sign-in, and `problemsOnly` draws the bar atop My health only while a
 *  reconnect or a change not synced needs saying: never for a save that runs, which would
 *  flash on every edit burst, unless the marker is set: then "Not synced yet." (owner, 2026-11-12). */
export function StorageBar({ backend, reconnect, problemsOnly = false }: { backend: Backend; reconnect?: Exclude<Backend, 'local'>; problemsOnly?: boolean }) {
  const facts = useSaveFacts(backend);
  const isMobile = useIsMobile();
  const { busy, error, reconnectNow } = useReconnect(reconnect);
  const label = storageBarLabel(backend, reconnect, facts, problemsOnly);
  if (problemsOnly && !reconnect && label !== NOT_SYNCED_ON_DEVICE && label !== NOT_SYNCED) return null;
  return (
    <>
      {reconnect || (backend === 'local' && !isMobile) ? (
        <button
          type="button"
          className="action-btn-small"
          aria-haspopup={reconnect ? undefined : 'dialog'}
          disabled={busy}
          onClick={reconnect ? reconnectNow : () => openSignin('top_bar')}
        >
          {busy ? 'Reconnecting…' : label}
        </button>
      ) : backend !== 'local' && <span className="hr-storage-state">{label}</span>}
      {error && <span className="hr-sync-error" role="alert">{error}</span>}
      {/* US-01 AC5: beside where the record lives; atop My health and Chat, a phone's saveAlert says it. */}
      {!problemsOnly && <LocalSaveAlert backend={backend} />}
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

  const facts = useSaveFacts(backend);

  // Forget the unreachable connection (no copy-down needed — this session
  // already runs on the device copy; the cloud file stays put).
  const forgetProvider = (provider: Exclude<Backend, 'local'>): Promise<void> =>
    run(async () => {
      await adapterFor(provider)?.disconnect();
      forgetBackend();
      location.reload();
    });

  const state = storageState(backend, reconnect);
  const provider = backend === 'local' ? '' : PROVIDERS[backend].label;
  let content: React.ReactNode;
  if (reconnect) {
    // The remembered provider could not be read this session (US-09 AC13). Name
    // it and offer the way back — never the guest "choose where to save" pitch:
    // this user HAS chosen, and their record is sitting in that provider. Drive
    // can re-auth in place (the GIS popup), so it gets that button; for the
    // others the only cure is to try the read again.
    const label = PROVIDERS[reconnect].label;
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
        {deviceHolds(facts) && (
          <span className="hr-sync-detail">
            Some data in this browser is still waiting to sync to your {provider}.
            Your data is safe in this browser meanwhile.
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
          onClick={() => openSignin('plan_panel')}
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
