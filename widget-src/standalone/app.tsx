/**
 * Standalone (GitHub Pages / self-host) entry for the full Health Roadmap app.
 *
 * Shared entry for Shopify and Pages, using the local-first RoadmapStore.
 * This entry resolves which backend to use (a returning
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
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import { SyncControl, RemindersSection } from './sync-control';
import { ConnectRefusedNotice } from './connect-refused';
import { EmailLandingNotice, emailLandingApplies, takeEmailFlag } from './email-landing';
import { StorageNoticeContext } from '../src/lib/storage-notice';
import { HistoryLightboxHost } from './history-lightbox';
import {
  connectRefusal,
  liftLocalInto,
  onDeviceFallback,
  startOnBackend,
  storageState,
  BACKEND_KEY,
  type Backend,
  type ResolvedBackend,
} from './connect';
import { trackProductEvent } from '../src/lib/server-api';

/** The backend this load runs on, and the connect it refused on the way, if
 *  any (US-09 AC15) — kept apart from the backend so a load-time fallback
 *  cannot drop it. */
async function resolveBackend(): Promise<{ resolved: ResolvedBackend; refused?: string }> {
  // Returning from a Dropbox OAuth redirect?
  let resumed: DropboxAdapter | null = null;
  try {
    resumed = await DropboxAdapter.completeRedirect(dropboxConfig());
  } catch (error) {
    console.warn('Dropbox connect failed', error);
    Sentry.captureException(error, { tags: { area: 'cloud-connect', backend: 'dropbox' } });
  }
  if (resumed) {
    await liftLocalInto(resumed, 'dropbox');
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
    return { resolved: { adapter: resumed, backend: 'dropbox' } };
  }

  // Returning from a Google Drive OAuth redirect? (Each completeRedirect only
  // claims a ?code that its own PKCE session entry initiated.)
  let gdResumed: GoogleDriveAdapter | null = null;
  let refused: string | undefined;
  try {
    gdResumed = await GoogleDriveAdapter.completeRedirect(googleDriveConfig());
  } catch (error) {
    refused = connectRefusal(error) ?? undefined;
    if (!refused) {
      console.warn('Google Drive connect failed', error);
      Sentry.captureException(error, { tags: { area: 'cloud-connect', backend: 'google-drive' } });
    }
  }
  if (gdResumed) {
    await liftLocalInto(gdResumed, 'google-drive');
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    trackProductEvent('cloud_connect_success', { provider: 'google-drive' });
    return { resolved: { adapter: gdResumed, backend: 'google-drive' } };
  }

  return { resolved: await resolveRemembered(), refused };
}

/** The remembered choice. The credential/token lives in each adapter's own
 *  storage, so a bare `new Adapter()` reconnects if it's still there. */
async function resolveRemembered(): Promise<ResolvedBackend> {
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
      // page load: run on-device, offer Reconnect, KEEP the remembered choice.
      return onDeviceFallback('google-drive');
    }
  }
  if (remembered) localStorage.removeItem(BACKEND_KEY); // creds gone → fall back, will re-prompt

  return { adapter: new LocalStorageAdapter(), backend: 'local' };
}

async function main() {
  initSentry();
  // Before the first await (US-22 AC13): an OAuth return rewrites the URL.
  const fromEmail = takeEmailFlag();
  const { resolved, refused } = await resolveBackend();
  const { backend, reconnect } = await startOnBackend(resolved, initRoadmapStore);
  const state = storageState(backend, reconnect);
  const emailLanding = await emailLandingApplies(fromEmail, state);
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
        {refused && <ConnectRefusedNotice message={refused} />}
        {emailLanding && <EmailLandingNotice />}
        <StorageNoticeContext.Provider value={state === 'guest'}>
          <HealthTool
            syncControl={({ hasData }) => <SyncControl backend={backend} reconnect={reconnect} hasData={hasData} />}
            remindersSection={<RemindersSection backend={backend} />}
          />
        </StorageNoticeContext.Provider>
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
