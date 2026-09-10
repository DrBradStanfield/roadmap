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
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, type ReadResult, type StorageAdapter, type WriteResult } from './adapter';
import { RecordShapeError } from './migrate';

/** How many `.bak-` siblings to keep beside the record. */
export const BACKUPS_KEPT = 3;

/** Contention timings. A paused writer never loses its lock because of age. */
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5_000;

/**
 * The bytes on disk, as a value that changes whenever they do. A content hash
 * rather than mtime+size: two writes inside one millisecond that keep the file
 * the same length are indistinguishable by stat, and this guard is the only
 * thing standing between a second writer and a lost update.
 */
function stampOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The record's erase counter. Absent, or not a number, counts as never erased. */
function epochOf(body: unknown): number {
  const epoch = (body as { meta?: { eraseEpoch?: unknown } } | null)?.meta?.eraseEpoch;
  return typeof epoch === 'number' ? epoch : 0;
}

/**
 * Create `dest` and write `text` to it. `wx` refuses to open anything that
 * already exists, so a symlink planted at the name fails the write instead of
 * carrying the record's bytes to wherever it points; `fsync` is what makes the
 * rename that follows worth doing.
 */
function create(dest: string, text: string, mode: number): void {
  const fd = openSync(dest, 'wx', mode);
  try {
    // One `writeSync` may write only part of a large buffer, and the rest
    // would be lost silently — a truncated record renamed over a whole one.
    const bytes = Buffer.from(text, 'utf8');
    for (let done = 0; done < bytes.length; ) {
      done += writeSync(fd, bytes, done, bytes.length - done);
    }
    fchmodSync(fd, mode); // the open mode is filtered by the umask
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
        `${basename(this.path)} is a backup, not the record`,
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
          `${basename(this.path)} is not a regular file`,
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
        `Cannot read ${basename(this.path)}`,
        'Give the path to your health-roadmap.json — see docs/agent-access.md for where each backend keeps it.',
      );
    }
  }

  async read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    signal?.throwIfAborted();
    this.only(fileName);
    const text = this.bytes();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StorageError(
        `${basename(this.path)} is not valid JSON`,
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
  async write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    signal?.throwIfAborted();
    this.only(fileName);
    const lock = await this.lock();
    try {
      const current = this.bytes();
      if (stampOf(current) !== expectedVersion) {
        throw new ConflictError(`${basename(this.path)} changed since it was read`);
      }
      const mode = this.mode();
      // An erase raises the counter, and `pruneErased` below deletes every
      // copy that predates it — including the one this write would have just
      // made. Making it and then removing it left `lastBackup` naming a file
      // that no longer exists, so the CLI and the MCP server both told the
      // user to look for it. Erase means no backups left (US-31 AC8).
      const erasing = epochOf(body) > epochOf(this.parsed(current));
      this.lastBackup = erasing ? '' : this.backup(current, mode);
      const next = `${JSON.stringify(body, null, 2)}\n`;
      if (!this.ownsLock(lock)) {
        throw new StorageError(
          'The local record lock changed during the write',
          'The write was stopped. Close all record writers and investigate the lock before retrying.',
        );
      }
      this.replace(next, mode);
      this.pruneErased(body);
      return { version: stampOf(next) };
    } finally {
      try {
        if (this.ownsLock(lock)) rmSync(this.lockPath);
      } finally {
        closeSync(lock);
      }
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
  private async lock(): Promise<number> {
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        // Keep the descriptor open so an unlinked lock's inode cannot be reused.
        return openSync(this.lockPath, 'wx', 0o600);
      } catch (error) {
        // EEXIST is another writer holding it — everything else means we
        // cannot make a lock here at all (an unwritable folder), and waiting
        // five seconds to say so would be a stall on top of a failure.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new StorageError(
            `Cannot write beside ${basename(this.path)}`,
            'Check the folder is writable, then try again. Your record was not changed.',
          );
        }
        // Age cannot distinguish a crashed process from a suspended one. Never
        // steal a lock: PID checks also cannot prove ownership across machines
        // or PID reuse, and competing reclaimers introduce another unlink race.
        if (Date.now() > until) {
          throw new StorageError(
            `Another program is writing ${basename(this.path)} and did not finish`,
            'Nothing was changed. Retry later. If the lock persists, terminate all record writers before investigating it; never remove a lock while a writer might resume.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  /**
   * Cooperative writers on one local filesystem never replace an owned lock.
   * Identity checks also refuse an already replaced lock. They are not fencing
   * against old clients, external lock deletion, or cloud/network filesystems.
   * Orphan recovery requires exclusive offline access; it is not automated.
   */
  private ownsLock(fd: number): boolean {
    try {
      const held = fstatSync(fd);
      const current = lstatSync(this.lockPath);
      return current.isFile() && held.dev === current.dev && held.ino === current.ino;
    } catch {
      return false;
    }
  }

  /**
   * The record's own permissions, narrowed to its owner. A record left group-
   * or world-readable is health data anyone with an account on the machine can
   * read; every copy this class makes takes the same mode, so widening it once
   * would widen the backups too.
   */
  private mode(): number {
    let mode: number;
    try {
      mode = statSync(this.path).mode & 0o777;
    } catch {
      return 0o600; // No file yet; stay private.
    }
    if (mode & 0o077) {
      mode &= 0o700;
      // Best effort, and never fatal: the copies this write creates are made
      // at the narrowed mode and the rename replaces the original with one of
      // them, so a record the user cannot chmod (someone else's file, a mount
      // that refuses it) still ends up private. Left uncaught it threw a raw
      // EPERM carrying the absolute path.
      try {
        chmodSync(this.path, mode);
      } catch {
        // The rename does the narrowing.
      }
    }
    return mode;
  }

  /** The record as JSON, or null when the bytes are not JSON at all. */
  private parsed(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Where this write's backup goes. Overridable seam for the symlink test. */
  private backupPath(): string {
    // Two writes inside one millisecond share a timestamp, and the second copy
    // would silently overwrite the first backup — a rollback step lost.
    // Suffixes sort between their own millisecond and the next, so pruning
    // stays ordered. No colons: Windows cannot create such a name at all, so
    // an ISO timestamp straight from `toISOString` fails every save there.
    const now = new Date().toISOString().replace(/:/g, '-');
    let dest = `${this.path}.bak-${now}`;
    for (let n = 2; existsSync(dest); n++) dest = `${this.path}.bak-${now}-${n}`;
    return dest;
  }

  /** Copy the record beside itself, then prune all but the newest few backups. */
  private backup(text: string, mode: number): string {
    const dest = this.backupPath();
    try {
      // Create it, rather than copy onto it: a `.bak-` name planted as a
      // symlink would otherwise take the record's bytes wherever it points.
      create(dest, text, mode);
    } catch {
      throw new StorageError(
        `Cannot write a backup beside ${basename(this.path)}`,
        'Check the folder is writable, then try again. Your record was not changed.',
      );
    }
    // Backups named before the colon-free rule carry `:` (0x3A), which sorts
    // AFTER `-` (0x2D), so a plain sort reads an older colon name as the
    // newest and prunes a newer one instead. Compare on a normalised key.
    const key = (name: string) => name.replace(/:/g, '-');
    const order = (a: string, b: string) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    for (const name of this.siblings().sort(order).slice(0, -BACKUPS_KEPT)) {
      rmSync(join(dirname(this.path), name), { force: true });
    }
    return basename(dest);
  }

  /** Every `.bak-` sibling of the record, by name. */
  private siblings(): string[] {
    const prefix = `${basename(this.path)}.bak-`;
    return readdirSync(dirname(this.path)).filter((name) => name.startsWith(prefix));
  }

  /**
   * Erasing the record bumps `meta.eraseEpoch`, and the widget that did it
   * cannot reach these backups: rotation alone would keep the erased data for
   * three more writes, or forever on a record nobody writes again. So every
   * write drops the copies that predate the current epoch. A sibling that does
   * not read as a record is somebody else's file — it stays.
   */
  private pruneErased(body: object): void {
    const epoch = epochOf(body);
    if (epoch <= 0) return;
    for (const name of this.siblings()) {
      const file = join(dirname(this.path), name);
      let meta: unknown;
      try {
        meta = (JSON.parse(readFileSync(file, 'utf8')) as { meta?: unknown } | null)?.meta;
      } catch {
        continue;
      }
      if (typeof meta !== 'object' || meta === null) continue;
      // A backup from before the counter existed has no epoch at all: that is
      // exactly the pre-erase copy, so absent counts as zero.
      const was = (meta as { eraseEpoch?: unknown }).eraseEpoch;
      if ((typeof was === 'number' ? was : 0) < epoch) rmSync(file, { force: true });
    }
  }

  /** Where this write's temp file goes. Overridable seam for the symlink test. */
  private tempPath(): string {
    // Unguessable, so nothing can be waiting at the name we are about to
    // create — the pid is public and reused.
    return `${this.path}.tmp-${randomBytes(8).toString('hex')}`;
  }

  /**
   * Write a temp file in the same folder, then rename over the original, so a
   * failed write leaves the old file whole rather than half of the new one.
   * Honest limit: a SIGKILL between the two calls leaves a `.tmp-` sibling
   * behind (harmless, and .gitignored).
   */
  private replace(text: string, mode: number): void {
    const temp = this.tempPath();
    try {
      create(temp, text, mode);
      renameSync(temp, this.path);
    } catch {
      throw new StorageError(
        `Cannot write ${basename(this.path)}`,
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
