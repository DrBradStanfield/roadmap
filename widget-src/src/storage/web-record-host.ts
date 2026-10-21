/**
 * The web's RecordHost (health-core record-host.ts): localStorage is the
 * device tier, and on a cloud it holds the mirror of a save the cloud
 * refused. The marker functions live here because the host is what owns
 * them; roadmap-store.ts re-exports them for the modules that import them
 * from there.
 */
import type { RecordHost, StorageAdapter } from '@roadmap/health-core';
import {
  LocalStorageAdapter,
  clearLocalNamedFiles,
  latchOnOtherTabsLogOff,
  roadmapLocalWritesStopped,
  stopRoadmapLocalWrites,
} from './local-storage-adapter';
import { getDeviceId } from './device-id';
import { clearOffFileHealthData, safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import { Sentry } from '../lib/sentry';
import { recordFailure, storageFailureClass } from '../lib/error-diagnostics';

/**
 * Set while the on-device copy may hold changes a cloud backend hasn't seen
 * (US-09 AC4): a failed cloud persist mirrors the working copy locally under
 * this marker; a failed connect-time lift and an on-device fallback session
 * (standalone/connect.ts) mark the existing local file the same way. Cleared by the next successful cloud
 * save, after create() has merged the on-device copy back in. ONLY the
 * functions below write it — the key is exported for tests alone.
 */
export const PENDING_MIRROR_KEY = 'health_roadmap_pending_cloud_sync';

/** Fired on every marker flip; the sync-status UI listens (same convention as
 *  the standalone hr:* events). Dispatch is best-effort — absent in tests. */
export const SYNC_PENDING_EVENT = 'hr:sync-pending-changed';

/**
 * Fired when a re-read brought something new into the working copy — another
 * device, or an AI connector writing to the same file (US-34). HealthTool
 * listens and re-runs its own load path, so an open page shows the change
 * without a reload. The counting is HealthTool's: it fires
 * `remote_change_applied` when it has actually re-rendered. The store cannot
 * import the API layer — the v2 builds alias `lib/api` to `lib/roadmap-data`,
 * which imports the store, and the cycle would be real.
 */
export const REMOTE_CHANGED_EVENT = 'hr:remote-changed';

export function notify(name: string): void {
  try {
    window.dispatchEvent(new Event(name));
  } catch {
    /* non-browser environment (tests) */
  }
}

/** Record that on-device data is ahead of the cloud (see PENDING_MIRROR_KEY).
 *  A yes or no: which rows travel is the erase list's call, not a time's
 *  (US-09 AC23). isSyncPending checks only that it is there. The value is a
 *  far-future instant because an older bundle in another tab still reads it
 *  as "keep rows newer than this" past an erase: so it keeps nothing extra. */
export function markSyncPending(): void {
  if (roadmapLocalWritesStopped()) return;
  safeSetItem(PENDING_MIRROR_KEY, '9999-12-31T23:59:59.999Z');
  notify(SYNC_PENDING_EVENT);
}

/** Stop this page (and every other tab, by a storage signal) recreating the
 *  roadmap after logout, without erasing cloud data or cancelling successful
 *  cloud saves (including lifecycle flushes). */
export function beginRoadmapLogOff(): void {
  stopRoadmapLocalWrites();
  clearSyncPending();
}

function clearSyncPending(): void {
  safeRemoveItem(PENDING_MIRROR_KEY);
  notify(SYNC_PENDING_EVENT);
}

/** True while on-device data is still waiting to reach the cloud. */
export function isSyncPending(): boolean {
  return safeGetItem(PENDING_MIRROR_KEY) != null;
}

/** The host for `store`: the device tier when it is localStorage itself,
 *  else a cloud with localStorage as its mirror. Every global is read at each
 *  call, never captured, so tests' fake timers and clocks apply. */
export function webRecordHost(store: StorageAdapter): RecordHost {
  const base = {
    store,
    clearOffFileData: clearOffFileHealthData,
    deviceId: getDeviceId,
    clock: { now: () => Date.now() },
    timers: {
      set: (run: () => void, ms: number) => setTimeout(run, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    remoteChanged: () => notify(REMOTE_CHANGED_EVENT),
    failureCause: storageFailureClass,
    report(error: unknown, at: { op: 'persist'; cause?: string; repeat: boolean }) {
      console.warn('Cloud sync failed');
      if (at.repeat) return;
      Sentry.captureException(recordFailure(error, 'Cloud sync failed'), {
        tags: { area: 'cloud-sync', op: at.op, backend: store.id, ...(at.cause ? { cause: at.cause } : {}) },
      });
    },
  };
  if (store instanceof LocalStorageAdapter) {
    // The other record files (chat-history.json) sit under the adapter's
    // named-file prefix, which only disconnect() clears — and disconnect()
    // after an erase would delete the erased record file just written.
    return { ...base, tier: 'device', sync: store, clearNamedFiles: clearLocalNamedFiles };
  }
  const device = new LocalStorageAdapter();
  return {
    ...base,
    tier: 'cloud',
    mirror: {
      adapter: device,
      pending: { get: isSyncPending, set: markSyncPending, clear: clearSyncPending },
      writesStopped: roadmapLocalWritesStopped,
      wipe: () => device.disconnect(),
      opened: latchOnOtherTabsLogOff,
    },
  };
}
