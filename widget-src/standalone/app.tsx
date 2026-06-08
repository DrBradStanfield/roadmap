/**
 * Standalone (GitHub Pages / self-host) entry for the full Health Roadmap app.
 *
 * Same React tree as the Shopify widget, but the data layer is local-first: the
 * Vite redirect (vite.config.standalone.ts) points the app's `lib/api` imports
 * at the RoadmapStore shim. This entry resolves which backend to use (remembered
 * choice, or a returning Dropbox OAuth redirect, else the on-device tier),
 * initialises the store, and renders the connect-a-cloud control above the app.
 */
import '../src/styles.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { migrateFile } from '@roadmap/health-core';
import { HealthTool } from '../src/components/HealthTool';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initSentry } from '../src/lib/sentry';
import { initRoadmapStore, flushRoadmapStoreSync } from '../src/lib/roadmap-data';
import {
  DropboxAdapter,
  getDeviceId,
  LocalStorageAdapter,
  SyncManager,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { SyncControl, BACKEND_KEY, type Backend } from './sync-control';

/** Lift existing on-device data into a freshly-connected cloud (first connect). */
async function migrateLocalInto(adapter: StorageAdapter): Promise<void> {
  const { file } = await new LocalStorageAdapter().read();
  if (!file) return;
  const deviceId = getDeviceId();
  // SyncManager.save merges the local file with whatever is already in the cloud.
  await new SyncManager(adapter, deviceId).save(migrateFile(file, { deviceId, now: new Date().toISOString() }));
}

async function resolveBackend(): Promise<{ adapter: StorageAdapter; backend: Backend }> {
  // Returning from a Dropbox OAuth redirect?
  let resumed: DropboxAdapter | null = null;
  try {
    resumed = await DropboxAdapter.completeRedirect(dropboxConfig());
  } catch (error) {
    console.warn('Dropbox connect failed', error);
  }
  if (resumed) {
    await migrateLocalInto(resumed);
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    return { adapter: resumed, backend: 'dropbox' };
  }
  // Remembered choice.
  if (localStorage.getItem(BACKEND_KEY) === 'dropbox') {
    const dbx = new DropboxAdapter(dropboxConfig());
    if (dbx.isConnected()) return { adapter: dbx, backend: 'dropbox' };
    localStorage.removeItem(BACKEND_KEY); // tokens gone → fall back, will re-prompt
  }
  return { adapter: new LocalStorageAdapter(), backend: 'local' };
}

async function main() {
  initSentry();
  const { adapter, backend } = await resolveBackend();
  await initRoadmapStore(adapter);

  const syncEl = document.getElementById('hr-sync-control');
  if (syncEl) createRoot(syncEl).render(<SyncControl backend={backend} />);

  const container = document.getElementById('health-tool-root');
  if (!container) {
    console.warn('Health tool mount point not found');
    return;
  }
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HealthTool />
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // Persist before the tab goes away — visibilitychange(hidden) is the reliable
  // mobile signal; beforeunload covers desktop. Both call the synchronous flush.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRoadmapStoreSync();
  });
  window.addEventListener('beforeunload', () => {
    flushRoadmapStoreSync();
  });
}

void main();
