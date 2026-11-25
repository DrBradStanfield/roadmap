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
import { registerPageDeparture } from './page-departure';
import { createRoot } from 'react-dom/client';
import { HealthTool } from '../src/components/HealthTool';
import { GuestContext } from '../src/lib/storage-notice';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initRoadmapStore, setPreEraseHook } from '../src/lib/roadmap-data';
import { resolveAssistantName, setAssistantName, resolveSkipEmailGate, setSkipEmailGate } from '../src/lib/assistant-config';
import { resolveMarketCountry, setMarketCountry } from '../src/lib/market-country';
import { autoEnrolReminders, cancelRemindersForErase, pushReminderSchedule } from './reminders';
import { RemindersEnrolledNotice } from './reminders-control';
import { LocalSaveAlert, StorageBar, SyncControl, RemindersSection } from './sync-control';
import { ConnectRefusedNotice } from './connect-refused';
import { EmailLandingNotice, emailLandingApplies } from './email-landing';
import { HistoryLightboxHost } from './history-lightbox';
import { boot } from './boot';
import { storageState } from './connect';
import { resolveBackend } from './resolve-backend';

async function main() {
  // Nothing may run before boot(): its first line notes another tab's log-off
  // (US-09 AC2h), and logout-latch-during-load.test.ts runs only boot().
  const { backend, refused, fromEmail } = await boot(resolveBackend, initRoadmapStore);
  const state = storageState(backend);
  const emailLanding = await emailLandingApplies(fromEmail, state);
  // "Delete all my data" must also delete the reminder row on Brad's server.
  // The token dies with the file, so it is read inside the erase; the cancel
  // follows only an erase that stands (US-11 AC4c).
  setPreEraseHook(cancelRemindersForErase);

  const container = document.getElementById('health-tool-root');
  if (!container) {
    console.warn('Health tool mount point not found');
    return;
  }
  // Per-store chatbot display name (default "Brad AI"; overridable per store).
  setAssistantName(resolveAssistantName(container));
  // US-44: the funnel page's block shows Save as PDF without the email box.
  setSkipEmailGate(resolveSkipEmailGate(container));
  // US-61: the market country, for the US product blocks (Shopify build only).
  setMarketCountry(resolveMarketCountry(container));
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
        <GuestContext.Provider value={state === 'guest'}>
          <HealthTool
            syncControl={({ hasData, attention }) => <SyncControl backend={backend} hasData={hasData} attention={attention} />}
            remindersSection={<RemindersSection backend={backend} />}
            storageBar={<StorageBar backend={backend} />}
            saveAlert={<LocalSaveAlert backend={backend} />}
            syncAlert={<StorageBar backend={backend} problemsOnly />}
          />
        </GuestContext.Provider>
        <HistoryLightboxHost />
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // Persist before the tab goes away — visibilitychange(hidden) is the reliable
  // mobile signal; beforeunload covers desktop. Both call the synchronous flush.
  registerPageDeparture(() => { void pushReminderSchedule(backend, true); });

  // Keep the server's reminder schedule tracking the user's data (§10): one
  // push per visit — it also discovers email-link unsubscribes (404 → the
  // stale opt-in is cleared). Fire-and-forget — never blocks the app.
  // Default-on reminders (US-17): a connected cloud IS the consent. No-ops
  // unless this file records no decision yet, so it never overrides an
  // opt-out. After render, so the notice's listener is mounted; after the
  // store, so the pushed schedule is the user's real one. The push follows the
  // enrolment, so it never races a cloud switch's cancel (US-17 AC12).
  void autoEnrolReminders(backend)
    .catch(() => undefined)
    .then(() => pushReminderSchedule(backend));
}

void main();
