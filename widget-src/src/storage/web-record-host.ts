/**
 * The web's RecordHost (health-core record-host.ts): localStorage is the
 * device tier, and on a cloud it holds the mirror of a save the cloud
 * refused. The marker functions live here because the host is what owns
 * them; roadmap-store.ts re-exports them for the modules that import them
 * from there.
 */
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import type { RecordFailureOp, RecordHost, RemoteChange } from '@roadmap/health-core/record-host';
import type { SaveStatus } from '@roadmap/health-core/save-state';
import {
  LocalStorageAdapter,
  clearLocalNamedFiles,
  localEraseGeneration,
  listenForOtherTabsLogOff,
  roadmapLocalWritesStopped,
  stopRoadmapLocalWrites,
} from './local-storage-adapter';
import { getDeviceId } from './device-id';
import { BACKEND_KEY, clearOffFileHealthData, dropDraftsOnScreen, healthWritesAllowed, logOffId, noteCloudPage, noteDevicePage, ownsOffFileData, safeGetItem, safeRemoveItem, safeSetItem, type LogOffId } from '../lib/storage';
import { clearedEraseFor, noteClearedFor } from '../lib/cleared-erase';
import { Sentry } from '../lib/sentry';
import { failureTags, recordFailure, storageCauseClass, storageFailureClass, WritesStoppedError } from '../lib/error-diagnostics';

/**
 * Set while the on-device copy may hold changes a cloud backend hasn't seen
 * (US-09 AC4): a failed cloud persist mirrors the working copy locally under
 * this marker; a failed connect-time lift and an on-device fallback session
 * (standalone/connect.ts) mark the existing local file the same way. Cleared by the next successful cloud
 * save, after create() has merged the on-device copy back in. ONLY the
 * functions below write it — the key is exported for tests alone.
 */
export const PENDING_MIRROR_KEY = 'health_roadmap_pending_cloud_sync';

/** The device copy's revision a connect's lift uploaded (DeviceMirror.lifted). */
const LIFTED_REVISION_KEY = 'health_roadmap_lifted_revision';

export { BACKEND_KEY } from '../lib/storage';

/** Fired on every marker flip; the sync-status UI listens (same convention as
 *  the standalone hr:* events). Dispatch is best-effort — absent in tests. */
export const SYNC_PENDING_EVENT = 'hr:sync-pending-changed';

/** Fired each time the record session's save status changes (US-09 AC30),
 *  with it as the detail; the storage line listens. */
export const SAVE_STATUS_EVENT = 'hr:save-status-changed';

/**
 * Fired when a re-read brought something new into the working copy — another
 * device, or an AI connector writing to the same file (US-34). HealthTool
 * listens and re-runs its own load path, so an open page shows the change
 * without a reload. The counting is HealthTool's: it fires
 * `remote_change_applied` when it has actually re-rendered. Its detail is the
 * engine's RemoteChange: `{ erase }`, the erase identity a merge moved the
 * record to, or null for any other change (US-16 AC2a). The store cannot
 * import the API layer — the v2 builds alias `lib/api` to `lib/roadmap-data`,
 * which imports the store, and the cycle would be real.
 */
export const REMOTE_CHANGED_EVENT = 'hr:remote-changed';

