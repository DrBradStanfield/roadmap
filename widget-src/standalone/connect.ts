/**
 * Shared connect helpers + the Backend type for the standalone build. Lifting
 * on-device data into a freshly-connected cloud (migrateLocalInto) is needed by
 * BOTH the Dropbox OAuth return (app.tsx) and the in-page form connects
 * (sync-control.tsx), so it lives here to avoid a circular import between those
 * two modules.
 */
import { copyCloudDown, liftDeviceCopy } from '@roadmap/health-core/record-transfer';
import { isStorageFailure } from '@roadmap/health-core/sync-manager';
import {
  DriveGrantRefusedError,
  GoogleDriveAdapter,
  LocalStorageAdapter,
  markSyncPending,
  signalLogOff,
  StorageError,
  type GitHubAdapter,
  type StorageAdapter,
  type WebDavAdapter,
} from '../src/storage';
import { beginRoadmapLogOff } from '../src/storage/roadmap-store';
import { currentSignIn, lostSignIn, type LostSignIn, type SignIn } from '../src/storage/sign-in-state';
import { BACKEND_KEY, webRecordHost } from '../src/storage/web-record-host';
import { clearAutoEnrolBlock } from './reminders';
import { PROVIDERS, SIGN_IN_KEYS, providerOf, type CloudBackend } from './providers';
import { clearLocalStorage, clearOffFileHealthData, safeGetItem, safeRemoveItem, setSignIn, type LogOffId } from '../src/lib/storage';
import { CLEARED_ERASE_KEY } from '../src/lib/cleared-erase';
import { failureTags, recordFailure } from '../src/lib/error-diagnostics';
import { trackProductEvent } from '../src/lib/server-api';
import { copyRecordToDevice, flushRoadmapStore } from '../src/lib/roadmap-data';
import { Sentry } from '../src/lib/sentry';

/** Which backend the app is currently using (a UI-level subset of StorageBackendId). */
export type Backend = 'dropbox' | 'google-drive' | 'github' | 'self-host' | 'local';

// Kept beside the web host, which reads it too (US-06 AC13).
export { BACKEND_KEY };

export interface ResolvedBackend {
  adapter: StorageAdapter;
  backend: Backend;
  /** The remembered cloud is unusable this session (token gone, or the provider
   * refused the record): the session runs on-device and the UI names this
   * provider, so the user is never shown the guest "choose where to save"
   * pitch for a record they have already placed (US-09 AC13). Boot seeds the
   * page's sign-in state with it (US-09 AC48); the UI reads only that state. */
  reconnect?: LostSignIn;
}

/** The sign-in state a load ends in (US-09 AC48), for boot to seed once. */
export function signInAtBoot({ backend, reconnect }: ResolvedBackend): SignIn {
  return reconnect ?? (backend === 'local' ? { kind: 'none' } : { kind: 'signedIn', provider: backend });
}

/** Why the remembered cloud is unusable at load (US-09 AC48). Google Drive's panel always offers its
 *  sign-in, as before; Dropbox's only when Dropbox refused the sign-in or its token, named by the error
 *  itself (a 401, or a sign-in only a new one mends). Any other failure, and every GitHub and WebDAV one,
 *  is retried by a reload (AC13). */
function lostAtLoad(provider: CloudBackend, error?: unknown): LostSignIn {
  const refused = error instanceof StorageError && (error.status === 401 || error.reason === 'reconnect');
  if (provider === 'google-drive' || (provider === 'dropbox' && refused)) return { kind: 'signedOut', provider };
  return { kind: 'unreachable', provider };
}

/** A Google grant refused at connect (US-09 AC15) is the user's move, not a
 *  defect: counted here, once, wherever it is caught, and never sent to
 *  Sentry. The message is what to show; null for any other error. */
export function connectRefusal(error: unknown): string | null {
  if (!(error instanceof DriveGrantRefusedError)) return null;
  trackProductEvent('cloud_connect_refused', { provider: 'google-drive' });
  return error.message;
}

/** The on-device session a cloud backend falls back to. The marker makes the
 *  next good cloud session merge this session's edits up (US-09 AC13), whether
 *  the user clicks Reconnect or the next load simply succeeds; against an
 *  erased cloud file they survive because no erase listed them (AC23). */
function onDeviceFallback(reconnect: LostSignIn): ResolvedBackend {
  markSyncPending();
  return { adapter: new LocalStorageAdapter(), backend: 'local', reconnect };
}

