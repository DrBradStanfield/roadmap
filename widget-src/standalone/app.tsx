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
import './standalone.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthTool } from '../src/components/HealthTool';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initSentry, Sentry } from '../src/lib/sentry';
import { initRoadmapStore, flushRoadmapStoreSync, setPreEraseHook } from '../src/lib/roadmap-data';
import { resolveAssistantName, setAssistantName } from '../src/lib/assistant-config';
import { autoEnrolReminders, cancelRemindersForErase, pushReminderSchedule } from './reminders';
import { RemindersEnrolledNotice } from './reminders-control';
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
import { SyncControl, RemindersSection } from './sync-control';
import { HistoryLightboxHost } from './history-lightbox';
import { migrateLocalInto, BACKEND_KEY, type Backend } from './connect';
import { trackProductEvent } from '../src/lib/api';

interface ResolvedBackend {
  adapter: StorageAdapter;
  backend: Backend;
  /** Google Drive is the remembered backend but its ~1h token is gone — the
   * session runs on-device until the user clicks Reconnect (popups need a
   * user gesture, so we can't re-auth at page load). */
  reconnect?: 'google-drive';
}

async function resolveBackend(): Promise<ResolvedBackend> {
  // Returning from a Dropbox OAuth redirect?
  let resumed: DropboxAdapter | null = null;
  try {
    resumed = await DropboxAdapter.completeRedirect(dropboxConfig());
  } catch (error) {
    console.warn('Dropbox connect failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-connect', backend: 'dropbox' } });
  }
  if (resumed) {
    await migrateLocalInto(resumed);
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
    return { adapter: resumed, backend: 'dropbox' };
  }

  // Returning from a Google Drive OAuth redirect? (Each completeRedirect only
  // claims a ?code that its own PKCE session entry initiated.)
  let gdResumed: GoogleDriveAdapter | null = null;
  try {
    gdResumed = await GoogleDriveAdapter.completeRedirect(googleDriveConfig());
  } catch (error) {
    console.warn('Google Drive connect failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-connect', backend: 'google-drive' } });
  }
  if (gdResumed) {
    await migrateLocalInto(gdResumed);
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    trackProductEvent('cloud_connect_success', { provider: 'google-drive' });
    return { adapter: gdResumed, backend: 'google-drive' };
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
      // Valid cached token, or a silent refresh through the stateless endpoint
      // (a fetch — fine at page load, unlike a popup).
      if (gd.hasValidToken() || (await gd.tryServerRefresh())) {
        return { adapter: gd, backend: 'google-drive' };
      }
      // Endpoint unreachable or refresh token revoked. A popup can't open at
      // page load, so run this session on-device and offer Reconnect. KEEP the
      // remembered choice — local edits merge up on reconnect.
      return { adapter: new LocalStorageAdapter(), backend: 'local', reconnect: 'google-drive' };
    }
  }
  if (remembered) localStorage.removeItem(BACKEND_KEY); // creds gone → fall back, will re-prompt

  return { adapter: new LocalStorageAdapter(), backend: 'local' };
}

async function main() {
  initSentry();
  const { adapter, backend, reconnect } = await resolveBackend();
  await initRoadmapStore(adapter);
  // "Delete all my data" must also delete the reminder row on Brad's server,
  // and the token that authorises it dies with the file — so it runs first.
  setPreEraseHook(cancelRemindersForErase);

  const container = document.getElementById('health-tool-root');
  if (!container) {
    console.warn('Health tool mount point not found');
    return;
  }
  // Per-store chatbot display name (default "Brad AI"; overridable per store).
  setAssistantName(resolveAssistantName(container));
  // The sync control renders inside the plan panel (where the Shopify "Data
  // synced" line was) via the syncControl prop — not as a separate top banner.
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        {/* US-17: the default-on enrolment notice sits ABOVE the widget, not in
            the plan panel — the plan is slide 2 of the mobile tab layout and
            every connect path reloads onto slide 1, so a notice inside it would
            be announced to an off-screen panel. */}
        <RemindersEnrolledNotice backend={backend} />
        <HealthTool
          syncControl={({ hasData }) => <SyncControl backend={backend} reconnect={reconnect} hasData={hasData} />}
          remindersSection={<RemindersSection backend={backend} />}
        />
        <HistoryLightboxHost />
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // Persist before the tab goes away — visibilitychange(hidden) is the reliable
  // mobile signal; beforeunload covers desktop. Both call the synchronous flush.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushRoadmapStoreSync();
      // Session-end snapshot of the reminder schedule (keepalive survives the
      // tab going away). No-op unless opted in.
      void pushReminderSchedule(true);
    }
  });
  window.addEventListener('beforeunload', () => {
    flushRoadmapStoreSync();
  });

  // Keep the server's reminder schedule tracking the user's data (§10): one
  // push per visit — it also discovers email-link unsubscribes (404 → the
  // stale opt-in is cleared). Fire-and-forget — never blocks the app.
  void pushReminderSchedule();

  // Default-on reminders (US-17): a connected cloud IS the consent. No-ops
  // unless this file records no decision yet, so it never overrides an
  // opt-out. After render, so the notice's listener is mounted; after the
  // store, so the pushed schedule is the user's real one.
  void autoEnrolReminders(backend);
}

void main();
