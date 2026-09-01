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
import { RecordShapeError, SchemaTooNewError } from './migrate';

const MAX_SAVE_ATTEMPTS = 5;

/** The write landed and the re-read disagreed, so the caller cannot say either way. */
const VERIFY_HINT = 'The change may or may not have landed. Read the record again before trying it a second time.';

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
  /** The ids of the append-only rows in this document, so the verify step can
   *  see that what was just written is actually there. Optional: a document
   *  with no rows (chat history) has nothing to check. */
  rowIds?(file: T): string[];
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
      `Save failed after ${MAX_SAVE_ATTEMPTS} attempts — a sync conflict storm`,
      'Your data is unharmed and nothing was written. Try again.',
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
      throw new StorageError(
        'Verify-after-write failed: the file is missing after a successful write',
        VERIFY_HINT,
      );
    }
    let parsed: T;
    try {
      parsed = this.doc.migrate(body, this.ctx());
    } catch (error) {
      throw new StorageError('Verify-after-write failed: the written file did not parse', VERIFY_HINT, error);
    }
    if (parsed.meta.lamport < expected.meta.lamport) {
      throw new StorageError('Verify-after-write failed: the written revision is older than expected', VERIFY_HINT);
    }
    // Lamport alone cannot see a lost update: a concurrent writer that dropped
    // our rows advances it. The rows themselves are append-only, so every id we
    // wrote must still be there — this is what makes a lost edit REPORTED
    // rather than confirmed (mcp-architecture.md §7, Drive step 3).
    if (this.doc.rowIds) {
      const present = new Set(this.doc.rowIds(parsed));
      const missing = this.doc.rowIds(expected).filter((id) => !present.has(id));
      if (missing.length > 0) {
        throw new StorageError(
          `Verify-after-write failed: ${missing.length} row(s) that were just written are not in the file`,
          VERIFY_HINT,
        );
      }
    }
  }
}

/**
 * One storage failure, in the words the surface above will say — the hosted
 * MCP server, the stdio server and the CLI all print this and nothing of their
 * own, so a conflict storm reads the same wherever the user meets it.
 * `provider` names what holds the record: 'The record in Dropbox', or a path.
 *
 * The fallback never blames the user: a failure nobody anticipated is ours.
 */
export interface StorageFailure {
  /** One plain line. */
  message: string;
  /** What to do about it. */
  hint: string;
}

export function describeStorageFailure(error: unknown, provider: string): StorageFailure {
  if (error instanceof SchemaTooNewError) {
    return {
      message:
        `This record was written by a newer version of the app: schema v${error.fileVersion}, ` +
        `and this tool understands v${error.appVersion}`,
      hint:
        'It cannot be read or written here — reads refuse too, because the record is migrated before any tool ' +
        'runs. Nothing was written. Open the app, which will update it.',
    };
  }
  if (error instanceof RecordShapeError) {
    return {
      message: `${provider} is not a health-roadmap.json — ${error.detail}`,
      hint: 'Point at the record file itself. Nothing was changed.',
    };
  }
  if (error instanceof ConflictError) {
    return {
      message: `${provider} changed while this change was being written`,
      hint: 'Nothing was written. Read the record again, then retry.',
    };
  }
  if (error instanceof StorageError && error.hint) {
    return { message: error.message, hint: error.hint };
  }
  return {
    message: `${provider} did not answer. Nothing was written`,
    hint: 'Try once more; if it keeps failing, check that the record is reachable.',
  };
}

/** The failures storage is allowed to have. Anything else is a bug in us, and
 *  must not be dressed up as something the user can fix. */
export function isStorageFailure(error: unknown): boolean {
  return error instanceof StorageError || error instanceof ConflictError
    || error instanceof SchemaTooNewError || error instanceof RecordShapeError;
}
