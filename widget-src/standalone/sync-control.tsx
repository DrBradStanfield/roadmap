/**
 * Sync status control (rendered inside the plan panel). Shows where the data
 * lives and opens the BackendPickerModal to choose/switch — switching copies
 * the current cloud down to this device first, so nothing is ever stranded.
 *
 * A provider that could not be read this session is NAMED, never replaced by the
 * guest pitch (US-09 AC13): a Drive or Dropbox sign-in that ended gets its own
 * Reconnect button (Drive's GIS popup, Dropbox's sign-in redirect), and a cloud
 * that did not answer gets Retry. Which one is the page's sign-in state
 * (US-09 AC48), so a sign-in that ends mid-session shows here with no reload.
 *
 * openBackendPicker() (src/lib/storage-notice.tsx) is the only way in; the
 * listener below is the only listener.
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { gisReady, GoogleDriveAdapter, isSyncPending, markSyncPending, preloadGis, SAVE_STATUS_EVENT, savePopupGrant, SYNC_PENDING_EVENT } from '../src/storage';
import { currentRetryDue, currentSaveStatus } from '../src/lib/roadmap-data';
import type { SaveStatus } from '@roadmap/health-core/save-state';
import { googleDriveConfig } from './google-config';
import { adapterFor, connectRefusal, copySessionToDevice, flushBeforeExit, forgetBackend, liftLocalInto, rememberSignIn, storageState, type Backend } from './connect';
import { currentSignIn, lostSignIn, subscribeSignIn, type LostSignIn, type SignIn } from '../src/storage/sign-in-state';
import { dispatch, getSwitchFlow, isCurrentRun, runMove, useSwitchFlow, type Move, type SwitchEvent } from './switch-flow';
import { PROVIDERS } from './providers';
import { BackendPickerModal } from './backend-picker';
import { RemindersControl } from './reminders-control';
import { remindersSupported } from './reminders';
import { openBackendPicker, openSignin, OPEN_PICKER_EVENT, PLAN_STORAGE_CTA, StorageSentence } from '../src/lib/storage-notice';
import { healthWritesAllowed, onHealthWritesChange, ownLogOffHasBegun, safeGetItem, safeSetItem } from '../src/lib/storage';
import { useIsMobile } from '../src/lib/useIsMobile';
import { LOCAL_SAVE_EVENT, localSaveRefused } from '../src/storage/local-storage-adapter';

/** US-09 AC19: the picker was opened once in this browser (a side key, never the record). */
const STORAGE_CTA_SEEN_KEY = 'hr_storage_cta_seen';
/** The same, for this page's life, in case storage throws. */
let storageCtaSeen = false;

/** What a connected record's save is doing: the session's save status (US-09
 *  AC30), whether a retry of a failed save will come, and the store's
 *  pending-sync marker ("still waiting to sync"), set by a failed cloud save or
 *  a failed connect-time lift and cleared by the next successful cloud save.
 *  Each fires its event on every change; no polling. */
