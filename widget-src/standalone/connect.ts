/**
 * Shared connect helpers + the Backend type for the standalone build. Lifting
 * on-device data into a freshly-connected cloud (migrateLocalInto) is needed by
 * BOTH the Dropbox OAuth return (app.tsx) and the in-page form connects
 * (sync-control.tsx), so it lives here to avoid a circular import between those
 * two modules.
 */
import { useState } from 'react';
import { isStorageFailure } from '@roadmap/health-core';
import {
  DropboxAdapter,
  DriveGrantRefusedError,
  GoogleDriveAdapter,
  GitHubAdapter,
  WebDavAdapter,
  LocalStorageAdapter,
  copyCloudDownToDevice,
  localUnsyncedSince,
  markSyncPending,
  syncPendingSince,
  ROADMAP_FILE_NAME,
  saveRoadmapFileInto,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { clearAutoEnrolBlock } from './reminders';
import { googleDriveConfig } from './google-config';
import { clearLocalStorage } from '../src/lib/storage';
import { recordFailure } from '../src/lib/error-diagnostics';
import { trackProductEvent } from '../src/lib/server-api';
import { Sentry } from '../src/lib/sentry';

/** Which backend the app is currently using (a UI-level subset of StorageBackendId). */
export type Backend = 'dropbox' | 'google-drive' | 'github' | 'self-host' | 'local';

export const BACKEND_KEY = 'health_roadmap_backend';

export interface ResolvedBackend {
  adapter: StorageAdapter;
  backend: Backend;
  /** The remembered cloud is unusable this session (token gone, or the provider
   * refused the record): the session runs on-device and the UI names this
   * provider, so the user is never shown the guest "choose where to save"
   * pitch for a record they have already placed (US-09 AC13). */
  reconnect?: Exclude<Backend, 'local'>;
}

/** A Google grant refused at connect (US-09 AC15) is the user's move, not a
 *  defect: counted here, once, wherever it is caught, and never sent to
 *  Sentry. The message is what to show; null for any other error. */
export function connectRefusal(error: unknown): string | null {
  if (!(error instanceof DriveGrantRefusedError)) return null;
  trackProductEvent('cloud_connect_refused', { provider: 'google-drive' });
  return error.message;
}

/** The on-device session a cloud backend falls back to. The marker records
 *  WHEN, so the next good cloud session merges this session's edits up even
 *  against an erased cloud file (US-09 AC13), whether the user clicks Reconnect
 *  or the next load simply succeeds. */
export function onDeviceFallback(backend: Exclude<Backend, 'local'>): ResolvedBackend {
  markSyncPending();
  return { adapter: new LocalStorageAdapter(), backend: 'local', reconnect: backend };
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
  init: (adapter: StorageAdapter) => Promise<void>,
): Promise<ResolvedBackend> {
  try {
    await init(resolved.adapter);
    return resolved;
  } catch (error) {
    if (resolved.backend === 'local' || !isStorageFailure(error)) throw error;
    const failure = recordFailure(error, 'Cloud record could not be loaded');
    console.warn(failure.message);
    Sentry.captureException(failure, { tags: { area: 'cloud-sync', op: 'load', backend: resolved.backend } });
    const fallback = onDeviceFallback(resolved.backend);
    await init(fallback.adapter);
    return fallback;
  }
}

/** Which storage state the UI is in. Defined once so app.tsx (the storage-notice
 *  gate) and sync-control.tsx (the branch it renders) cannot disagree about what
 *  "guest, no provider" means. */
export type StorageState = 'reconnect' | 'cloud' | 'guest';

export function storageState(backend: Backend, reconnect?: Exclude<Backend, 'local'>): StorageState {
  if (reconnect) return 'reconnect';
  return backend === 'local' ? 'guest' : 'cloud';
}

/** Human-readable provider names. Shared by the sync status line and the
 *  backend picker's log-off copy so the two surfaces never drift. */
export const PROVIDER_LABELS: Record<Exclude<Backend, 'local'>, string> = {
  dropbox: 'Dropbox',
  'google-drive': 'Google Drive',
  github: 'GitHub',
  'self-host': 'your own server',
};

/**
 * Lift existing on-device data into a freshly-connected cloud (first connect).
 * A corrupt local file is skipped (unrecoverable anyway — never blocks the
 * connect); a CLOUD save failure propagates. App code calls the policy wrapper
 * `liftLocalInto` below; this throwing core stays exported for tests.
 */
export async function migrateLocalInto(adapter: StorageAdapter): Promise<void> {
  let body: unknown;
  try {
    ({ body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME));
  } catch (error) {
    console.warn('On-device data unreadable — connecting without the lift', error);
    return;
  }
  if (body == null) return;
  // saveRoadmapFileInto merges with whatever is already in the cloud. The
  // pending marker's timestamp travels with it: an erased cloud file wins the
  // merge wholesale, and without it this device's fallback edits would go with
  // the rest (US-09 AC13).
  await saveRoadmapFileInto(adapter, body, syncPendingSince() ?? undefined);
}

/**
 * The ONE lift policy, applied by every connect flow (OAuth return, form
 * connect, Drive reconnect): a connect succeeds or fails on the connect
 * itself — the guest-data lift never blocks it and never mislabels it as
 * "connection failed". A failed lift MUST still be observable (a silent lift
 * failure is exactly how the US-09 AC3 no-op shipped): Sentry + console, plus
 * the pending-mirror marker — RoadmapStore.create() (which runs right after)
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
    console.warn('Guest-data lift on connect failed', error);
    // Nothing on this device has reached the cloud, so it is unsynced from its
    // OLDEST row: marking from "now" would let the next merge drop everything
    // the user typed before this connect (US-09 AC13).
    markSyncPending(await localUnsyncedSince());
    Sentry.captureException(error, { tags: { area: 'cloud-connect', op: 'migrate-up', backend } });
  }
}

/**
 * Form-based connect (GitHub, self-host): validate the pasted credentials via
 * adapter.connect() (throws on failure — the caller surfaces the message), lift
 * on-device data up, remember the choice, then reload so app.tsx re-initialises
 * on the new backend. Dropbox/Google use an OAuth redirect instead (handled in
 * app.tsx on return), so they don't go through here.
 */
export async function finishFormConnect(adapter: StorageAdapter, backend: Backend): Promise<void> {
  await adapter.connect();
  await liftLocalInto(adapter, backend);
  localStorage.setItem(BACKEND_KEY, backend);
  trackProductEvent('cloud_connect_success', { provider: backend === 'self-host' ? 'webdav' : backend });
  location.reload();
}

/**
 * Shared busy/error scaffold for connect-flow buttons (picker + sync control).
 * Success is expected to end in a navigation or reload, so busy stays true.
 */
export function useBusyRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** The adapter for a connected cloud backend (null for the on-device tier). */
export function adapterFor(backend: Backend): StorageAdapter | null {
  switch (backend) {
    case 'dropbox':
      return new DropboxAdapter(dropboxConfig());
    case 'google-drive':
      return new GoogleDriveAdapter(googleDriveConfig());
    case 'github':
      return new GitHubAdapter();
    case 'self-host':
      return new WebDavAdapter();
    default:
      return null;
  }
}

/**
 * Log off this device: sign out of the active cloud and wipe the on-device
 * copy so the next person on a SHARED computer sees nothing. This NEVER deletes
 * the user's cloud file — reconnecting the SAME account restores everything.
 *
 * What it clears:
 *  - the active provider's auth tokens/credentials (adapter.disconnect() —
 *    each adapter only does safeRemoveItem on its OWN local token/config keys,
 *    no network delete is issued against the remote file)
 *  - the local RoadmapFile cache (health_roadmap_file_v2 + _rev), any named
 *    record files (chat-history.json, …) and stored documents
 *    (LocalStorageAdapter.disconnect())
 *  - the legacy v1 health blob + the authenticated flag (clearLocalStorage())
 *  - the remembered-backend selection (BACKEND_KEY)
 *
 * The page then reloads; resolveBackend() finds no remembered backend and no
 * local data, so the widget returns to the connect/onboarding screen. The
 * reload also discards all in-memory store state.
 */
export async function logOff(backend: Backend): Promise<void> {
  // Sign out of the active cloud (drops its tokens locally; the remote file is
  // left untouched — adapter.disconnect() issues no remote delete).
  try {
    await adapterFor(backend)?.disconnect();
  } catch (error) {
    console.warn('Cloud disconnect during log-off failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'log-off', backend } });
  }
  // Wipe the on-device copy (RoadmapFile + version + named files + documents).
  await new LocalStorageAdapter().disconnect();
  // Also clear the legacy v1 health blob + the authenticated flag (the shared
  // HealthTool source still writes these), so a shared device leaks nothing.
  clearLocalStorage();
  localStorage.removeItem(BACKEND_KEY);
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
  if (current === 'local') return;
  const adapter = adapterFor(current);
  if (!adapter) return;
  try {
    await copyDownFrom(adapter);
  } catch (error) {
    console.warn('Copy-down before switch failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'copy-down', backend: current } });
    throw new Error(
      `${PROVIDER_LABELS[current]} could not be reached, so your record there could not be copied to this browser. Try again once it answers.`,
    );
  }
  await adapter.disconnect();
}

/** The adapter-level copy-down (exported for tests; policy/catch stays above).
 *  The pending marker rides along: an erased cloud file wins the epoch gate, so
 *  without it this would wipe the rows a fallback session is still holding. */
export async function copyDownFrom(adapter: StorageAdapter): Promise<void> {
  const { body } = await adapter.read(ROADMAP_FILE_NAME);
  if (body == null) return;
  await copyCloudDownToDevice(body, syncPendingSince() ?? undefined);
}