/**
 * Start the data layer on the resolved backend. A cloud record that cannot be
 * read at load — a token the provider now refuses (a Drive grant without the
 * `drive.file` scope, Sentry JAVASCRIPT-REMIX-6G), a dead network, a body the
 * app cannot parse — runs the session on-device instead of leaving the mount
 * empty (US-09 AC13). Anything else is a defect and still throws.
 */
export async function startOnBackend(
  resolved: ResolvedBackend,
  init: (adapter: StorageAdapter, cloudUnreachable: boolean) => Promise<void>,
): Promise<ResolvedBackend> {
  try {
    await init(resolved.adapter, resolved.reconnect !== undefined);
    return resolved;
  } catch (error) {
    if (resolved.backend === 'local' || !isStorageFailure(error)) throw error;
    const failure = recordFailure(error, 'Cloud record could not be loaded');
    console.warn(failure.message);
    Sentry.captureException(failure, { tags: { area: 'cloud-sync', op: 'load', backend: resolved.backend } });
    const fallback = onDeviceFallback(lostAtLoad(resolved.backend, error));
    await init(fallback.adapter, true);
    return fallback;
  }
}

/** Which storage state the UI is in. Defined once so app.tsx (the storage-notice
 *  gate) and sync-control.tsx (the branch it renders) cannot disagree about what
 *  "guest, no provider" means. */
export type StorageState = 'reconnect' | 'cloud' | 'guest';

export function storageState(backend: Backend, signIn: SignIn = currentSignIn()): StorageState {
  if (lostSignIn(signIn)) return 'reconnect';
  return backend === 'local' ? 'guest' : 'cloud';
}

/**
 * Lift existing on-device data into a freshly-connected cloud (first connect),
 * by health-core's lift (record-transfer.ts): a plain merge, so against an
 * erased cloud file this device's rows survive because no erase listed them
 * (US-09 AC23). A corrupt local file is skipped (unrecoverable anyway — never
 * blocks the connect); a CLOUD save failure marks the device copy pending and
 * propagates. App code calls the policy wrapper `liftLocalInto` below; this
 * throwing core stays exported for tests.
 */
export async function migrateLocalInto(adapter: StorageAdapter): Promise<void> {
  const host = webRecordHost(adapter);
  if (host.tier !== 'cloud') return;
  if ((await liftDeviceCopy(host)) === 'unreadable') console.warn('On-device data unreadable — connecting without the lift');
}

/**
 * The ONE lift policy, applied by every connect flow (OAuth return, form
 * connect, Drive reconnect): a connect succeeds or fails on the connect
 * itself — the guest-data lift never blocks it and never mislabels it as
 * "connection failed". A failed lift MUST still be observable (a silent lift
 * failure is exactly how the US-09 AC3 no-op shipped): Sentry + console, plus
 * the pending-mirror marker the lift sets — RoadmapStore.create() (which runs right after)
 * and every later session then merge the on-device copy up automatically, and
 * the sync control shows "still waiting to sync" until the marker clears.
 */
export async function liftLocalInto(adapter: StorageAdapter, backend: Backend): Promise<void> {
  // Every fresh connect (form, Dropbox/Drive redirect, Drive popup) passes
  // here: a new credential may be able to name an email where the old one
  // could not, so the reminders "no email available" block is lifted.
  clearAutoEnrolBlock();
  try {
    await migrateLocalInto(adapter);
  } catch (error) {
    console.warn('Guest-data lift on connect failed');
    Sentry.captureException(recordFailure(error, 'Cloud sync failed'), {
      tags: { area: 'cloud-sync', op: 'migrate-up', backend, ...failureTags(error) },
    });
  }
}

/** An OAuth return whose code exchange failed (US-09 AC6c): a fixed console
 *  line and the strict envelope with closed-list tags. The provider's reply
 *  can echo what was sent, so neither its text nor the error goes out. The
 *  return value is the fixed line the page shows (US-09 AC1a): before, the
 *  page opened as if nothing had been tried. */
export function reportConnectFailure(error: unknown, backend: 'dropbox' | 'google-drive'): string {
  console.warn(`${PROVIDERS[backend].label} connect failed`);
  Sentry.captureException(recordFailure(error, 'Cloud connect failed'), {
    tags: { area: 'cloud-connect', backend, ...failureTags(error) },
  });
  return `${PROVIDERS[backend].label} did not connect, so nothing changed. Please try again.`;
}

/**
 * Form-based connect (GitHub, self-host): validate the pasted credentials via
 * adapter.connect() (throws on failure — the caller surfaces the message), remember
 * the choice, lift on-device data up, then reload so app.tsx re-initialises
 * on the new backend. Dropbox/Google use an OAuth redirect instead (handled in
 * resolve-backend.ts on return), so they don't go through here. `gen` is the
 * log-off id the move began under; the adapter was built with it too.
 */
