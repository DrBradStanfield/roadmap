/**
 * The local-first storage layer (implementation plan §4–§5). Browser-coupled:
 * adapters use fetch / Web Crypto / localStorage. The pure file schema + merge
 * logic lives in @roadmap/health-core (roadmap-file.ts, merge.ts, migrate.ts).
 */
export { ConflictError, StorageError, ROADMAP_FILE_NAME, type StorageAdapter, type StorageBackendId, type ReadResult, type WriteResult } from '@roadmap/health-core/adapter';
export { SyncManager, type SaveResult } from '@roadmap/health-core/sync-manager';
// RoadmapStore is imported directly from './roadmap-store' by
// the data shim (lib/roadmap-data.ts) — not re-exported here to avoid a second
// canonical copy of its names (the Api* types live in lib/api-types.ts). standalone/ lifts
// and copies the record through health-core's record-transfer.ts.
export { markSyncPending, isSyncPending, SYNC_PENDING_EVENT, SAVE_STATUS_EVENT } from './roadmap-store';
// Thrown by SyncManager (via migrate) when the cloud file is from a newer app
// version — surfaced here so UI can show "update the app", not a generic error.
export { SchemaTooNewError } from '@roadmap/health-core/migrate';
export { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
export { LocalStorageAdapter, signalLogOff } from './local-storage-adapter';
export { DropboxAdapter, type DropboxConfig } from './dropbox';
export { GitHubAdapter, type GitHubConfig } from './github';
export { WebDavAdapter, type WebDavConfig } from './webdav';
export { GoogleDriveAdapter, DriveGrantRefusedError, DRIVE_FILE_SCOPE, gisReady, preloadGis, type GoogleDriveConfig } from './drive';
export { getDeviceId } from './device-id';
