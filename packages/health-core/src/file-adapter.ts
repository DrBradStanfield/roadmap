/**
 * A `StorageAdapter` over ONE local file: read the bytes, back the record up,
 * replace it atomically, and refuse a write whose precondition has moved. A
 * `.lock` sibling held across the whole check-backup-replace is what makes
 * that precondition mean anything against a second PROCESS.
 *
 * Node built-ins only, and nothing in the widget imports it: the browser
 * bundles never reach this module, so `node:fs` in health-core stays a
 * server/CLI fact.
 *
 * Two deliberate differences from a cloud adapter, both because the caller
 * pointed at a path rather than a folder:
 *  - the file NAME is the constructor's, not the argument's — one path, one
 *    document;
 *  - a missing file is an ERROR, not an empty read. Nobody asks a CLI to edit
 *    a record and means "create one wherever I mistyped".
 *
 * why: mcp-architecture.md §7
 */
import { chmodSync, closeSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type StorageAdapter, type WriteResult } from './adapter';
import { RecordShapeError } from './migrate';

/** How many `.bak-` siblings to keep beside the record. */
export const BACKUPS_KEPT = 3;

/** Lock timings: how often to retry, how long to wait, when to call one dead. */
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/**
 * The bytes on disk, as a value that changes whenever they do. A content hash
 * rather than mtime+size: two writes inside one millisecond that keep the file
 * the same length are indistinguishable by stat, and this guard is the only
 * thing standing between a second writer and a lost update.
 */
function stampOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class FileAdapter implements StorageAdapter {
  readonly id = 'file' as const;
  readonly label = 'Local file';

  /** The real file edits land on — symlinks resolved. */
  readonly path: string;

  /** The backup the last successful write left beside the record. */
  lastBackup = '';

  constructor(rawPath: string) {
    // Keeping the record as a symlink is legitimate. `renameSync` does not
    // follow one, so writing through the link would replace it with a regular
    // file and orphan the real record; resolve once and work on the target.
    let path = rawPath;
    try {
      path = realpathSync.native(rawPath);
    } catch {
      // No such file — `read` reports it in words.
    }
    this.path = path;
  }

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /**
   * One path, one document. Checked here rather than in the constructor so a
   * caller can still open a record-free tool (report_feedback) after typing a
   * path that turns out to be nonsense — which is exactly when they want it.
   */
  private only(fileName: string): void {
    if (fileName !== ROADMAP_FILE_NAME) {
      throw new StorageError(
        `The local file adapter holds ${ROADMAP_FILE_NAME}, not ${fileName}`,
        'Run this against the record file; other documents live in a cloud folder.',
      );
    }
    if (basename(this.path).includes('.bak-')) {
      throw new StorageError(
        `${this.path} is a backup, not the record`,
        'Edit the record itself — backups are rotated, so an edit here is pruned away.',
      );
    }
  }

  private bytes(): string {
    // A FIFO or a device node opens and then never ends. `readFileSync` would
    // hang forever on one, so what the path IS is checked before it is read.
    try {
      if (!statSync(this.path).isFile()) {
        throw new StorageError(
          `${this.path} is not a regular file`,
          'Give the path to your health-roadmap.json — a pipe or a device cannot hold a record.',
        );
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // No such file — reported below, in the same words as an unreadable one.
    }
    try {
      return readFileSync(this.path, 'utf8');
    } catch {
      throw new StorageError(
        `Cannot read ${this.path}`,
        'Give the path to your health-roadmap.json — see docs/agent-access.md for where each backend keeps it.',
      );
    }
  }

  async read(fileName: string): Promise<ReadResult> {
    this.only(fileName);
    const text = this.bytes();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StorageError(
        `${this.path} is not valid JSON`,
        'The file may be a partial write. Restore it from your cloud provider’s version history.',
      );
    }
    // A file that exists and holds `null` is not a fresh start: the document
    // spec reads a null body as "nobody has saved yet" and would hand back a
    // blank record, so a write would replace whatever this file really is.
    if (body === null) throw new RecordShapeError('it holds only null');
    return { body, version: stampOf(text) };
  }

  /**
   * Replace the record: re-read, refuse if it moved, keep a backup, then swap
   * the bytes atomically. The precondition is what makes a lost update
   * impossible — `SyncManager` catches the `ConflictError`, re-reads, re-merges
   * and tries again, so a second writer costs a retry rather than an edit.
   *
   * What is on disk right now needs no shape check: the version it is compared
   * against was returned by a `read()` the document spec has already vetted, so
   * bytes that still hash the same are the bytes that passed.
   */
  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    this.only(fileName);
    await this.lock();
    try {
      if (stampOf(this.bytes()) !== expectedVersion) {
        throw new ConflictError(`${this.path} changed since it was read`);
      }
      this.lastBackup = this.backup();
      const next = `${JSON.stringify(body, null, 2)}\n`;
      this.replace(next);
      return { version: stampOf(next) };
    } finally {
      rmSync(this.lockPath, { force: true });
    }
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Hold an exclusive lock file across the whole check-backup-replace, so two
   * writers cannot both pass the stale-bytes check on the same bytes and have
   * the second rename silently discard the first's edit. `wx` is one atomic
   * syscall — the kernel picks the winner — and the loser waits its turn and
   * then conflicts honestly on the bytes the winner left.
   */
  private async lock(): Promise<void> {
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, 'wx'));
        return;
      } catch (error) {
        // EEXIST is another writer holding it — everything else means we
        // cannot make a lock here at all (an unwritable folder), and waiting
        // five seconds to say so would be a stall on top of a failure.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new StorageError(
            `Cannot write beside ${this.path}`,
            'Check the folder is writable, then try again. Your record was not changed.',
          );
        }
        // A process killed mid-write leaves its lock behind; after ten seconds
        // nobody is coming back for it, and waiting forever helps no one.
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
        } catch {
          // Gone already — the next attempt takes it.
        }
        if (Date.now() > until) {
          throw new StorageError(
            `Another program is writing ${this.path} and did not finish`,
            'Nothing was changed. Try again in a moment; if it persists, delete the .lock file beside the record.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  /** Copy the record beside itself, then prune all but the newest few backups. */
  private backup(): string {
    // Two writes inside one millisecond share a timestamp, and the second copy
    // would silently overwrite the first backup — a rollback step lost.
    // Suffixes sort between their own millisecond and the next, so pruning
    // stays ordered.
    const now = new Date().toISOString();
    let dest = `${this.path}.bak-${now}`;
    for (let n = 2; existsSync(dest); n++) dest = `${this.path}.bak-${now}-${n}`;
    try {
      copyFileSync(this.path, dest);
    } catch {
      throw new StorageError(
        `Cannot write a backup beside ${this.path}`,
        'Check the folder is writable, then try again. Your record was not changed.',
      );
    }
    const folder = dirname(this.path);
    const prefix = `${basename(this.path)}.bak-`;
    const older = readdirSync(folder)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, -BACKUPS_KEPT);
    for (const name of older) rmSync(join(folder, name), { force: true });
    return basename(dest);
  }

  /**
   * Write a temp file in the same folder, then rename over the original, so a
   * failed write leaves the old file whole rather than half of the new one.
   * Honest limits: nothing here fsyncs, so a power cut can still lose bytes the
   * OS had not flushed, and a SIGKILL between the two calls leaves a `.tmp-`
   * sibling behind (harmless; the next run overwrites it).
   */
  private replace(text: string): void {
    const temp = `${this.path}.tmp-${process.pid}`;
    // Keep the record's own permissions. A fresh temp file takes the umask
    // default — usually 644 — which would widen a deliberately private 600
    // record the moment it was renamed into place.
    let mode = 0o600;
    try {
      mode = statSync(this.path).mode & 0o777;
    } catch {
      // No file yet; stay private.
    }
    try {
      writeFileSync(temp, text, { mode });
      chmodSync(temp, mode); // writeFileSync's mode is filtered by the umask
      renameSync(temp, this.path);
    } catch {
      throw new StorageError(
        `Cannot write ${this.path}`,
        'Check the file and its folder are writable. Your record was not changed.',
      );
    } finally {
      rmSync(temp, { force: true }); // a no-op once the rename has happened
    }
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The local file adapter does not read uploaded documents.');
  }

  async writeDocument(): Promise<void> {
    throw new StorageError('The local file adapter does not write uploaded documents.');
  }
}