export function notify(name: string, detail?: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
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

/**
 * The record host's `stillChosen` on the web. The cloud page's device copy is
 * still its mirror only while ALL hold (US-09 AC2, AC2c): this page may write
 * health data here at all (healthWritesAllowed); the same sign-in, so no
 * log-off on this device since `openedUnder`, heard or not; and the same
 * provider, still named by this browser. Both the sign-in half and the
 * provider half must stay: after a log-off and a new sign-in to the same
 * provider the name alone matches again, and after a switch the id alone does.
 */
function sameSignInAndProvider(store: StorageAdapter, openedUnder: LogOffId): boolean {
  return healthWritesAllowed() && logOffId() === openedUnder && safeGetItem(BACKEND_KEY) === store.id;
}

/** The host for `store`: the device tier when it is localStorage itself,
 *  else a cloud with localStorage as its mirror. Every global is read at each
 *  call, never captured, so tests' fake timers and clocks apply. */
export function webRecordHost(store: StorageAdapter): RecordHost {
  const base = {
    store,
    // Another tab takes an erase in without clearing, dropping only the drafts on its screen, and its own erase
    // is refused first (US-11 AC6).
    // An owner's clear that does not read back throws, so the erase cleared for stays and the next load clears again.
    clearOffFileData: (keepOriginals: ReadonlySet<string>) => {
      if (!ownsOffFileData(store.id)) return dropDraftsOnScreen();
      if (!clearOffFileHealthData((ref) => keepOriginals.has(ref))) throw new Error('Off-file data still stored');
    },
    clearedErase: () => clearedEraseFor(store.id),
    noteCleared: (identity: string) => noteClearedFor(store.id, identity),
    ownsOffFileData: () => ownsOffFileData(store.id),
    // The localStorage record: a guest or on-device fallback tab keeps its
    // documents there, whatever record the erase came in on (US-09 AC23).
    deviceRecord: () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body,
    ...(store.watch ? {
      watch(onChange: () => void) {
        const watching = new AbortController();
        store.watch!(ROADMAP_FILE_NAME, onChange, watching.signal);
        return () => watching.abort();
      },
    } : {}),
    deviceId: getDeviceId,
    clock: { now: () => Date.now() },
    timers: {
      set: (run: () => void, ms: number) => setTimeout(run, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    remoteChanged: (change: RemoteChange) => notify(REMOTE_CHANGED_EVENT, change),
    saveStatusChanged: (status: SaveStatus) => notify(SAVE_STATUS_EVENT, status),
    failureCause: storageFailureClass,
    report(error: unknown, at: { op: RecordFailureOp; cause?: string; repeat: boolean }) {
      if (error instanceof WritesStoppedError) return; // a log-off refusal, not a failure (A15)
      // The erase's best-effort steps: an orphaned server row or chat history
      // left behind is reported, never silently swallowed, and only as a fixed
      // message (an error can quote the chat file, e.g. a medication's name).
      if (at.op === 'pre-erase') {
        console.warn('Pre-erase teardown failed');
        Sentry.captureException(recordFailure(error, 'Pre-erase teardown failed'), { tags: { area: 'reminders', op: 'pre-erase' } });
        return;
      }
      if (at.op === 'chat-erase') {
        console.warn('Chat-history erase failed');
        Sentry.captureException(recordFailure(error, 'Chat-history erase failed'), { tags: { area: 'chat-history', op: 'erase' } });
        return;
      }
      // A save landed, or an erase was taken in; upkeep after it failed.
      if (at.op === 'clear-off-file' || at.op === 'after-save') {
        console.warn('Record upkeep failed');
        if (!at.repeat) Sentry.captureException(recordFailure(error, 'Record upkeep failed'), { tags: { area: 'cloud-sync', op: at.op } });
        return;
      }
      console.warn('Cloud sync failed');
      if (at.repeat) return;
      Sentry.captureException(recordFailure(error, 'Cloud sync failed'), {
        tags: {
          area: 'cloud-sync', op: at.op, backend: store.id, ...(at.cause ? { cause: at.cause } : {}),
          errorClass: failureTags(error).errorClass, causeClass: storageCauseClass(error),
        },
      });
    },
  };
  if (store instanceof LocalStorageAdapter) {
    // The other record files (chat-history.json) sit under the adapter's
    // named-file prefix, which only disconnect() clears — and disconnect()
    // after an erase would delete the erased record file just written.
    noteDevicePage();
    return { ...base, tier: 'device', sync: store, clearNamedFiles: clearLocalNamedFiles, eraseFence: localEraseGeneration };
  }
  const device = new LocalStorageAdapter();
  // Note a log-off from another page from now, not only once the first cloud
  // read returns: its signal is set and removed at once, so a tab still
  // loading would miss it (US-09 AC2h). opened() latches on the note.
  listenForOtherTabsLogOff();
  // Noted once, never reassigned: the id the adapter's sign-in began under,
  // else the device's id now.
  const openedUnder: LogOffId = 'gen' in store ? (store as { gen: LogOffId }).gen : logOffId();
  return {
    ...base,
    tier: 'cloud',
    mirror: {
      adapter: device,
      sync: device,
      pending: { get: isSyncPending, set: markSyncPending, clear: clearSyncPending },
      lifted: {
        get: () => safeGetItem(LIFTED_REVISION_KEY),
        set: (revision: string) => safeSetItem(LIFTED_REVISION_KEY, revision),
        clear: () => safeRemoveItem(LIFTED_REVISION_KEY),
      },
      writesStopped: roadmapLocalWritesStopped,
      stillChosen: () => sameSignInAndProvider(store, openedUnder),
      wipe: () => device.disconnect(),
      opened: () => noteCloudPage(store.id),
    },
  };
}
