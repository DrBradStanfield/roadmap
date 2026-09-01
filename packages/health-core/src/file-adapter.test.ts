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
import { describe, it, expect } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
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
