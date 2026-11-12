/**
 * Lead T1 step (a): pins of TODAY's local record write, as the CLI
 * (tools/edit-record.ts) and the stdio MCP server (tools/mcp-server.ts) meet
 * it — `recordSync(new FileAdapter(path)).save(...)`, then
 * `isStorageFailure` / `describeStorageFailure` on whatever it throws.
 *
 * Test-only. A pin named "today (lead T1 step b changes this)" records
 * behaviour the owner has ruled will change; step (b) flips exactly those.
 * US-31 AC8 / AC8a / US-32 AC6.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { FileAdapter } from './file-adapter';
import { createEmptyFile } from './roadmap-file';
import { recordSync } from './roadmap-doc';
import { describeStorageFailure, isStorageFailure } from './sync-manager';

const NOW = '2026-09-01T09:00:00.000Z';
const CTX = { deviceId: 't1_pins', now: NOW };

function scratch(content = JSON.stringify(createEmptyFile(CTX))): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'file-adapter-t1-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, content);
  return { dir, path };
}

const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes('.bak-')).sort();

/** A record at erase counter `epoch`, as the widget writes it after an erase. */
function at(epoch: number) {
  const file = createEmptyFile(CTX);
  return { ...file, meta: { ...file.meta, eraseEpoch: epoch } };
}

/** An empty record whose file counter is 7, so the bytes on disk show which body landed. */
function marked() {
  const file = createEmptyFile(CTX);
  return { ...file, meta: { ...file.meta, lamport: 7 } };
}

/** Wrap the adapter's private `replace` so the test sees the exact bytes it wrote. */
function recordReplace(adapter: object): { text: string } {
  const seen = { text: '' };
  const original = (adapter as any).replace.bind(adapter);
  vi.spyOn(adapter as any, 'replace').mockImplementation((...args: unknown[]) => {
    seen.text = args[0] as string;
    return original(...args);
  });
  return seen;
}

