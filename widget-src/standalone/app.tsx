/**
 * Standalone (GitHub Pages / self-host) entry for the full Health Roadmap app.
 *
 * Same React tree as the Shopify widget, but the data layer is local-first: the
 * Vite redirect (vite.config.standalone.ts) points the app's `lib/api` imports
 * at the RoadmapStore shim. This entry resolves which backend to use (a returning
 * Dropbox OAuth redirect, a remembered choice, else the on-device tier),
 * initialises the store, and renders the connect-a-cloud control inside the plan.
 */
import '../src/styles.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthTool } from '../src/components/HealthTool';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initSentry } from '../src/lib/sentry';
import { initRoadmapStore, flushRoadmapStoreSync } from '../src/lib/roadmap-data';
import {
  DropboxAdapter,
  GoogleDriveAdapter,
  GitHubAdapter,
  WebDavAdapter,
  LocalStorageAdapter,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import { SyncControl } from './sync-control';
import { migrateLocalInto, BACKEND_KEY, type Backend } from './connect';

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

  // Remembered choice. The credential/token lives in each adapter's own storage,
  // so a bare `new Adapter()` reconnects if it's still there.
  const remembered = localStorage.getItem(BACKEND_KEY) as Backend | null;
  if (remembered === 'dropbox') {
    const dbx = new DropboxAdapter(dropboxConfig());
    if (dbx.isConnected()) return { adapter: dbx, backend: 'dropbox' };
  } else if (remembered === 'github') {
    const gh = new GitHubAdapter();
    if (gh.isConnected()) return { adapter: gh, backend: 'github' };
  } else if (remembered === 'self-host') {
    const wd = new WebDavAdapter();
    if (wd.isConnected()) return { adapter: wd, backend: 'self-host' };
  } else if (remembered === 'google-drive') {
    const gd = new GoogleDriveAdapter(googleDriveConfig());
    if (gd.isConnected()) {
      try {
        await gd.reconnect(); // silent token re-grant; throws on Safari/ITP / expired session
        return { adapter: gd, backend: 'google-drive' };
      } catch {
        /* silent re-grant blocked → fall through to local; the user re-connects */
      }
    }
  }
  if (remembered) localStorage.removeItem(BACKEND_KEY); // creds gone → fall back, will re-prompt

  return { adapter: new LocalStorageAdapter(), backend: 'local' };
}

async function main() {
  initSentry();
  const { adapter, backend } = await resolveBackend();
  await initRoadmapStore(adapter);

  const container = document.getElementById('health-tool-root');
  if (!container) {
    console.warn('Health tool mount point not found');
    return;
  }
  // The sync control renders inside the plan panel (where the Shopify "Data
  // synced" line was) via the syncControl prop — not as a separate top banner.
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HealthTool syncControl={<SyncControl backend={backend} />} />
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
