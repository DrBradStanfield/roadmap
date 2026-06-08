/**
 * SyncManager — the one object the widget uses for all persistence. It sits above
 * a single StorageAdapter and implements the optimistic-concurrency
 * read-merge-write loop (implementation plan §5.3).
 *
 *   save(local):
 *     1. read remote {file, version}
 *     2. base = migrate(remote)            // normalise + gate schema version (H7)
 *     3. merged = mergeFiles(local, base)  // deterministic conflict-free merge
 *     4. write(merged, expectedVersion=version)
 *        - on ConflictError (remote moved): retry from 1 (bounded)
 *     5. verify-after-write (re-read, must parse + lamport not regressed) (H5)
 *
 * The merge is what makes concurrent multi-device edits safe; the version
 * precondition is what makes a lost-update impossible.
 */
import {
  createEmptyFile,
  mergeFiles,
  migrateFile,
  type RoadmapFile,
} from '@roadmap/health-core';
import {
  ConflictError,
  StorageError,
  type StorageAdapter,
  type StorageBackendId,
} from './adapter';

const MAX_SAVE_ATTEMPTS = 5;

export interface SaveResult {
  file: RoadmapFile;
  version: string;
  /** How many conflict retries happened (0 = clean first write). */
  attempts: number;
}

export class SyncManager {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly deviceId: string,
    /** Injectable clock so tests/harness are deterministic. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get backendId(): StorageBackendId {
    return this.adapter.id;
  }

  /** Load the user's record, normalising whatever is in the cloud (or empty). */
  async load(): Promise<RoadmapFile> {
    const { file } = await this.adapter.read();
    return migrateFile(file, { deviceId: this.deviceId, now: this.now() });
  }

  /**
   * Persist `local`, merging in any concurrent remote changes. Returns the
   * merged file actually written (the new source of truth for this device).
   */
  async save(local: RoadmapFile): Promise<SaveResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      const { file: remoteRaw, version } = await this.adapter.read();
      const base = migrateFile(remoteRaw, { deviceId: this.deviceId, now: this.now() });
      const merged = mergeFiles(local, base, { deviceId: this.deviceId, now: this.now() });
      try {
        const { version: newVersion } = await this.adapter.write(merged, version);
        await this.verifyAfterWrite(merged);
        return { file: merged, version: newVersion, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (error instanceof ConflictError) continue; // remote moved — re-read & re-merge
        throw error;
      }
    }
    throw new StorageError(
      `Save failed after ${MAX_SAVE_ATTEMPTS} attempts — a sync conflict storm. Your data is unharmed; try again.`,
      lastError,
    );
  }

  /**
   * Re-read after writing to catch a half-write / corruption (H5). Tolerates a
   * concurrent newer write (lamport advanced) — that's not corruption. Throws
   * only if the file is gone, unparseable, or its lamport regressed below ours.
   */
  private async verifyAfterWrite(expected: RoadmapFile): Promise<void> {
    const { file } = await this.adapter.read();
    if (file == null) {
      throw new StorageError('Verify-after-write failed: the file is missing after a successful write.');
    }
    let parsed: RoadmapFile;
    try {
      parsed = migrateFile(file, { deviceId: this.deviceId, now: this.now() });
    } catch (error) {
      throw new StorageError('Verify-after-write failed: the written file did not parse.', error);
    }
    if (parsed.meta.lamport < expected.meta.lamport) {
      throw new StorageError('Verify-after-write failed: the written revision is older than expected.');
    }
  }
}

/** Helper for an empty starting file on this device. */
export function newEmptyFile(deviceId: string, now: string = new Date().toISOString()): RoadmapFile {
  return createEmptyFile({ deviceId, now });
}
