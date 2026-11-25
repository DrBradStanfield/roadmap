/**
 * US-10 AC13 (root fix R6, PR 2): what the callers conclude today from a
 * failed save to the local file (FileAdapter, the CLI and the stdio MCP).
 * Pins only: no production change. Real FileAdapter under SyncManager on a
 * temp folder; read through public behaviour, never hint words. Both
 * failures come before the replace, but the file adapter names no outcome,
 * so SyncManager marks them may-have-landed (H127, write-refusal.ts afterWrite).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { FileAdapter } from './file-adapter';
import { ROADMAP_DOC } from './roadmap-doc';
import { saveFailureCause } from './save-state';
import { SyncManager } from './sync-manager';
import { mayHaveLanded } from './write-refusal';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'cli', now: NOW };
let dir = '';

function record(): string {
  dir = mkdtempSync(join(tmpdir(), 'file-adapter-outcome-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(ROADMAP_DOC.migrate(null, ctx)));
  return path;
}

async function outcomeOf(path: string) {
  const sync = new SyncManager(new FileAdapter(path), 'cli', ROADMAP_DOC, { now: () => NOW });
  const error = await sync.save(ROADMAP_DOC.migrate(null, ctx)).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageError);
  return { landed: mayHaveLanded(error), refused: (error as StorageError).outcome === 'refused', cause: saveFailureCause(error) };
}

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe('US-10 AC13: a failed save to the local file', () => {
  it('a folder the lock cannot be made in', async () => {
    const path = record();
    chmodSync(dir, 0o500);
    expect(await outcomeOf(path)).toEqual({ landed: true, refused: false, cause: 'other' });
  });

  it('a lock another writer holds past the wait', async () => {
    const path = record();
    writeFileSync(`${path}.lock`, '');
    expect(await outcomeOf(path)).toEqual({ landed: true, refused: false, cause: 'other' });
  }, 15_000);
});
