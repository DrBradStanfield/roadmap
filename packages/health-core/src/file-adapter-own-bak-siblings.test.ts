/**
 * US-31 AC8b: the backup trim rotates only the copies it made.
 *
 * A person may keep their own file beside the record under a `.bak-` name
 * (`health-roadmap.json.bak-original`, a notes file, a folder). Rotation counts
 * only names that end in the tool's own time stamp and keeps the newest three
 * of those. Every other sibling stays, as the erase prune leaves a non-record.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROADMAP_FILE_NAME } from './adapter';
import { BACKUPS_KEPT, FileAdapter } from './file-adapter';
import { createEmptyFile } from './roadmap-file';

const CTX = { deviceId: 'us31_own_bak', now: '2026-09-01T09:00:00Z' };

function scratch(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'file-adapter-own-bak-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(createEmptyFile(CTX)));
  return { dir, path };
}

/** Read, then write back; returns what the write reported. */
async function rewrite(adapter: FileAdapter, count: number) {
  const { version } = await adapter.read(ROADMAP_FILE_NAME);
  return adapter.write(ROADMAP_FILE_NAME, { ...createEmptyFile(CTX), count }, version);
}

const stamped = (dir: string) => readdirSync(dir).filter((n) => /\.bak-\d{4}-\d{2}-\d{2}T/.test(n));

describe('US-31 AC8b: the trim leaves .bak- siblings it did not make', () => {
  it('keeps the backup a write names when the person has copies that sort after it', async () => {
    const { dir, path } = scratch();
    const own = ['manual', 'original', 'before-import'].map((s) => join(dir, `${ROADMAP_FILE_NAME}.bak-${s}`));
    for (const file of own) writeFileSync(file, JSON.stringify(createEmptyFile(CTX)));
    const adapter = new FileAdapter(path);
    const result = await rewrite(adapter, 1);

    expect(result.warning).toBeUndefined();
    expect(adapter.lastBackup).not.toBe('');
    expect(existsSync(join(dir, adapter.lastBackup))).toBe(true);
    expect(own.every((file) => existsSync(file))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a notes file that is not a record in place across rotations', async () => {
    const { dir, path } = scratch();
    const note = join(dir, `${ROADMAP_FILE_NAME}.bak-1-notes.txt`);
    writeFileSync(note, 'my own notes, not a record');
    const adapter = new FileAdapter(path);
    for (let n = 1; n <= BACKUPS_KEPT + 2; n++) await rewrite(adapter, n);

    expect(readFileSync(note, 'utf8')).toBe('my own notes, not a record');
    expect(stamped(dir)).toHaveLength(BACKUPS_KEPT);
    rmSync(dir, { recursive: true, force: true });
  });

  // The name shape both ways: a same-millisecond `-n` backup rotates out, and a
  // backup name with more after it (a copy renamed to open as JSON) stays.
  it('rotates the -n backups it made and keeps a backup name with an ending added', async () => {
    const { dir, path } = scratch();
    const old = ['', '-2', '-3'].map((n) => `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z${n}`);
    for (const name of old) writeFileSync(join(dir, name), JSON.stringify(createEmptyFile(CTX)));
    const copy = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z.json`);
    writeFileSync(copy, JSON.stringify(createEmptyFile(CTX)));
    const adapter = new FileAdapter(path);
    for (let n = 1; n <= BACKUPS_KEPT; n++) await rewrite(adapter, n);

    expect(old.filter((name) => existsSync(join(dir, name)))).toEqual([]);
    expect(existsSync(copy)).toBe(true);
    expect(existsSync(join(dir, adapter.lastBackup))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // A folder, not a file: removing it threw first, so rotation stopped.
  it('keeps rotating, with no cleanup warning, when a folder sits at a .bak- name', async () => {
    const { dir, path } = scratch();
    const folder = join(dir, `${ROADMAP_FILE_NAME}.bak-0-archive`);
    mkdirSync(folder);
    const adapter = new FileAdapter(path);
    const warnings: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const { warning } = await rewrite(adapter, n);
      if (warning) warnings.push(warning);
    }

    expect(warnings).toEqual([]);
    expect(stamped(dir)).toHaveLength(BACKUPS_KEPT);
    expect(existsSync(folder)).toBe(true);
    // The newest kept backup is the record one write ago.
    expect(JSON.parse(readFileSync(join(dir, adapter.lastBackup), 'utf8')).count).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });
});
