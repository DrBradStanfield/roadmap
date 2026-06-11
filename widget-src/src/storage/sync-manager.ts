/**
 * SyncManager — the one object the widget uses for all persistence. It sits
 * above a single StorageAdapter and implements the optimistic-concurrency
 * read-merge-write loop (implementation plan §5.3) for ONE named document:
 *
 *   save(local):
 *     1. read remote {body, version}
 *     2. base = doc.migrate(remote)        // normalise + gate schema version (H7)
 *     3. merged = doc.merge(local, base)   // deterministic conflict-free merge
 *     4. write(merged, expectedVersion=version)
 *        - on ConflictError (remote moved): retry from 1 (bounded)
 *     5. verify-after-write (re-read, must parse + lamport not regressed) (H5)
 *
 * The merge is what makes concurrent multi-device edits safe; the version
 * precondition is what makes a lost-update impossible.
 *
 * Schema knowledge is injected as a DocumentSpec, so the SAME loop syncs both
 * `health-roadmap.json` (ROADMAP_DOC, defined beside its store) and
 * `chat-history.json` (CHAT_HISTORY_DOC) — one SyncManager instance per
 * document, both over the same adapter.
 */
import {
  ConflictError,
  StorageError,
  type StorageAdapter,
  type StorageBackendId,
} from './adapter';

const MAX_SAVE_ATTEMPTS = 5;

/** Every synced document carries the lamport meta the verify step relies on. */
export interface SyncedFile {
  meta: { lamport: number };
}

export interface SyncContext {
  deviceId: string;
  now: string;
}

/**
 * Everything schema-specific about one synced JSON file: its name, how a raw
 * (possibly null/old/foreign) body becomes a valid T, and how two valid Ts
 * merge deterministically.
 */
export interface DocumentSpec<T extends SyncedFile> {
  fileName: string;
  migrate(raw: unknown, ctx: SyncContext): T;
  merge(local: T, base: T, ctx: SyncContext): T;
  /** Set false to skip the verify-after-write re-read (H5). Default true —
   *  right for health-record data; best-effort documents (chat history) can
   *  drop it and save a full-file transfer per save. */
  verify?: boolean;
}

export interface SaveResult<T> {
  file: T;
  version: string;
  /** How many conflict retries happened (0 = clean first write). */
  attempts: number;
}

export class SyncManager<T extends SyncedFile> {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly deviceId: string,
    private readonly doc: DocumentSpec<T>,
    /** Injectable clock so tests/harness are deterministic. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get backendId(): StorageBackendId {
    return this.adapter.id;
  }

  private ctx(): SyncContext {
    return { deviceId: this.deviceId, now: this.now() };
  }

  /** Load the document, normalising whatever is in the cloud (or empty). */
  async load(): Promise<T> {
    const { body } = await this.adapter.read(this.doc.fileName);
    return this.doc.migrate(body, this.ctx());
  }

  /**
   * Persist `local`, merging in any concurrent remote changes. Returns the
   * merged file actually written (the new source of truth for this device).
   */
  async save(local: T): Promise<SaveResult<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      const { body: remoteRaw, version } = await this.adapter.read(this.doc.fileName);
      const base = this.doc.migrate(remoteRaw, this.ctx());
      const merged = this.doc.merge(local, base, this.ctx());
      try {
        const { version: newVersion } = await this.adapter.write(this.doc.fileName, merged, version);
        if (this.doc.verify !== false) await this.verifyAfterWrite(merged);
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
  private async verifyAfterWrite(expected: T): Promise<void> {
    const { body } = await this.adapter.read(this.doc.fileName);
    if (body == null) {
      throw new StorageError('Verify-after-write failed: the file is missing after a successful write.');
    }
    let parsed: T;
    try {
      parsed = this.doc.migrate(body, this.ctx());
    } catch (error) {
      throw new StorageError('Verify-after-write failed: the written file did not parse.', error);
    }
    if (parsed.meta.lamport < expected.meta.lamport) {
      throw new StorageError('Verify-after-write failed: the written revision is older than expected.');
    }
  }
}