/** What `save` threw, or null when it resolved. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('lead T1 — cleanup after a landed replace', () => {
  it('pruneErased throwing after the replace: save resolves with a warning that copies from before the erase stayed, and the file holds the new bytes (US-31 AC8a)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const adapter = new FileAdapter(path);
    const wrote = recordReplace(adapter);
    const fault = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    vi.spyOn(adapter as any, 'pruneErased').mockImplementation(() => {
      throw fault;
    });
    try {
      const saved = await recordSync(adapter, CTX.deviceId, NOW).save(marked());
      expect(saved.warning).toBe(
        `${ROADMAP_FILE_NAME} was written, but cleanup did not finish: could not prune copies from before the erase. ` +
        'Copies from before the erase are still on disk; the next save removes them.',
      );
      // No error text and no folder: the warning names the step and the file only.
      expect(saved.warning).not.toMatch(/EACCES|permission|\//);
      // The replace landed: the record holds the bytes write produced.
      expect(JSON.parse(before).meta.lamport).toBe(0);
      expect(JSON.parse(wrote.text).meta.lamport).toBe(8); // save advances 7 by one
      expect(readFileSync(path, 'utf8')).toBe(wrote.text);
      // The finally still released the lock.
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rmSync(lockPath) throwing in the finally after the replace: save resolves with a warning that the lock file was left in place, and the file holds the new bytes (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    // `rmSync` is a named ESM import of node:fs, which vi.spyOn cannot
    // replace, so the module graph is reloaded over a mocked node:fs — the
    // same route file-adapter.test.ts takes for chmodSync.
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    const fault = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target).endsWith('.lock')) throw fault;
        return real.rmSync(target, options);
      },
    }));
    try {
      const { FileAdapter: Isolated } = await import('./file-adapter');
      const { recordSync: isolatedSync } = await import('./roadmap-doc');
      const adapter = new Isolated(path);
      const wrote = recordReplace(adapter);
      const saved = await isolatedSync(adapter, CTX.deviceId, NOW).save(marked());
      expect(saved.warning).toBe(
        `${ROADMAP_FILE_NAME} was written, but cleanup did not finish: could not remove the lock file. ` +
        `The lock file ${ROADMAP_FILE_NAME}.lock was left in place; remove it only when no other writer is running.`,
      );
      expect(saved.warning).not.toMatch(/EBUSY|busy|\//);
      expect(JSON.parse(before).meta.lamport).toBe(0);
      expect(JSON.parse(wrote.text).meta.lamport).toBe(8); // save advances 7 by one
      expect(readFileSync(path, 'utf8')).toBe(wrote.text);
      // The lock it could not remove is still there.
      expect(existsSync(`${path}.lock`)).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closeSync(lock) throwing in the finally after the replace: save resolves with a warning naming the close step, the file holds the new bytes and the lock is gone (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    const fault = Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    // Only the lock's descriptor fails to close; temp and backup files close normally.
    const lockFds = new Set<number>();
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      openSync: (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fd = real.openSync(target, flags, mode);
        if (String(target).endsWith('.lock')) lockFds.add(fd);
        return fd;
      },
      closeSync: (fd: number) => {
        if (lockFds.has(fd)) throw fault;
        return real.closeSync(fd);
      },
    }));
    try {
      const { FileAdapter: Isolated } = await import('./file-adapter');
      const { recordSync: isolatedSync } = await import('./roadmap-doc');
      const adapter = new Isolated(path);
      const wrote = recordReplace(adapter);
      const saved = await isolatedSync(adapter, CTX.deviceId, NOW).save(marked());
      expect(saved.warning).toBe(`${ROADMAP_FILE_NAME} was written, but cleanup did not finish: could not close the lock file.`);
      expect(saved.warning).not.toMatch(/EIO|\//);
      expect(JSON.parse(before).meta.lamport).toBe(0);
      expect(JSON.parse(wrote.text).meta.lamport).toBe(8); // save advances 7 by one
      expect(readFileSync(path, 'utf8')).toBe(wrote.text);
      // rmSync(lockPath) runs before closeSync, so the lock file is gone.
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      for (const fd of lockFds) real.closeSync(fd);
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('US-31 AC8a — nothing fails after the rename', () => {
  /** Reload file-adapter over a node:fs whose rmSync throws on the temp file. */
  async function tempRemovalThrows() {
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    const fault = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target).includes('.tmp-')) throw fault;
        return real.rmSync(target, options);
      },
    }));
    const { FileAdapter: Isolated } = await import('./file-adapter');
    const { recordSync: isolatedSync } = await import('./roadmap-doc');
    return { Isolated, isolatedSync };
  }

  it('a landed rename is a save: removing the temp file is never attempted, so its failure cannot reject (US-31 AC8a)', async () => {
    const { dir, path } = scratch();
    try {
      const { Isolated, isolatedSync } = await tempRemovalThrows();
      const adapter = new Isolated(path);
      const wrote = recordReplace(adapter);
      const saved = await isolatedSync(adapter, CTX.deviceId, NOW).save(marked());
      expect(saved.version).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.warning).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(wrote.text);
      expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed temp write whose temp file cannot be removed still reports the failure in words (US-31 AC8a)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    try {
      const { Isolated, isolatedSync } = await tempRemovalThrows();
      const adapter = new Isolated(path);
      const temp = (adapter as any).tempPath();
      vi.spyOn(adapter as any, 'tempPath').mockReturnValue(temp);
      fs.symlinkSync(join(dir, 'elsewhere.txt'), temp);
      const error = await failureOf(isolatedSync(adapter, CTX.deviceId, NOW).save(marked()));
      expect((error as Error).message).toBe(`Cannot write ${ROADMAP_FILE_NAME}`);
      expect((error as StorageError).hint).toBe('Check the file and its folder are writable. Your record was not changed.');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lead T1 — the backup trim runs after the replace', () => {
  it('with three backups and a failing replace, every old backup stays and the record is unchanged (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const old = ['2026-01-01T00-00-00.000Z', '2026-01-02T00-00-00.000Z', '2026-01-03T00-00-00.000Z']
      .map((stamp) => `${ROADMAP_FILE_NAME}.bak-${stamp}`);
    for (const name of old) writeFileSync(join(dir, name), before);

    const adapter = new FileAdapter(path);
    // A symlink planted at the temp name makes the real `create` refuse it,
    // so replace fails through its own code path.
    const temp = (adapter as any).tempPath();
    vi.spyOn(adapter as any, 'tempPath').mockReturnValue(temp);
    fs.symlinkSync(join(dir, 'elsewhere.txt'), temp);
    try {
      const error = await failureOf(recordSync(adapter, CTX.deviceId, NOW).save(createEmptyFile(CTX)));
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).message).toBe(`Cannot write ${ROADMAP_FILE_NAME}`);
      expect(isStorageFailure(error)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(before);
      // backup() made a fourth copy; the trim waits for a landed replace, so
      // all three old copies remain beside it.
      const kept = backups(dir);
      expect(kept).toHaveLength(4);
      expect(kept).toEqual(expect.arrayContaining(old));
      // lastBackup names this failed write's copy.
      expect(kept).toContain(adapter.lastBackup);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rmSync throwing on the trim: the replace has landed, save resolves with a warning naming the prune step, every backup stays and the lock is released (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const old = ['2026-01-01T00-00-00.000Z', '2026-01-02T00-00-00.000Z', '2026-01-03T00-00-00.000Z']
      .map((stamp) => `${ROADMAP_FILE_NAME}.bak-${stamp}`);
    for (const name of old) writeFileSync(join(dir, name), before);
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    const fault = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target).includes('.bak-')) throw fault;
        return real.rmSync(target, options);
      },
    }));
    try {
      const { FileAdapter: Isolated } = await import('./file-adapter');
      const { recordSync: isolatedSync } = await import('./roadmap-doc');
      const adapter = new Isolated(path);
      const wrote = recordReplace(adapter);
      const saved = await isolatedSync(adapter, CTX.deviceId, NOW).save(marked());
      expect(saved.warning).toBe(`${ROADMAP_FILE_NAME} was written, but cleanup did not finish: could not prune old backups.`);
      expect(saved.warning).not.toMatch(/EPERM|\//);
      expect(JSON.parse(wrote.text).meta.lamport).toBe(8); // save advances 7 by one
      expect(readFileSync(path, 'utf8')).toBe(wrote.text);
      // The trim failed on the oldest, so all three old copies remain beside
      // this write's new one, which holds the record's previous bytes.
      const kept = backups(dir);
      expect(kept).toHaveLength(4);
      expect(kept).toEqual(expect.arrayContaining(old));
      const fresh = kept.filter((name) => !old.includes(name));
      expect(fresh).toHaveLength(1);
      expect(readFileSync(join(dir, fresh[0]), 'utf8')).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lead T1 — a lock held by another writer', () => {
  /** Plant an old lock (mtime at the epoch), start a save, run out the wait. */
  async function refusedSave(path: string): Promise<{ error: unknown; waited: number }> {
    writeFileSync(`${path}.lock`, 'held by another writer');
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    const adapter = new FileAdapter(path);
    vi.useFakeTimers();
    const start = Date.now();
    const outcome = failureOf(recordSync(adapter, CTX.deviceId, NOW).save(marked()));
    await vi.runAllTimersAsync();
    const error = await outcome;
    return { error, waited: Date.now() - start };
  }

  it('refuses after the wait naming the lock file’s age, which the CLI and stdio server print as-is (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    try {
      const { error } = await refusedSave(path);
      // The lock's mtime is the epoch; the fake clock stands still after the wait.
      const days = Math.round(Date.now() / 86_400_000);
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).message).toBe(`Another program is writing ${ROADMAP_FILE_NAME} and did not finish`);
      expect((error as StorageError).hint).toBe(
        `The lock file ${ROADMAP_FILE_NAME}.lock is about ${days} days old. ` +
        'Nothing was changed. Retry later. If the lock persists, terminate all record writers before investigating it; never remove a lock while a writer might resume.',
      );
      expect(isStorageFailure(error)).toBe(true);
      // What the CLI and the stdio server print: the adapter's own words.
      expect(describeStorageFailure(error, 'The local record')).toEqual({
        message: (error as StorageError).message,
        hint: (error as StorageError).hint,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a recent lock’s age in minutes (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    try {
      writeFileSync(`${path}.lock`, 'held by another writer');
      const threeMinutesAgo = new Date(Date.now() - 3 * 60_000);
      utimesSync(`${path}.lock`, threeMinutesAgo, threeMinutesAgo);
      vi.useFakeTimers();
      const outcome = failureOf(recordSync(new FileAdapter(path), CTX.deviceId, NOW).save(marked()));
      await vi.runAllTimersAsync();
      const error = await outcome;
      // Three minutes old when planted, five seconds more after the wait.
      expect((error as StorageError).hint).toMatch(new RegExp(`^The lock file ${ROADMAP_FILE_NAME}\\.lock is about 3 minutes old\\. Nothing was changed\\.`));
      expect(existsSync(`${path}.lock`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says the lock’s age is unknown when its stat fails (lead T1 step b)', async () => {
    const { dir, path } = scratch();
    writeFileSync(`${path}.lock`, 'held by another writer');
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      lstatSync: (target: fs.PathLike, options?: fs.StatOptions) => {
        if (String(target).endsWith('.lock')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return real.lstatSync(target, options);
      },
    }));
    try {
      const { FileAdapter: Isolated } = await import('./file-adapter');
      const { recordSync: isolatedSync } = await import('./roadmap-doc');
      vi.useFakeTimers();
      const outcome = failureOf(isolatedSync(new Isolated(path), CTX.deviceId, NOW).save(marked()));
      await vi.runAllTimersAsync();
      const error = await outcome;
      expect((error as StorageError).message).toBe(`Another program is writing ${ROADMAP_FILE_NAME} and did not finish`);
      expect((error as StorageError).hint).toMatch(new RegExp(`^The age of the lock file ${ROADMAP_FILE_NAME}\\.lock is unknown\\. Nothing was changed\\.`));
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The refusal's hint for a lock whose mtime is `age` ms before the refusal.
   * Fake clock from T0: 25 ms retries end the wait at T0 + 5_025.
   */
  async function hintFor(path: string, age: number): Promise<string> {
    const T0 = Date.parse(NOW);
    vi.useFakeTimers({ now: T0 });
    writeFileSync(`${path}.lock`, 'held by another writer');
    const mtime = new Date(T0 + 5_025 - age);
    utimesSync(`${path}.lock`, mtime, mtime);
    const outcome = failureOf(recordSync(new FileAdapter(path), CTX.deviceId, NOW).save(marked()));
    await vi.runAllTimersAsync();
    return ((await outcome) as StorageError).hint ?? '';
  }

  it('picks the unit after rounding: 59.7 seconds is about 1 minute, 23.99 hours about 1 day (US-31 AC8a)', async () => {
    const { dir, path } = scratch();
    try {
      expect(await hintFor(path, 59_700)).toMatch(new RegExp(`^The lock file ${ROADMAP_FILE_NAME}\\.lock is about 1 minute old\\. `));
      vi.useRealTimers();
      expect(await hintFor(path, 23.99 * 3_600_000)).toMatch(new RegExp(`^The lock file ${ROADMAP_FILE_NAME}\\.lock is about 1 day old\\. `));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says the age is unknown when the lock’s mtime is in the future (US-31 AC8a)', async () => {
    const { dir, path } = scratch();
    try {
      expect(await hintFor(path, -3_600_000)).toMatch(new RegExp(`^The age of the lock file ${ROADMAP_FILE_NAME}\\.lock is unknown\\. Nothing was changed\\.`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits at least LOCK_WAIT_MS, never removes even an old lock, leaves the record alone and makes no backup', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    try {
      const { error, waited } = await refusedSave(path);
      expect(isStorageFailure(error)).toBe(true);
      // LOCK_WAIT_MS in file-adapter.ts (not exported).
      expect(waited).toBeGreaterThanOrEqual(5_000);
      expect(readFileSync(`${path}.lock`, 'utf8')).toBe('held by another writer');
      expect(fs.statSync(`${path}.lock`).mtimeMs).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(backups(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lead T1 — lastBackup after a save', () => {
  it('an erase save (epoch raised) leaves lastBackup empty and no backup', async () => {
    const { dir, path } = scratch(JSON.stringify(at(0)));
    try {
      const adapter = new FileAdapter(path);
      await recordSync(adapter, CTX.deviceId, NOW).save(at(1));
      expect(JSON.parse(readFileSync(path, 'utf8')).meta.eraseEpoch).toBe(1);
      expect(adapter.lastBackup).toBe('');
      expect(backups(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a normal save sets lastBackup to a file that exists beside the record', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    try {
      const adapter = new FileAdapter(path);
      await recordSync(adapter, CTX.deviceId, NOW).save(createEmptyFile(CTX));
      expect(adapter.lastBackup).not.toBe('');
      expect(backups(dir)).toEqual([adapter.lastBackup]);
      expect(readFileSync(join(dir, adapter.lastBackup), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