export async function finishFormConnect(adapter: GitHubAdapter | WebDavAdapter, backend: CloudBackend, gen: LogOffId): Promise<void> {
  if (rememberSignIn(await adapter.signIn(), backend, gen)) {
    markSyncPending();
    await liftLocalInto(adapter, backend);
    trackProductEvent('cloud_connect_success', { provider: PROVIDERS[backend].event });
  }
  location.reload();
}

/** Remember `backend` when the connecting adapter `saved` its own sign-in,
 *  and only while `gen` is still the current log-off id (US-09 AC45). True when both hold:
 *  only then is the device copy lifted into the cloud, marked pending first
 *  so a page that stops mid-lift lifts it on the next load. */
export function rememberSignIn(saved: boolean, backend: CloudBackend, gen: LogOffId): boolean {
  return saved && rememberBackend(backend, gen);
}

/** The adapter for a connected cloud backend (null for the on-device tier);
 *  `gen` as in Provider.adapter. */
export function adapterFor(backend: Backend, gen?: LogOffId): StorageAdapter | null {
  return providerOf(backend)?.adapter(gen) ?? null;
}

/** The remembered choice, from a browser that may block storage: a blocked
 *  read is "nothing remembered", a blocked write is dropped (US-09 AC16). */
export function rememberedBackend(): Backend | null {
  return safeGetItem(BACKEND_KEY) as Backend | null;
}
/** Saved only while `gen` is the current log-off id (US-09 AC45); true when saved. */
export function rememberBackend(backend: Backend, gen: LogOffId): boolean {
  return setSignIn(BACKEND_KEY, backend, gen);
}
export function forgetBackend(): void {
  safeRemoveItem(BACKEND_KEY);
}

/** The remembered choice, or the on-device tier. The credential/token lives
 *  in each adapter's own storage, so a bare `new Adapter()` reconnects if it's
 *  still there. Never rejects on a browser that blocks storage: `main()`
 *  awaits this before the mount is rendered, so a throw here is a blank
 *  widget (Sentry JAVASCRIPT-REMIX-6T / 6N / 6J, US-09 AC16). */
export async function resolveRemembered(): Promise<ResolvedBackend> {
  const remembered = rememberedBackend();
  const adapter = remembered ? adapterFor(remembered) : null;
  if (remembered && adapter?.isConnected()) {
    if (!(adapter instanceof GoogleDriveAdapter)) return { adapter, backend: remembered };
    // Valid cached token, or a silent refresh through the stateless endpoint
    // (a fetch — fine at page load, unlike a popup).
    if (adapter.hasValidToken() || (await adapter.tryServerRefresh())) {
      return { adapter, backend: 'google-drive' };
    }
    // Endpoint unreachable or refresh token revoked. A popup can't open at
    // page load: run on-device, offer Reconnect, KEEP the remembered choice.
    return onDeviceFallback({ kind: 'signedOut', provider: 'google-drive' });
  }
  if (remembered) forgetBackend(); // creds gone → fall back, will re-prompt

  return { adapter: new LocalStorageAdapter(), backend: 'local' };
}

/**
 * Log off this device: sign out of the active cloud and wipe the on-device
 * copy so the next person on a SHARED computer sees nothing. This NEVER deletes
 * the user's cloud file — reconnecting the SAME account restores everything.
 *
 * What it clears:
 *  - the active provider's auth tokens/credentials (adapter.disconnect() —
 *    each adapter only does safeRemoveItem on its OWN local token/config keys,
 *    no network delete is issued against the remote file), then every other
 *    provider's sign-in entries (SIGN_IN_KEYS)
 *  - the local RoadmapFile cache (health_roadmap_file_v2 + _rev), any named
 *    record files (chat-history.json, …) and stored documents
 *    (LocalStorageAdapter.disconnect())
 *  - off-file health data: matrix drafts and Lp(a) kept answers
 *    (clearOffFileHealthData(); documents are already cleared above)
 *  - the legacy v1 health blob + the authenticated flag (clearLocalStorage())
 *  - the remembered-backend selection (BACKEND_KEY)
 *
 * The page then reloads; resolveBackend() finds no remembered backend and no
 * local data, so the widget returns to the connect/onboarding screen. The
 * reload also discards all in-memory store state.
 */
