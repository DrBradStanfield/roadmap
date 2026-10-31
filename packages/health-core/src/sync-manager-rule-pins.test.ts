// Pins for sync-manager.ts and roadmap-doc.ts behaviour that no other test
// checks. Each block names the line it guards: a mutation run (mewt, then
// re-checked by hand on main) showed the line could change with every
// existing test still passing. Current behaviour only.
import { describe, it, expect } from 'vitest';
import { createEmptyFile } from './roadmap-file';
import type { RoadmapFile } from './roadmap-file';
import {
  SyncManager,
  describeStorageFailure,
  verifyPersistedFile,
  type DocumentSpec,
  type SyncedFile,
} from './sync-manager';
import { LostUpdateError, StorageError } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-doc';

const NOW = '2024-01-01T00:00:00.000Z';
const ctx = { deviceId: 'dev', now: NOW };

interface Plain extends SyncedFile {
  owner: string;
}

class CountingAdapter extends MemoryAdapter {
  reads = 0;
  override async read(fileName: string, signal?: AbortSignal) {
    this.reads++;
    return super.read(fileName, signal);
  }
}

function plainDoc(extra: Partial<DocumentSpec<Plain>> = {}): DocumentSpec<Plain> {
  return {
    fileName: 'plain.json',
    migrate: (raw) => (raw as Plain | null) ?? { owner: 'none', meta: { lamport: 0 } },
    merge: (local, base) => ({ owner: local.owner, meta: { lamport: Math.max(local.meta.lamport, base.meta.lamport) + 1 } }),
    ...extra,
  };
}

describe('SyncManager: the save loop (US-10)', () => {
  // save(): `this.doc.merge(local, base, ...)`. Merges are symmetric except
  // where the spec lets local win (unknown top-level fields), so the order is
  // the contract.
  it('passes (local, base) to the spec merge in that order', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set('plain.json', { json: JSON.stringify({ owner: 'remote', meta: { lamport: 3 } }), version: 1 });
    const seen: string[] = [];
    const doc = plainDoc({ merge: (local, base) => { seen.push(local.owner, base.owner); return { owner: local.owner, meta: { lamport: 9 } }; } });
    const result = await new SyncManager(new MemoryAdapter(cloud), 'dev', doc).save({ owner: 'local', meta: { lamport: 1 } });
    expect(seen.slice(0, 2)).toEqual(['local', 'remote']);
    expect(result.file.owner).toBe('local');
  });

  // verifyPersistedFile(): `if (doc.rowIds)`. A verified document with no
  // row ids has nothing to check by row and must still save.
  it('a verified document without rowIds saves cleanly (nothing to check by row)', async () => {
    const adapter = new CountingAdapter();
    const doc = plainDoc();
    const file = { owner: 'a', meta: { lamport: 2 } };
    expect(() => verifyPersistedFile(doc, file, file, ctx)).not.toThrow();
    await expect(new SyncManager(adapter, 'dev', doc).save({ owner: 'a', meta: { lamport: 1 } })).resolves.toMatchObject({ attempts: 0 });
    expect(adapter.reads).toBe(2);
  });
});

describe('ROADMAP_DOC: merge order and the absent-file gate (roadmap-doc.ts)', () => {
  // merge: `mergeFiles(local, base, ctx)`. mergeFiles spreads remote then
  // local, so local's value of a field this version does not know wins.
  it('merge keeps the LOCAL copy’s value of an unknown top-level field', () => {
    const local = { ...createEmptyFile({ deviceId: 'a', now: NOW }), futureField: 'L' } as RoadmapFile;
    const base = { ...createEmptyFile({ deviceId: 'b', now: NOW }), futureField: 'R' } as RoadmapFile;
    expect((ROADMAP_DOC.merge(local, base, ctx) as unknown as { futureField: string }).futureField).toBe('L');
  });

  // assertRecordShape(): `if (raw == null) return`. An undefined body is an
  // absent file like null, not a different file wearing our name.
  it('an undefined body is an absent file, like null: a fresh record, not a shape error', () => {
    const file = ROADMAP_DOC.migrate(undefined, ctx);
    expect(file.measurements).toEqual([]);
  });
});

describe('describeStorageFailure: the words each failure gets (US-10 AC4a, US-32)', () => {
  // The LostUpdateError branch must come before the ConflictError one: a lost
  // update is the conflict where the write did happen.
  it('a lost update never claims nothing was written', () => {
    const told = describeStorageFailure(new LostUpdateError('row gone'), 'The record in Dropbox');
    expect(told.hint).toContain('may have landed');
    expect(told.hint).not.toContain('Nothing was written');
  });

  // `if (error.hint?.includes('landed'))`: only a refusal after a write went
  // out gets the "may have landed" wording.
  it('a plain 401 (no write went out) says reconnect, never "may have landed"', () => {
    const told = describeStorageFailure(new StorageError('denied', undefined, undefined, 401), 'Dropbox');
    expect(told.hint).toContain('Reconnect');
    expect(told.hint).not.toContain('may have landed');
  });

  // `error.status === 401 || error.status === 403`: exactly those two are a
  // rejected token. The existing test checks 401, 403 and 503 only.
  it.each([400, 402])('a %i is not a rejected token: no reconnect advice', (status) => {
    const told = describeStorageFailure(new StorageError(`failed (${status})`, undefined, undefined, status), 'Dropbox');
    expect(told.hint).not.toContain('Reconnect');
  });
});
