/**
 * Standalone (GitHub Pages / self-host) entry for the full Health Roadmap app.
 *
 * Same React tree as the Shopify widget, but the data layer is local-first: the
 * Vite redirect (vite.config.standalone.ts) points the app's `lib/api` imports
 * at the RoadmapStore shim, which we initialise here with the local (no-sync)
 * tier. Phase 2 swaps in a cloud adapter via the connect-a-cloud picker.
 */
import '../src/styles.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthTool } from '../src/components/HealthTool';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initSentry } from '../src/lib/sentry';
import { initRoadmapStore, flushRoadmapStoreSync } from '../src/lib/roadmap-data';
import { LocalStorageAdapter } from '../src/storage';

async function main() {
  initSentry();
  // Phase 1: default to the on-device tier so the app works with no cloud/key.
  await initRoadmapStore(new LocalStorageAdapter());

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

  // Persist any debounced writes before the tab goes away. visibilitychange
  // (hidden) is the reliable signal on mobile, where beforeunload often doesn't
  // fire; beforeunload covers desktop tab-close. Both are best-effort flushes on
  // top of the in-session debounce.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRoadmapStoreSync();
  });
  window.addEventListener('beforeunload', () => {
    flushRoadmapStoreSync();
  });
}

void main();
