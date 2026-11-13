/**
 * US-31 AC8c: a `.bak-` sibling that is not a regular file.
 *
 * Every write to a record that has been erased reads each `.bak-` sibling to
 * see whether it predates the erase. A pipe or a device at such a name opens
 * and then never ends, so a read of it would hang the writer after the
 * rename, with the lock still held and nothing said about the write that
 * landed.
 *
 * The first cases run the CLI as a real subprocess: a read that never returns
 * would block this test process too, so a child with a timeout is what lets
 * them fail. The last ones watch the adapter's own reads in this process.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as fs from 'node:fs';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROADMAP_FILE_NAME } from './adapter';
import { createEmptyFile } from './roadmap-file';

const CTX = { deviceId: 'us31_bak_pipe', now: '2026-09-01T09:00:00Z' };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The loader, not tsx's own CLI: that runs the script in a second node, which
// a timeout's SIGKILL would leave behind, still blocked.
const TSX = createRequire(import.meta.url).resolve('tsx');
const hasMkfifo = spawnSync('which', ['mkfifo']).status === 0;

/** A record at erase counter `epoch`, as the widget writes it after an erase. */
const at = (epoch: number, extra: object = {}) => {
  const file = createEmptyFile(CTX);
  return JSON.stringify({ ...file, ...extra, meta: { ...file.meta, eraseEpoch: epoch } });
};

/** Run `tools/edit-record.ts` over the record, as a user would. */
function editRecord(args: string[]) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(TSX).href, join(REPO_ROOT, 'tools/edit-record.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
}

