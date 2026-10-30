// US-10 AC4c: a ConflictError from the save loop's READ (a Drive copy
// vanished between discovery and its version/download) must re-read and
// re-merge, like one from the write, not fail the save.
import { describe, expect, it } from 'vitest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { SyncManager } from './sync-manager';
import { ConflictError, StorageError } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-doc';

class VanishingCopyAdapter extends MemoryAdapter {
  failures = 1;
  error: Error = new ConflictError('Google Drive record disappeared during discovery');
  async read(fileName: string, signal?: AbortSignal) {
    if (this.failures > 0) {
      this.failures--;
      throw this.error;
    }
    return super.read(fileName, signal);
  }
}

/** One entry per read: 'ok' reads, 'conflict' throws; the last entry repeats. */
class ScriptedReads extends MemoryAdapter {
  calls = 0;
  constructor(cloud: MemoryCloud, private readonly script: ('ok' | 'conflict')[]) { super(cloud); }
  async read(fileName: string, signal?: AbortSignal) {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (step === 'conflict') throw new ConflictError('Google Drive record disappeared during read');
    return super.read(fileName, signal);
  }
}

function withWeight() {
  const file = createEmptyFile({ deviceId: 'device-a', now: '2024-01-01T00:00:00.000Z' });
  file.measurements.push(createMeasurement({
    id: 'm1', metricType: 'weight', value: 80,
    recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
  }));
  return file;
}

describe('US-10 AC4c: SyncManager.save and a conflict on the read', () => {
  it('re-reads and saves instead of failing', async () => {
    const adapter = new VanishingCopyAdapter(new MemoryCloud());
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC, { now: () => '2024-06-01T00:00:00.000Z' });
    const local = createEmptyFile({ deviceId: 'device-a', now: '2024-01-01T00:00:00.000Z' });
    local.measurements.push(createMeasurement({
      id: 'm1', metricType: 'weight', value: 80,
      recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
    }));
    const result = await sync.save(local);
    expect(result.file.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(result.attempts).toBe(1);
  });

  it('a read that keeps conflicting ends as the conflict storm, nothing written, cause kept', async () => {
    const adapter = new ScriptedReads(new MemoryCloud(), ['conflict']);
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC);
    const error = await sync.save(withWeight()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).message).toMatch(/5 attempts/);
    expect((error as StorageError).hint).toMatch(/nothing was written/);
    expect((error as StorageError).cause).toBeInstanceOf(ConflictError);
    expect(adapter.calls).toBe(5);
  });

  it('after a write lands, a read conflict retries and the save converges', async () => {
    // Read, write, verify read conflicts, next read conflicts once, then reads work.
    const adapter = new ScriptedReads(new MemoryCloud(), ['ok', 'conflict', 'conflict', 'ok']);
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC);
    const result = await sync.save(withWeight());
    expect(result.file.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(result.attempts).toBe(2);
  });

  it('after a write lands, reads that keep conflicting say it may have landed', async () => {
    const adapter = new ScriptedReads(new MemoryCloud(), ['ok', 'conflict']);
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC);
    const error = await sync.save(withWeight()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).hint).toMatch(/may have landed/);
  });

  it('negative control: a read that fails for any other reason still fails the save (passes today)', async () => {
    const adapter = new VanishingCopyAdapter(new MemoryCloud());
    adapter.error = new StorageError('Google Drive read failed (500).');
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC);
    await expect(sync.save(createEmptyFile({ deviceId: 'device-a', now: '2024-01-01T00:00:00.000Z' }))).rejects.toThrow('read failed (500)');
  });
});
