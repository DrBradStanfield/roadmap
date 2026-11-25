/**
 * US-10 AC13 (root fix R6, PR 2): what the callers conclude from a failed
 * save to the local file (FileAdapter, the CLI and the stdio MCP). Real
 * FileAdapter under SyncManager on a temp folder; read through public
 * behaviour, never hint words. Every failure but the rename comes before the
 * rename that replaces the record ("Your record was not changed"). R6 PR 3b
 * (US-10 AC17) names them `refused` where they are raised; before, the adapter
 * named none and SyncManager marked them may-have-landed (H127). Rows changed
 * on purpose: was landed, not refused. The rename itself reporting a failure
 * stays may-have-landed: on a network filesystem it can land and still report one.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** The rename that replaces the record, made to report a failure while `renameFails` is set. */
let renameFails = false;
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, renameSync: (...args: Parameters<typeof real.renameSync>) => {
    if (renameFails) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    return real.renameSync(...args);
  } };
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { FileAdapter } from './file-adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';
import { RecordSession } from './record-session';
import { ROADMAP_DOC } from './roadmap-doc';
import { createMeasurement } from './roadmap-file';
import { saveFailureCause } from './save-state';
import { SyncManager } from './sync-manager';
import { mayHaveLanded } from './write-refusal';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'cli', now: NOW };
let dir = '';

function record(): string {
  dir = mkdtempSync(join(tmpdir(), 'file-adapter-outcome-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  const file = ROADMAP_DOC.migrate(null, ctx);
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-11-01', createdAt: NOW }));
  writeFileSync(path, JSON.stringify(file));
  return path;
}

type Shape = 'unwritable folder' | 'held lock' | 'backup' | 'temp create' | 'rename';

/** The adapter, failing the way `shape` names once `arm` runs. */
function failing(path: string, shape: Shape): { adapter: FileAdapter; arm: () => void } {
  const adapter = new FileAdapter(path);
  const seams = adapter as unknown as { backupPath(): string; tempPath(): string };
  const arm = () => {
    if (shape === 'unwritable folder') chmodSync(dir, 0o500);
    if (shape === 'held lock') writeFileSync(`${path}.lock`, '');
    if (shape === 'backup') vi.spyOn(seams, 'backupPath').mockReturnValue(join(dir, 'missing', 'x.bak'));
    if (shape === 'temp create') vi.spyOn(seams, 'tempPath').mockReturnValue(join(dir, 'missing', 'x.tmp'));
    if (shape === 'rename') renameFails = true;
  };
  return { adapter, arm };
}

async function outcomeOf(shape: Shape) {
  const path = record();
  const { adapter, arm } = failing(path, shape);
  arm();
  const sync = new SyncManager(adapter, 'cli', ROADMAP_DOC, { now: () => NOW });
  const error = await sync.save(ROADMAP_DOC.migrate(null, ctx)).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageError);
  return { landed: mayHaveLanded(error), refused: (error as StorageError).outcome === 'refused', cause: saveFailureCause(error) };
}

/** A device copy whose every write is refused, so the erase's file write is its only copy. */
class RefusingDevice extends MemoryAdapter {
  async write(): Promise<never> {
    throw new StorageError('refused', undefined, undefined, undefined, undefined, 'refused');
  }
}

/** An erase whose write to the file fails this way: put back (the record unchanged) or kept. */
async function eraseOutcome(shape: Shape): Promise<{ erase: 'put back' | 'kept'; file: 'unchanged' | 'changed' }> {
  const path = record();
  const before = readFileSync(path, 'utf8');
  const { adapter, arm } = failing(path, shape);
  const host: RecordHost = {
    tier: 'cloud', store: adapter,
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'cli', clock: { now: () => Date.parse(NOW) },
    timers: { set: () => ({}), clear: () => {} }, remoteChanged: () => {},
    failureCause: () => 'other', report: () => {},
    mirror: {
      adapter: new RefusingDevice(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false, wipe: async () => {}, opened: () => {},
    },
  };
  const session = await RecordSession.open(host);
  const identity = session.eraseIdentity;
  arm();
  expect((await session.erase()).success).toBe(false);
  return { erase: session.eraseIdentity === identity ? 'put back' : 'kept', file: readFileSync(path, 'utf8') === before ? 'unchanged' : 'changed' };
}

afterEach(() => {
  vi.restoreAllMocks();
  renameFails = false;
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const SHAPES: Shape[] = ['unwritable folder', 'held lock', 'backup', 'temp create'];

describe('US-10 AC13, AC17: a failed save to the local file is refused, nothing stored', () => {
  it.each(SHAPES)('%s: not landed, refused (AC17: was landed)', async (shape) => {
    expect(await outcomeOf(shape)).toEqual({ landed: false, refused: true, cause: 'other' });
  }, 15_000);

  // An erase makes no backup (US-31 AC8), so the backup shape cannot fail one.
  it.each(SHAPES.filter((s) => s !== 'backup'))('%s: an erase that fails so is put back, and the file is unchanged (AC17)', async (shape) => {
    expect(await eraseOutcome(shape)).toEqual({ erase: 'put back', file: 'unchanged' });
  }, 15_000);
});

describe('US-10 AC17: the rename that replaces the record reports a failure', () => {
  it('may have landed, not refused (unchanged from main): a rename can land and still report one', async () => {
    expect(await outcomeOf('rename')).toEqual({ landed: true, refused: false, cause: 'other' });
  });

  it('an erase that fails so is kept, not put back (the safe side); here the rename did not land', async () => {
    expect(await eraseOutcome('rename')).toEqual({ erase: 'kept', file: 'unchanged' });
  });
});