export async function logOff(backend: Backend): Promise<void> {
  // Close the local-write barrier BEFORE any await: disconnect, an in-flight
  // failed save, and the navigation lifecycle can all race the device wipe.
  beginRoadmapLogOff();
  // Sign out of the active cloud (drops its tokens locally; the remote file is
  // left untouched — adapter.disconnect() issues no remote delete).
  try {
    await adapterFor(backend)?.disconnect();
  } catch (error) {
    console.warn('Cloud disconnect during log-off failed');
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'log-off', backend } });
  }
  // Every provider's sign-in on this device (US-09 AC45).
  for (const key of SIGN_IN_KEYS) safeRemoveItem(key);
  // Wipe the on-device copy (RoadmapFile + version + named files + documents).
  // Only its content-free erase-fence write can throw, after the health keys
  // are gone; log-off still finishes (US-09 AC2c).
  try {
    await new LocalStorageAdapter().disconnect();
  } catch (error) {
    console.warn('Device wipe during log-off failed');
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'log-off-device', backend: 'local' } });
  }
  // Also clear the legacy v1 health blob + the authenticated flag (the shared
  // HealthTool source still writes these), so a shared device leaks nothing.
  clearLocalStorage();
  clearOffFileHealthData();
  safeRemoveItem(CLEARED_ERASE_KEY); // the next sign-in's record adopts its own erase (US-11 AC6)
  forgetBackend();
  // Again, now the wipe has freed space for it (Codex re-check R1).
  signalLogOff();
  location.reload();
}

/**
 * Leaving a connected cloud (the picker's switch): copy its data down to this
 * device first, then drop its tokens. A cloud that cannot be READ stops the
 * switch — otherwise the record is left in a provider nothing points at any
 * more while this browser holds none of it (US-09 AC13: the provider is
 * unreachable exactly when the user is most tempted to pick another one). The
 * cloud file itself is never touched.
 */
export async function prepareSwitch(current: Backend): Promise<void> {
  await flushBeforeExit(); // a guest's too: its connect lifts the device copy (US-09 AC48, owner order 1)
  if (current === 'local') return;
  const adapter = adapterFor(current);
  if (!adapter) return;
  try {
    await copyDownOnce(adapter, current);
    // The page's live adapter keeps its token in memory, so after a failed
    // connect it went on saving to the old cloud; its record holds those
    // saves, and any still waiting (US-09 AC2g).
    await copyRecordToDevice();
  } catch (error) {
    console.warn('Copy-down before switch failed');
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'copy-down', backend: current } });
    throw new Error(
      `${PROVIDERS[current].label} could not be reached, so your record there could not be copied to this browser. Try again once it answers.`,
    );
  }
  await adapter.disconnect();
  preparedFrom = current;
}

/** Every exit from the reconnect panel saves the session before it lifts or leaves (US-09 AC48, R1): an
 *  edit still on the save debounce reaches this device's copy, which the lift or the next load reads. The
 *  page's departure save stays as the second line. A save that fails has put the session on the device
 *  copy (US-09 AC4), so its failure does not stop the exit. */
export async function flushBeforeExit(): Promise<void> {
  await flushRoadmapStore().catch(() => undefined);
}

/** "Use this browser only" from a cloud page copies its record to this device before it signs out, a clean
 *  session's too: a cloud session keeps no device copy until a save fails (US-09 AC48, Codex R1). A copy this
 *  browser refuses is reported and stops the exit with a wordless error, so the panel stays as it was. */
export async function copySessionToDevice(provider: CloudBackend): Promise<void> {
  try {
    await copyRecordToDevice();
  } catch (error) {
    console.warn('Copy to this browser before leaving the cloud failed');
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'copy-to-device', backend: provider } });
    throw new Error('');
  }
}

/** The cloud this page has already copied down and signed out of. A switch
 *  that works leaves the page (a redirect or a reload), so a second switch on
 *  the same page means the new connect failed and the user is trying again:
 *  the old tokens are gone, so the copy-down is not run again against a cloud
 *  it can no longer read. What the page saved since comes down from its own
 *  record instead (copyRecordToDevice), and the tokens are dropped again, a
 *  backstop to AC2f in case they were written back (US-09 AC2g). */
let preparedFrom: Backend | null = null;

async function copyDownOnce(adapter: StorageAdapter, current: Backend): Promise<void> {
  if (preparedFrom === current) return;
  await copyDownFrom(adapter);
}

/** The adapter-level copy-down (exported for tests; policy/catch stays above). */
export async function copyDownFrom(adapter: StorageAdapter): Promise<void> {
  const host = webRecordHost(adapter);
  if (host.tier === 'cloud') await copyCloudDown(host);
}
