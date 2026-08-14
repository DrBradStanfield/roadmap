/**
 * Shared connect helpers + the Backend type for the standalone build. Lifting
 * on-device data into a freshly-connected cloud (migrateLocalInto) is needed by
 * BOTH the Dropbox OAuth return (app.tsx) and the in-page form connects
 * (sync-control.tsx), so it lives here to avoid a circular import between those
 * two modules.
 */
import { useState } from 'react';
import {
  DropboxAdapter,
  GoogleDriveAdapter,
  GitHubAdapter,
  WebDavAdapter,
  LocalStorageAdapter,
  ROADMAP_FILE_NAME,
  saveRoadmapFileInto,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import { clearLocalStorage } from '../src/lib/storage';
import { trackProductEvent } from '../src/lib/api';
import { Sentry } from '../src/lib/sentry';

/** Which backend the app is currently using (a UI-level subset of StorageBackendId). */
export type Backend = 'dropbox' | 'google-drive' | 'github' | 'self-host' | 'local';

export const BACKEND_KEY = 'health_roadmap_backend';

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
  // saveRoadmapFileInto merges with whatever is already in the cloud.
  await saveRoadmapFileInto(adapter, body);
}

/**
 * The ONE lift policy, applied by every connect flow (OAuth return, form
 * connect, Drive reconnect): a connect succeeds or fails on the connect
 * itself — the guest-data lift never blocks it and never mislabels it as
 * "connection failed". A failed lift MUST still be observable (a silent lift
 * failure is exactly how the US-09 AC3 no-op shipped): Sentry + console. The
 * on-device copy stays put — nothing is destroyed — but remains device-only,
 * invisible to the cloud session, until a LATER connect or backend switch
 * re-runs the lift (the remembered-choice resume path never lifts).
 */
export async function liftLocalInto(adapter: StorageAdapter, backend: Backend): Promise<void> {
  try {
    await migrateLocalInto(adapter);
  } catch (error) {
    console.warn('Guest-data lift on connect failed', error);
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
 * Copy the connected cloud's latest data down to this device (merged), so a
 * disconnect or backend switch never appears to lose anything. Best-effort:
 * the cloud file itself is never touched.
 */
export async function copyDownToDevice(backend: Backend): Promise<void> {
  const adapter = adapterFor(backend);
  if (!adapter) return;
  try {
    await copyDownFrom(adapter);
  } catch (error) {
    console.warn('Copy-down before switch failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'copy-down', backend } });
  }
}

/** The adapter-level copy-down (exported for tests; policy/catch stays above). */
export async function copyDownFrom(adapter: StorageAdapter): Promise<void> {
  const { body } = await adapter.read(ROADMAP_FILE_NAME);
  if (body == null) return;
  await saveRoadmapFileInto(new LocalStorageAdapter(), body);
}
