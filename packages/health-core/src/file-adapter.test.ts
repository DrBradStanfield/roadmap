/**
 * US-31 AC8 / US-32 AC6 — the local write boundary.
 *
 * Everything the `edit-record` CLI and the stdio MCP server used to own
 * between them lives here now: a backup per write, an atomic replace, and a
 * changed-file precondition. What counts as a record at all is the document
 * spec's job, and is tested in roadmap-doc.test.ts against every adapter. The
 * shells above (edit-record.test.ts, mcp-server.test.ts) test the words; this
 * tests the bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, ROADMAP_FILE_NAME, StorageError } from './adapter';
import { BACKUPS_KEPT, FileAdapter } from './file-adapter';
import { createEmptyFile } from './roadmap-file';

const CTX = { deviceId: 'us31_io', now: '2026-09-01T09:00:00Z' };

function scratch(content = JSON.stringify(createEmptyFile(CTX))): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'file-adapter-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, content);
  return { dir, path };
}

const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes('.bak-'));

/** Read, then write back with the version that read returned. */
async function rewrite(adapter: FileAdapter, body: object): Promise<void> {
  const { version } = await adapter.read(ROADMAP_FILE_NAME);
  await adapter.write(ROADMAP_FILE_NAME, body, version);
}

describe('US-31 AC8 — a backup per write, the newest three kept', () => {
  it('keeps three and prunes the rest, newest last', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    for (let n = 1; n <= 5; n++) await rewrite(adapter, { ...createEmptyFile(CTX), schemaVersion: 1, count: n });

    const kept = backups(dir).sort();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.every((n) => n.startsWith(`${ROADMAP_FILE_NAME}.bak-`))).toBe(true);
    // The newest backup is the record one write ago: the fourth body, not the fifth.
    expect(JSON.parse(readFileSync(join(dir, kept.at(-1)!), 'utf8')).count).toBe(4);
    expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(5);
    expect(adapter.lastBackup).toBe(kept.at(-1));
    rmSync(dir, { recursive: true, force: true });
  });

  it('names each backup distinctly even when two writes land in the same millisecond', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    for (let n = 1; n <= 3; n++) await rewrite(adapter, { ...createEmptyFile(CTX), count: n });
    expect(new Set(backups(dir)).size).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  // Records saved before the colon-free rule left siblings carrying `:`, which
  // sorts after `-`, so a plain sort read an older colon name as the newest and
  // pruned a NEWER backup instead. Same instant, two separators: 09:00 must
  // still rank below 09-30.
  it('prunes the oldest when colon-named and dash-named siblings sit side by side', async () => {
    const { dir, path } = scratch();
    const named = (stamp: string, marker: string) => {
      writeFileSync(join(dir, `${ROADMAP_FILE_NAME}.bak-${stamp}`), JSON.stringify({ ...createEmptyFile(CTX), marker }));
      return `${ROADMAP_FILE_NAME}.bak-${stamp}`;
    };
    const oldest = named('2026-01-01T09:00:00.000Z', 'oldest');
    const middle = named('2026-01-01T09-30-00.000Z', 'middle');
    const newest = named('2026-01-02T00-00-00.000Z', 'newest');

    const adapter = new FileAdapter(path);
    await rewrite(adapter, createEmptyFile(CTX));

    const kept = backups(dir);
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept).toContain(middle);
    expect(kept).toContain(newest);
    expect(kept).toContain(adapter.lastBackup);
    expect(kept).not.toContain(oldest);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — a failed write leaves the record whole', () => {
  it('leaves no partial file and no temp sibling when the folder cannot be written', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const adapter = new FileAdapter(path);
    const { version } = await adapter.read(ROADMAP_FILE_NAME);
    chmodSync(dir, 0o500);
    try {
      await expect(adapter.write(ROADMAP_FILE_NAME, createEmptyFile(CTX), version)).rejects.toBeInstanceOf(StorageError);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual([ROADMAP_FILE_NAME]);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the record’s own permissions rather than widening them to the umask', async () => {
    const { dir, path } = scratch();
    chmodSync(path, 0o600);
    await rewrite(new FileAdapter(path), createEmptyFile(CTX));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — the record, and only the record', () => {
  it('reports a missing or unparseable file in words, and creates nothing', async () => {
    const { dir, path } = scratch();
    await expect(new FileAdapter(join(dir, 'absent.json')).read(ROADMAP_FILE_NAME)).rejects.toThrow(/Cannot read/);
    expect(existsSync(join(dir, 'absent.json'))).toBe(false);

    writeFileSync(path, '{ not json');
    await expect(new FileAdapter(path).read(ROADMAP_FILE_NAME)).rejects.toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a .bak sibling as a target, so rotation stays clean', async () => {
    const { dir, path } = scratch();
    const bak = `${path}.bak-2026-01-01T00:00:00.000Z`;
    writeFileSync(bak, readFileSync(path, 'utf8'));
    await expect(new FileAdapter(bak).read(ROADMAP_FILE_NAME)).rejects.toThrow(/backup/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('edits a symlinked record through the link, never replacing the link itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-'));
    const target = join(dir, 'real-record.json');
    const link = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(target, JSON.stringify(createEmptyFile(CTX)));
    symlinkSync(target, link);

    const adapter = new FileAdapter(link);
    expect(adapter.path).toContain('real-record.json');
    await rewrite(adapter, { ...createEmptyFile(CTX), marker: 'through the link' });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).marker).toBe('through the link');
    expect(backups(dir).every((n) => n.startsWith('real-record.json.bak-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — one path, one document', () => {
  it('refuses any file name but the record’s, rather than aiming at the same path', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    await expect(adapter.read('chat-history.json')).rejects.toBeInstanceOf(StorageError);
    await expect(adapter.write('chat-history.json', createEmptyFile(CTX), null)).rejects.toThrow(/chat-history\.json/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — a path that is not a file', () => {
  const hasMkfifo = spawnSync('which', ['mkfifo']).status === 0;

  it.skipIf(!hasMkfifo)('refuses a FIFO instead of waiting forever on a reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-'));
    const fifo = join(dir, ROADMAP_FILE_NAME);
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);

    // `readFileSync` on a FIFO with no writer never returns; the guard is what
    // keeps a mistyped path from hanging the CLI or the MCP server forever.
    await expect(new FileAdapter(fifo).read(ROADMAP_FILE_NAME)).rejects.toThrow(/not a regular file/);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});

describe('US-31 AC8 / US-32 AC6 — the changed-file precondition', () => {
  it('refuses a write whose expectedVersion is stale, with a ConflictError SyncManager can retry', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    const { version } = await adapter.read(ROADMAP_FILE_NAME);

    // Another writer, mid-run. Same length, same millisecond is possible — the
    // stamp is a content hash, so an equal-size edit is still caught.
    writeFileSync(path, JSON.stringify({ ...createEmptyFile(CTX), tag: 'other device' }));
    await expect(adapter.write(ROADMAP_FILE_NAME, createEmptyFile(CTX), version)).rejects.toBeInstanceOf(ConflictError);
    expect(JSON.parse(readFileSync(path, 'utf8')).tag).toBe('other device');
    expect(backups(dir)).toEqual([]);

    // Re-read and the same write goes through — which is what the retry does.
    await rewrite(adapter, { ...createEmptyFile(CTX), tag: 'ours' });
    expect(JSON.parse(readFileSync(path, 'utf8')).tag).toBe('ours');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the version of the bytes it wrote, so a second write needs no re-read', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    const first = await adapter.read(ROADMAP_FILE_NAME);
    const { version } = await adapter.write(ROADMAP_FILE_NAME, { ...createEmptyFile(CTX), n: 1 }, first.version);
    await expect(adapter.write(ROADMAP_FILE_NAME, { ...createEmptyFile(CTX), n: 2 }, version)).resolves.toBeTruthy();
    expect(JSON.parse(readFileSync(path, 'utf8')).n).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('US-31 AC8 / US-32 AC6 — locks do not expire while an owner can resume', () => {
  it('does not steal an aged lock from a live writer before publication', async () => {
    const { dir, path } = scratch();
    const a = new FileAdapter(path);
    const b = new FileAdapter(path);
    const initial = await a.read(ROADMAP_FILE_NAME);
    // Hold A at the existing synchronous backup seam, then let B contend.
    const originalBackup = (a as any).backup.bind(a);
    let competing!: Promise<unknown>;
    vi.useFakeTimers();
    vi.spyOn(a as any, 'backup').mockImplementation((...args: unknown[]) => {
      const old = new Date(Date.now() - 11_000);
      utimesSync(`${path}.lock`, old, old);
      competing = b.write(ROADMAP_FILE_NAME, { writer: 'B' }, initial.version);
      // Attach immediately so a rejected promise is never unhandled.
      void competing.catch(() => {});
      expect(existsSync(`${path}.lock`)).toBe(true);
      return originalBackup(...args);
    });
    try {
      await a.write(ROADMAP_FILE_NAME, { writer: 'A' }, initial.version);
      await vi.runAllTimersAsync();
      await expect(competing).rejects.toBeInstanceOf(ConflictError);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ writer: 'A' });
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on abandoned or unidentifiable locks regardless of age', async () => {
    const { dir, path } = scratch();
    const a = new FileAdapter(path);
    const initial = await a.read(ROADMAP_FILE_NAME);
    writeFileSync(`${path}.lock`, '');
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    vi.useFakeTimers();
    try {
      const pending = a.write(ROADMAP_FILE_NAME, { writer: 'A' }, initial.version);
      const outcome = pending.then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toBeInstanceOf(StorageError);
      expect((await a.read(ROADMAP_FILE_NAME)).version).toBe(initial.version);
      expect(existsSync(`${path}.lock`)).toBe(true);
      expect(backups(dir)).toEqual([]);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses publication and never removes a foreign lock after ownership is lost', async () => {
    const { dir, path } = scratch();
    const a = new FileAdapter(path);
    const initial = await a.read(ROADMAP_FILE_NAME);
    vi.spyOn(a as any, 'backup').mockImplementation((...args: unknown[]) => {
      rmSync(`${path}.lock`);
      writeFileSync(`${path}.lock`, 'another owner');
      writeFileSync(path, JSON.stringify({ writer: 'B' }));
      return '';
    });
    try {
      await expect(a.write(ROADMAP_FILE_NAME, { writer: 'A' }, initial.version)).rejects.toBeInstanceOf(StorageError);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ writer: 'B' });
      expect(readFileSync(`${path}.lock`, 'utf8')).toBe('another owner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('US-31 AC8 — backups do not outlive an erase', () => {
  /** A record, with the erase counter the widget bumps when the user erases. */
  const at = (epoch: number, extra: object = {}) => {
    const file = createEmptyFile(CTX);
    return JSON.stringify({ ...file, ...extra, meta: { ...file.meta, eraseEpoch: epoch } });
  };

  it('removes every backup made before the record’s erase epoch, and keeps the rest', async () => {
    const { dir, path } = scratch(at(1));
    // Two backups from before the erase — one of them without the counter at
    // all, which is what a record written before the feature existed looks
    // like — and one from after it.
    writeFileSync(join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`), at(0));
    writeFileSync(join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-02T00-00-00.000Z`), JSON.stringify(createEmptyFile(CTX)));
    writeFileSync(join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-03T00-00-00.000Z`), at(1));

    await rewrite(new FileAdapter(path), JSON.parse(at(1, { marker: 'after' })));

    const kept = backups(dir).sort();
    // The write's own backup (a copy of the epoch-1 record) plus the epoch-1 sibling.
    expect(kept).toHaveLength(2);
    expect(kept).toContain(`${ROADMAP_FILE_NAME}.bak-2026-01-03T00-00-00.000Z`);
    for (const name of kept) {
      expect(JSON.parse(readFileSync(join(dir, name), 'utf8')).meta.eraseEpoch).toBe(1);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a sibling it cannot read as a record rather than guessing', async () => {
    const { dir, path } = scratch(at(2));
    const junk = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    writeFileSync(junk, 'not json at all');
    await rewrite(new FileAdapter(path), JSON.parse(at(2)));
    expect(existsSync(junk)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // The write's own backup is a copy of the PRE-erase record, so the prune
  // below deletes it moments after it is made. It was still named in
  // `lastBackup`, and the CLI and the MCP server told the user to look for a
  // file that no longer existed.
  it('makes no backup at all on the write that raises the erase epoch', async () => {
    const { dir, path } = scratch(at(0));
    const stale = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    writeFileSync(stale, at(0));

    const adapter = new FileAdapter(path);
    await rewrite(adapter, JSON.parse(at(1)));

    expect(backups(dir)).toEqual([]);
    expect(adapter.lastBackup).toBe('');
    expect(existsSync(stale)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still backs up a write that leaves the erase epoch where it is', async () => {
    const { dir, path } = scratch(at(2));
    const adapter = new FileAdapter(path);
    await rewrite(adapter, JSON.parse(at(2, { marker: 'after' })));
    expect(adapter.lastBackup).not.toBe('');
    expect(backups(dir)).toEqual([adapter.lastBackup]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every backup while the record has never been erased', async () => {
    const { dir, path } = scratch();
    const old = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    writeFileSync(old, JSON.stringify(createEmptyFile(CTX)));
    await rewrite(new FileAdapter(path), createEmptyFile(CTX));
    expect(existsSync(old)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — the temp and backup siblings cannot be pre-planted', () => {
  it('names the temp file unpredictably, never after the process id, and leaves none behind', async () => {
    const { dir, path } = scratch();
    const adapter = new FileAdapter(path);
    const first = (adapter as any).tempPath();
    const second = (adapter as any).tempPath();
    expect(first).not.toBe(second);
    expect(first).not.toBe(`${path}.tmp-${process.pid}`);
    await rewrite(adapter, { ...createEmptyFile(CTX), n: 1 });
    expect(readdirSync(dir).some((n) => n.includes('.tmp-'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the write rather than following a symlink planted at the temp path', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');

    const adapter = new FileAdapter(path);
    const temp = (adapter as any).tempPath();
    vi.spyOn(adapter as any, 'tempPath').mockReturnValue(temp);
    symlinkSync(victim, temp);

    const { version } = await adapter.read(ROADMAP_FILE_NAME);
    await expect(adapter.write(ROADMAP_FILE_NAME, createEmptyFile(CTX), version)).rejects.toBeInstanceOf(StorageError);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readFileSync(path, 'utf8')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the backup rather than following a symlink planted at the backup path', async () => {
    const { dir, path } = scratch();
    const before = readFileSync(path, 'utf8');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');

    const adapter = new FileAdapter(path);
    const dest = join(dir, `${ROADMAP_FILE_NAME}.bak-planted`);
    vi.spyOn(adapter as any, 'backupPath').mockReturnValue(dest);
    symlinkSync(victim, dest);

    const { version } = await adapter.read(ROADMAP_FILE_NAME);
    await expect(adapter.write(ROADMAP_FILE_NAME, createEmptyFile(CTX), version)).rejects.toBeInstanceOf(StorageError);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readFileSync(path, 'utf8')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names backups without a colon, so a Windows record can be saved at all', async () => {
    const { dir, path } = scratch();
    await rewrite(new FileAdapter(path), createEmptyFile(CTX));
    const [name] = backups(dir);
    expect(name).toBeDefined();
    expect(name).not.toContain(':');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — the record and its copies stay private', () => {
  it('creates a fresh record and its backups owner-only', async () => {
    const { dir, path } = scratch();
    chmodSync(path, 0o600);
    await rewrite(new FileAdapter(path), createEmptyFile(CTX));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const name of backups(dir)) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('narrows a record left readable by everyone rather than copying that mode forward', async () => {
    const { dir, path } = scratch();
    chmodSync(path, 0o644);
    await rewrite(new FileAdapter(path), createEmptyFile(CTX));
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(path).mode & 0o700).toBe(0o600);
    for (const name of backups(dir)) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // The narrowing chmod is a courtesy: the temp file is created at the narrowed
  // mode and the rename replaces the record with it. A record the user cannot
  // chmod threw a raw EPERM carrying the absolute path instead of saving.
  it('saves a record it cannot chmod, rather than failing with the path in the error', async () => {
    const { dir, path } = scratch();
    chmodSync(path, 0o644);
    vi.resetModules();
    const real = await vi.importActual<typeof fs>('node:fs');
    let refused = 0;
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      chmodSync: () => {
        refused += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: 'EPERM' });
      },
    }));
    try {
      const { FileAdapter: Isolated } = await import('./file-adapter');
      await rewrite(new Isolated(path), { ...createEmptyFile(CTX), marker: 'saved' });
      expect(refused).toBe(1);
      expect(JSON.parse(readFileSync(path, 'utf8')).marker).toBe('saved');
      // The rename put a file created at the narrowed mode in its place.
      expect(statSync(path).mode & 0o077).toBe(0);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('US-31 AC8 — failures name the record, not where it lives', () => {
  it('keeps the absolute path out of every message the assistant reads out', async () => {
    const { dir, path } = scratch('{ not json');
    const adapter = new FileAdapter(path);
    const said = await adapter.read(ROADMAP_FILE_NAME).then(() => '', (e: Error) => `${e.message} ${(e as StorageError).hint ?? ''}`);
    expect(said).toContain(ROADMAP_FILE_NAME);
    expect(said).not.toContain(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