describe('US-31 AC8c: a pipe named like a backup beside an erased record', () => {
  it.skipIf(!hasMkfifo)('finishes the write, says it landed and releases the lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-bak-pipe-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, at(1));
    const pipe = join(dir, `${ROADMAP_FILE_NAME}.bak-other`);
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);

    const child = editRecord(['add', path, '--metric', 'weight', '--value', '81', '--date', '2026-08-14']);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const lockLeft = existsSync(`${path}.lock`);
    const pipeKept = lstatSync(pipe).isFIFO();
    rmSync(dir, { recursive: true, force: true });

    expect(saved.measurements).toEqual([expect.objectContaining({ metricType: 'weight', value: 81 })]);
    expect({ status: child.status, signal: child.signal, lockLeft, pipeKept }).toEqual({ status: 0, signal: null, lockLeft: false, pipeKept: true });
    expect(child.stdout).toMatch(/^Added weight/);
  }, 30_000);

  it.skipIf(!hasMkfifo)('still removes the pre-erase backups around it, on a lab write at a later epoch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-bak-pipe-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, at(3));
    // Named exactly as a real backup is, and sorted between two real ones.
    const pipe = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-02T00-00-00.000Z`);
    const before = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    const after = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-03T00-00-00.000Z`);
    writeFileSync(before, at(2));
    writeFileSync(after, at(3));
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);

    const child = editRecord(['add', path, '--test', 'Ferritin', '--value', '210', '--unit', 'µg/L', '--date', '2026-08-25']);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const lockLeft = existsSync(`${path}.lock`);
    const names = readdirSync(dir);
    rmSync(dir, { recursive: true, force: true });

    expect(saved.labValues).toEqual([expect.objectContaining({ metricName: 'ferritin', value: 210 })]);
    expect({ status: child.status, signal: child.signal, lockLeft }).toEqual({ status: 0, signal: null, lockLeft: false });
    expect(child.stdout).toMatch(/^Added ferritin/);
    expect(child.stderr).toBe('');
    expect(names).not.toContain(`${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    expect(names).toEqual(expect.arrayContaining([
      `${ROADMAP_FILE_NAME}.bak-2026-01-02T00-00-00.000Z`,
      `${ROADMAP_FILE_NAME}.bak-2026-01-03T00-00-00.000Z`,
    ]));
  }, 30_000);
});

describe('US-31 AC8c: the prune reads only a regular file, and reads the one it checked', () => {
  type Fn = (...args: any[]) => any;

  /**
   * One write at erase counter 2, through an adapter whose `node:fs` refuses
   * any read of something that is not a regular file, and any open of a pipe
   * that would wait for a writer. Either would never return, so it is noted
   * and refused rather than run. It also counts what it left open on a
   * backup's name. `swap.run` is called once, right after the adapter first
   * touches the name `swap.at`, as another program might.
   */
  async function watchedWrite(path: string, swap?: { at: string; run: () => void }) {
    const real = await vi.importActual<typeof fs>('node:fs');
    const stuck: string[] = [];
    let swapped = false;
    const leftOpen = new Set<number>();
    const kind = (target: unknown) => {
      try {
        return typeof target === 'number' ? real.fstatSync(target) : real.statSync(target as string);
      } catch {
        return null; // the real call reports it
      }
    };
    const watch = (name: 'lstatSync' | 'statSync' | 'openSync' | 'readFileSync', blocks: (args: any[]) => boolean): Fn => (...args) => {
      if (blocks(args)) {
        stuck.push(`${name} ${typeof args[0] === 'number' ? 'a descriptor' : basename(String(args[0]))}`);
        throw new Error(`${name} would never return here`);
      }
      const out = (real[name] as Fn)(...args);
      // By name: the adapter holds the folder's real path, not the temp alias.
      if (swap && !swapped && typeof args[0] === 'string' && basename(args[0]) === basename(swap.at)) {
        swapped = true;
        swap.run();
      }
      return out;
    };
    const open = watch('openSync', ([target, flags]) =>
      (typeof flags !== 'number' || !(flags & real.constants.O_NONBLOCK)) && !!kind(target)?.isFIFO());
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...real,
      default: real,
      lstatSync: watch('lstatSync', () => false),
      statSync: watch('statSync', () => false),
      openSync: (...args: any[]) => {
        const fd = open(...args);
        if (basename(String(args[0])).includes('.bak-')) leftOpen.add(fd);
        return fd;
      },
      closeSync: (fd: number) => {
        leftOpen.delete(fd);
        real.closeSync(fd);
      },
      readFileSync: watch('readFileSync', ([target]) => kind(target)?.isFile() === false),
    }));
    try {
      const { FileAdapter } = await import('./file-adapter');
      const adapter = new FileAdapter(path);
      const { version } = await adapter.read(ROADMAP_FILE_NAME);
      await adapter.write(ROADMAP_FILE_NAME, JSON.parse(at(2, { marker: 'saved' })), version);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
    return { stuck, swapped, leftOpen: leftOpen.size };
  }

  it.skipIf(!hasMkfifo)('never reads a pipe, a device or a folder, and still removes pre-erase copies and links to them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-bak-kinds-'));
    const aside = mkdtempSync(join(tmpdir(), 'file-adapter-bak-aside-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    // The write raises the counter from 1 to 2, so it trims nothing: only the
    // prune decides which of these stay.
    writeFileSync(path, at(1));
    const bak = (stamp: string) => join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-0${stamp}T00-00-00.000Z`);
    expect(spawnSync('mkfifo', [bak('1')]).status).toBe(0);
    symlinkSync('/dev/zero', bak('2'));
    mkdirSync(bak('3'));
    writeFileSync(bak('4'), at(1));
    // A link to a pre-erase copy is followed, as before: the link goes, the copy it names stays.
    writeFileSync(join(aside, 'copy'), at(1));
    symlinkSync(join(aside, 'copy'), bak('5'));

    const { stuck, leftOpen } = await watchedWrite(path);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const kept = ['1', '2', '3', '4', '5'].map((s) => lstatSync(bak(s), { throwIfNoEntry: false }) !== undefined);
    const targetKept = existsSync(join(aside, 'copy'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });

    expect({ stuck, leftOpen }).toEqual({ stuck: [], leftOpen: 0 });
    expect(saved.marker).toBe('saved');
    expect({ kept, targetKept }).toEqual({ kept: [true, true, true, false, false], targetKept: true });
  });

  it.skipIf(!hasMkfifo)('reads the copy it checked, when a pipe takes its name in between', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-bak-swap-'));
    const aside = mkdtempSync(join(tmpdir(), 'file-adapter-bak-aside-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, at(2));
    // A copy at the current epoch: one the prune keeps.
    const bak = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    writeFileSync(bak, at(2));
    expect(spawnSync('mkfifo', [join(aside, 'pipe')]).status).toBe(0);

    const { stuck, swapped, leftOpen } = await watchedWrite(path, {
      at: bak,
      run: () => {
        renameSync(bak, join(aside, 'copy'));
        renameSync(join(aside, 'pipe'), bak);
      },
    });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const lockLeft = existsSync(`${path}.lock`);
    const pipeKept = lstatSync(bak).isFIFO();
    rmSync(dir, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });

    expect({ swapped, stuck, leftOpen }).toEqual({ swapped: true, stuck: [], leftOpen: 0 });
    expect({ marker: saved.marker, lockLeft, pipeKept }).toEqual({ marker: 'saved', lockLeft: false, pipeKept: true });
  });

  it.skipIf(!hasMkfifo)('checks what its open reached, when a copy takes a device link\'s name in between', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-adapter-bak-swap-'));
    const aside = mkdtempSync(join(tmpdir(), 'file-adapter-bak-aside-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, at(2));
    // A link to /dev/zero when the prune opens the name; a copy at the current
    // epoch there by the time a check by name would look.
    const bak = join(dir, `${ROADMAP_FILE_NAME}.bak-2026-01-01T00-00-00.000Z`);
    symlinkSync('/dev/zero', bak);
    writeFileSync(join(aside, 'copy'), at(2));

    const { stuck, swapped, leftOpen } = await watchedWrite(path, { at: bak, run: () => renameSync(join(aside, 'copy'), bak) });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const copyKept = lstatSync(bak).isFile();
    rmSync(dir, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });

    expect({ swapped, stuck, leftOpen }).toEqual({ swapped: true, stuck: [], leftOpen: 0 });
    expect({ marker: saved.marker, copyKept }).toEqual({ marker: 'saved', copyKept: true });
  });
});
