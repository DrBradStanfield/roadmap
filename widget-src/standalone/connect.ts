/**
 * Shared connect helpers + the Backend type for the standalone build. Lifting
 * on-device data into a freshly-connected cloud (migrateLocalInto) is needed by
 * BOTH the Dropbox OAuth return (app.tsx) and the in-page form connects
 * (sync-control.tsx), so it lives here to avoid a circular import between those
 * two modules.
 */
import { migrateFile } from '@roadmap/health-core';
import {
  DropboxAdapter,
  GoogleDriveAdapter,
  GitHubAdapter,
  WebDavAdapter,
  LocalStorageAdapter,
  SyncManager,
  getDeviceId,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';

/** Which backend the app is currently using (a UI-level subset of StorageBackendId). */
export type Backend = 'dropbox' | 'google-drive' | 'github' | 'self-host' | 'local';

export const BACKEND_KEY = 'health_roadmap_backend';

/** Lift existing on-device data into a freshly-connected cloud (first connect). */
export async function migrateLocalInto(adapter: StorageAdapter): Promise<void> {
  const { file } = await new LocalStorageAdapter().read();
  if (!file) return;
  const deviceId = getDeviceId();
  // SyncManager.save merges the local file with whatever is already in the cloud.
  await new SyncManager(adapter, deviceId).save(
    migrateFile(file, { deviceId, now: new Date().toISOString() }),
  );
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
  await migrateLocalInto(adapter);
  localStorage.setItem(BACKEND_KEY, backend);
  location.reload();
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
 * Copy the connected cloud's latest data down to this device (merged), so a
 * disconnect or backend switch never appears to lose anything. Best-effort:
 * the cloud file itself is never touched.
 */
export async function copyDownToDevice(backend: Backend): Promise<void> {
  const adapter = adapterFor(backend);
  if (!adapter) return;
  try {
    const { file } = await adapter.read();
    if (file) await new SyncManager(new LocalStorageAdapter(), getDeviceId()).save(file);
  } catch (error) {
    console.warn('Copy-down before switch failed', error);
  }
}
