/**
 * The local-first storage layer (implementation plan §4–§5). Browser-coupled:
 * adapters use fetch / Web Crypto / localStorage. The pure file schema + merge
 * logic lives in @roadmap/health-core (roadmap-file.ts, merge.ts, migrate.ts).
 */
export {
  ConflictError,
  StorageError,
  type StorageAdapter,
  type StorageBackendId,
  type ReadResult,
  type WriteResult,
} from './adapter';
export { SyncManager, newEmptyFile, type SaveResult } from './sync-manager';
export { MemoryAdapter, MemoryCloud } from './memory-adapter';
export { DropboxAdapter, type DropboxConfig } from './dropbox';
export { getDeviceId } from './device-id';
export { runStorageSelfTest, type SelfTestResult } from './self-test';