interface SaveFacts { status: SaveStatus; pendingSync: boolean; retry: boolean }
const readSaveFacts = (): SaveFacts => ({ status: currentSaveStatus(), pendingSync: isSyncPending(), retry: currentRetryDue() });
function useSaveFacts(backend: Backend): SaveFacts {
  // Read at mount, so the first frame never says a false Synced.
  const [facts, setFacts] = useState<SaveFacts>(() => (backend === 'local' ? { status: 'saved', pendingSync: false, retry: false } : readSaveFacts()));
  useEffect(() => {
    if (backend === 'local') return;
    const check = () => setFacts(readSaveFacts());
    check();
    const events = [SYNC_PENDING_EVENT, SAVE_STATUS_EVENT];
    for (const name of events) window.addEventListener(name, check);
    // A log-off in another tab stops this page's writes, so no retry will come (US-09 AC30); no save event says so.
    const stopWatchingWrites = onHealthWritesChange(check);
    return () => { for (const name of events) window.removeEventListener(name, check); stopWatchingWrites(); };
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

/** US-09 AC2i (lead C31): said while a device page's writes have stopped after another page's log-off.
 *  A cloud page's stop refuses only its device mirror, and its saves reach its cloud while its sign-in
 *  still holds, so it says nothing (lead C32). A page whose own log-off has begun reloads at once. */
const WRITES_STOPPED = 'This page has stopped saving. Reload it to carry on.';
const writesStoppedHere = (): boolean => !healthWritesAllowed() && !ownLogOffHasBegun();

/** US-01 AC5: said while this device refuses the record's saves; US-09 AC2i: or will take none. Beside
 *  the storage button, and on a phone also atop My health and Chat, since the button sits in the Account tab (US-62 AC34). */
export function LocalSaveAlert({ backend }: { backend: Backend }) {
  const localRefused = useLocalSaveRefused(backend);
  const stopped = useSyncExternalStore(onHealthWritesChange, writesStoppedHere, writesStoppedHere);
  if (backend === 'local' && stopped) return <span className="hr-sync-error" role="alert">{WRITES_STOPPED}</span>;
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

/** The page's one sign-in state (US-09 AC48), seeded at boot and raised when a sign-in ends. */
const useSignIn = (): SignIn => useSyncExternalStore(subscribeSignIn, currentSignIn, currentSignIn);

/** US-09 AC48: the bar's words for a Drive or Dropbox sign-in that ended. */
const SIGN_IN_AGAIN = { 'google-drive': 'Sign in to Google again', dropbox: 'Sign in to Dropbox again' } as const;

/** US-09 AC30: the title line's words, from the real storage state (storageState's
 *  three, the session's save status and the device marker), so they never claim
 *  what is not true. A lost sign-in is asked first: it may run on 'local'. */
function storageBarLabel(backend: Backend, lost: LostSignIn | undefined, facts: SaveFacts, problemsOnly: boolean): string {
  // A sign-in that ended re-auths in place; a cloud that did not answer only tries the read again, as the panel says.
  if (lost) return lost.kind === 'signedOut' ? SIGN_IN_AGAIN[lost.provider] : 'Retry';
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

/** US-09 AC30: said instead of starting a popup the browser would block. */
export const GIS_LOADING = 'Google is loading. Tap again.';

/** US-09 AC13: the way back to a provider that could not be read this session,
 *  shared by the plan panel and the top bar so the two cannot drift. Drive
 *  re-auths through the GIS popup FALLBACK (~1 h token), which works even with
 *  the exchange endpoint down and needs this click's user gesture, so it starts
 *  synchronously inside the click; local edits made while signed out merge up
 *  before the reload. Dropbox signs in again by its redirect, and the return
 *  merges them up (US-09 AC48). A cloud that did not answer can only try the
 *  read again. Each reconnect saves the session before its lift (R1). The
 *  reconnects and "Use this browser only" are moves, one at a time with the
 *  picker (US-09 AC45). A reconnect's failure before it saved is said only here; a failed
 *  "Use this browser only", or a reconnect that fails after it saved, ends the
 *  move as a failure, so the picker says it too. */
function useReconnect(lost?: LostSignIn) {
  const flow = useSwitchFlow();
  const [error, setError] = useState<string | null>(null);
  // GIS loads on mount, so the click can open the popup synchronously.
  const driveSignIn = lost?.kind === 'signedOut' && lost.provider === 'google-drive';
  useEffect(() => { if (driveSignIn) preloadGis(); }, [driveSignIn]);
  // runMove claims before its first await, so the move's start stays inside the click.
  const move = (event: SwitchEvent, body: (m: Move) => Promise<void>): void => {
    setError(null);
    void runMove(event, (m) => body(m).catch((e: unknown) => {
      if (!isCurrentRun(m.run)) return; // it was stopped: nothing to say
      const message = e instanceof Error ? e.message : 'Connection failed.';
      setError(message);
      dispatch(event.type === 'reconnect' && getSwitchFlow().kind === 'reconnecting' ? { type: 'cancel', run: m.run } : { type: 'failed', run: m.run, message });
    }));
  };
  const reconnectNow = (): void => {
    if (lost?.kind !== 'signedOut') { location.reload(); return; }
    if (lost.provider === 'dropbox') {
      move({ type: 'start', to: 'dropbox', step: 'list' }, async ({ gen, navigating }) => {
        await flushBeforeExit();
        navigating();
        await adapterFor('dropbox', gen)!.connect(); // its return is kept only under the move's log-off id
      });
      return;
    }
    // Still loading: a popup started now would outlast the click and be blocked.
    if (!gisReady()) { preloadGis(); setError(GIS_LOADING); return; }
    move({ type: 'reconnect' }, async ({ run, gen, navigating }) => {
      const token = await new GoogleDriveAdapter(googleDriveConfig(), gen).acquireViaPopup()
        .catch((error: unknown) => { if (isCurrentRun(run)) connectRefusal(error); throw error; });
      if (!isCurrentRun(run)) return; // a popup answer after the reconnect stopped saves nothing
      if (rememberSignIn(savePopupGrant(token, gen), 'google-drive', gen)) {
        dispatch({ type: 'saved', run }); // from here it runs to the reload: Stop is gone
        markSyncPending();
        await flushBeforeExit();
        await liftLocalInto(new GoogleDriveAdapter(googleDriveConfig(), gen), 'google-drive');
      }
      if (!isCurrentRun(run)) return;
      navigating();
      location.reload();
    });
  };
  return { reconnecting: flow.kind === 'reconnecting' || flow.kind === 'reconnected', idle: flow.kind === 'idle', error, move, reconnectNow };
}

/** US-09 AC30: the title line's storage state. A record that could not be read runs the
 *  panel's own reconnect; a guest's Sign in opens the one picker, which SyncControl hosts
 *  (AC13). A connected record's state is text: the storage card's provider link opens the
 *  picker. On a phone (US-62 AC34) Account draws no Sign in here, since the storage card's
 *  button is the one sign-in, and `problemsOnly` draws the bar atop My health only while a
 *  reconnect or a change not synced needs saying: never for a save that runs, which would
 *  flash on every edit burst, unless the marker is set: then "Not synced yet." (owner, 2026-11-12). */
export function StorageBar({ backend, problemsOnly = false }: { backend: Backend; problemsOnly?: boolean }) {
  const facts = useSaveFacts(backend);
  const isMobile = useIsMobile();
  const reconnect = lostSignIn(useSignIn());
  const { reconnecting, idle, error, reconnectNow } = useReconnect(reconnect);
  const label = storageBarLabel(backend, reconnect, facts, problemsOnly);
  if (problemsOnly && !reconnect && label !== NOT_SYNCED_ON_DEVICE && label !== NOT_SYNCED) return null;
  return (
    <>
      {reconnect || (backend === 'local' && !isMobile) ? (
        <button
          type="button"
          className="action-btn-small"
          aria-haspopup={reconnect ? undefined : 'dialog'}
          disabled={!!reconnect && !idle}
          onClick={reconnect ? reconnectNow : () => openSignin('top_bar')}
        >
          {reconnecting ? 'Reconnecting…' : label}
        </button>
      ) : backend !== 'local' && <span className="hr-storage-state">{label}</span>}
      {error && <span className="hr-sync-error" role="alert">{error}</span>}
      {/* US-01 AC5: beside where the record lives; atop My health and Chat, a phone's saveAlert says it. */}
      {!problemsOnly && <LocalSaveAlert backend={backend} />}
    </>
  );
}

export function SyncControl({ backend, hasData = true, attention = false }: {
  backend: Backend;
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
  const signIn = useSignIn();
  const reconnect = lostSignIn(signIn);
  const { reconnecting, idle, error, move, reconnectNow } = useReconnect(reconnect);
  const writesAllowed = useSyncExternalStore(onHealthWritesChange, healthWritesAllowed);

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

  // Forget the unreachable connection: the session is saved, then this page's record is
  // copied onto the device copy (US-09 AC48, Codex R1); the cloud file stays put. A move (AC45).
  const forgetProvider = (provider: LostSignIn['provider']): void =>
    move({ type: 'start', to: 'local', step: 'list' }, async () => {
      await flushBeforeExit();
      await copySessionToDevice(provider);
      await adapterFor(provider)?.disconnect();
      forgetBackend();
      location.reload();
    });

  const state = storageState(backend, signIn);
  const provider = backend === 'local' ? '' : PROVIDERS[backend].label;
  let content: React.ReactNode;
  if (reconnect) {
    // The remembered provider could not be read this session (US-09 AC13). Name
    // it and offer the way back — never the guest "choose where to save" pitch:
    // this user HAS chosen, and their record is sitting in that provider. A Drive
    // or Dropbox sign-in that ended gets a new sign-in (Dropbox in Drive's words,
    // the name swapped: Brad, US-09 AC48); a cloud that did not answer can only
    // try the read again.
    const label = PROVIDERS[reconnect.provider].label;
    const signedOut = reconnect.kind === 'signedOut';
    content = (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">{label} {signedOut ? 'is signed out' : 'could not be reached'}</span>
        <button
          className="hr-sync-btn"
          disabled={!idle}
          onClick={reconnectNow}
        >
          {signedOut ? (reconnecting ? 'Reconnecting…' : `Reconnect ${label}`) : 'Retry'}
        </button>
        <span className="hr-sync-detail">
          Your record is safe in your {label}.
          {/* A page whose device writes are refused keeps nothing in this browser. */}
          {signedOut && ' Sign in again to keep it in step.'}
          {writesAllowed && (signedOut
            ? ' Anything you change meanwhile is kept in this browser and merges when you reconnect.'
            : ` Anything you change now is kept in this browser and merges as soon as ${label} answers again.`)}
        </span>
        <div className="hr-sync-more">
          <button type="button" className="hr-sync-link" disabled={!idle} onClick={() => forgetProvider(reconnect.provider)}>Use this browser only</button>
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
            {/* Only while a retry will come: never after a refused sign-in (US-09 AC30). */}
            {facts.retry && ' It will upload automatically.'} Your data is safe in this browser meanwhile.
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
      {pickerOpen && <BackendPickerModal current={reconnect?.provider ?? backend} unreachable={!!reconnect} onClose={() => setPickerOpen(false)} />}
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
