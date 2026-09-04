import { describe, it, expect } from 'vitest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import type { RoadmapFile } from './roadmap-file';
import { SyncManager } from './sync-manager';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-doc';

// US-10 · Cross-device convergence — highest-risk gap flagged in
// docs/user-stories.md ("SyncManager load→merge→push loop... untested").
// Scope note: the hydration gate (AC1 — "a fast edit on a fresh page load can
// never clobber unseen cloud data") lives in HealthTool.tsx (a UI-level flag
// gating writes until the first authoritative load completes), not in
// SyncManager itself. That's out of scope here — these tests cover only what
// SyncManager's public API (load/save) actually does: the read-merge-write
// loop and the eraseEpoch wholesale-win gate it delegates to mergeFiles().

function makeFile(deviceId: string): RoadmapFile {
  return createEmptyFile({ deviceId, now: '2024-01-01T00:00:00.000Z' });
}

describe('SyncManager.save — read-merge-write (US-10)', () => {
  it('a concurrent remote-only change and a local-only change both survive the merge', async () => {
    const cloud = new MemoryCloud();
    const syncA = new SyncManager(new MemoryAdapter(cloud), 'device-a', ROADMAP_DOC);
    const syncB = new SyncManager(new MemoryAdapter(cloud), 'device-b', ROADMAP_DOC);

    // Both devices start from the same empty file (no prior sync).
    const fileA = await syncA.load();
    const fileB = await syncB.load();

    // Device A adds a measurement and saves first — remote now has X.
    fileA.measurements.push(createMeasurement({
      id: 'meas-x', metricType: 'weight', value: 80,
      recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
    }));
    await syncA.save(fileA);

    // Device B, unaware of X, adds a DIFFERENT measurement Y to its own
    // (still-empty) local copy and saves. SyncManager.save() must re-read the
    // remote fresh (picking up X) and merge it with B's local Y — not clobber it.
    fileB.measurements.push(createMeasurement({
      id: 'meas-y', metricType: 'waist', value: 90,
      recordedAt: '2024-01-02T00:00:00.000Z', createdAt: '2024-01-02T00:00:00.000Z',
    }));
    const resultB = await syncB.save(fileB);

    const ids = resultB.file.measurements.map((m) => m.id).sort();
    expect(ids).toEqual(['meas-x', 'meas-y']);

    // A subsequent load by either device sees both.
    const reloaded = await syncA.load();
    expect(reloaded.measurements.map((m) => m.id).sort()).toEqual(['meas-x', 'meas-y']);
  });
});

describe('SyncManager.save — eraseEpoch wholesale win (US-10 / US-11)', () => {
  // Regression (fixed 2026-08-07): `migrateFile()` used to drop `meta.eraseEpoch`
  // on every read, so the wholesale-win gate in mergeFiles() never saw the
  // remote's epoch and a stale device's flush resurrected erased data. This
  // test failed against the buggy migrate() and pins the fixed behavior.
  it('a stale local file with populated content is beaten WHOLESALE by a higher-eraseEpoch remote', async () => {
    const cloud = new MemoryCloud();
    const syncA = new SyncManager(new MemoryAdapter(cloud), 'device-a', ROADMAP_DOC);
    const syncB = new SyncManager(new MemoryAdapter(cloud), 'device-b', ROADMAP_DOC);

    // Device A populates and saves.
    const fileA = await syncA.load();
    fileA.measurements.push(createMeasurement({
      id: 'meas-1', metricType: 'weight', value: 80,
      recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
    }));
    await syncA.save(fileA);

    // Device B loads the populated file, then never reloads (models a stale
    // in-memory copy) while device A erases everything (bumps eraseEpoch, empties).
    const staleFileB = await syncB.load();
    expect(staleFileB.measurements).toHaveLength(1);

    const erased = makeFile('device-a');
    erased.meta.eraseEpoch = 1;
    await syncA.save(erased);

    // Device B's save() reads the remote fresh (erased, epoch 1) and the
    // eraseEpoch gate picks the erased file WHOLESALE — B's stale measurement
    // must NOT union back in.
    const resultB = await syncB.save(staleFileB);
    expect(resultB.file.meta.eraseEpoch).toBe(1);
    expect(resultB.file.measurements).toEqual([]);

    const final = await syncA.load();
    expect(final.measurements).toEqual([]);
    expect(final.meta.eraseEpoch).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// verify-after-write (H5) — the corruption guard that runs on every write, on
// every surface. Four branches, and until now only the missing-rows one was
// exercised, transitively and Drive-shaped. These drive SyncManager directly.
// ---------------------------------------------------------------------------

/**
 * A MemoryAdapter whose reads can be sabotaged AFTER the write lands — which is
 * exactly the window verify-after-write exists to see.
 */
class SabotagedAdapter extends MemoryAdapter {
  sabotage: ((body: unknown) => unknown) | null = null;
  private written = false;

  async read(fileName: string) {
    const result = await super.read(fileName);
    // Only the re-read that FOLLOWS a write is corrupted; the read that opens
    // the save loop is honest, so the file being written is a real one.
    if (this.sabotage == null || !this.written) return result;
    return { ...result, body: this.sabotage(result.body) };
  }

  async write(fileName: string, body: object, expectedVersion: string | null) {
    const result = await super.write(fileName, body, expectedVersion);
    this.written = true;
    return result;
  }
}

describe('SyncManager.verify-after-write (US-32 AC17 · H5)', () => {
  function armed(cloud: MemoryCloud): { sync: SyncManager<RoadmapFile>; adapter: SabotagedAdapter } {
    const adapter = new SabotagedAdapter(cloud);
    return { sync: new SyncManager(adapter, 'device-a', ROADMAP_DOC), adapter };
  }

  /** Land one clean write, then arm the sabotage for the verify re-read. */
  async function writeThenSabotage(
    sabotage: (body: unknown) => unknown,
  ): Promise<unknown> {
    const { sync, adapter } = armed(new MemoryCloud());
    const file = await sync.load();
    file.measurements.push(createMeasurement({
      id: 'meas-1', metricType: 'weight', value: 80,
      recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
    }));
    adapter.sabotage = sabotage;
    return sync.save(file).then(() => null, (error: unknown) => error);
  }

  it('refuses to call a write successful when the file is GONE afterwards', async () => {
    const failure = await writeThenSabotage(() => null);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toContain('missing after a successful write');
    // The hint never claims the change did or did not land — it cannot know.
    expect((failure as StorageError).hint).toContain('may or may not have landed');
  });

  it('refuses to call a write successful when what came back does not PARSE as the record', async () => {
    // Not "invalid JSON" — the adapter hands back parsed bytes. This is the
    // shape gate in ROADMAP_DOC.migrate seeing something that is not a record.
    const failure = await writeThenSabotage(() => ['not', 'a', 'record']);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toContain('did not parse');
    expect((failure as StorageError).hint).toContain('may or may not have landed');
  });

  it('reports a LAMPORT REGRESSION as a lost update, not as a clean save', async () => {
    // A revision older than the one just written means another writer clobbered
    // it (or a stale replica answered). Retryable, so save() burns its attempts
    // and then says the honest thing: some of it may have landed.
    const failure = await writeThenSabotage((body) => {
      const file = body as RoadmapFile;
      return { ...file, meta: { ...file.meta, lamport: 0 } };
    });
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toContain('conflict storm');
    expect((failure as StorageError).hint).toContain('Some of it may have landed');
  });

  it('tolerates a CONCURRENT newer write — a higher lamport is not corruption', async () => {
    const failure = await writeThenSabotage((body) => {
      const file = body as RoadmapFile;
      return { ...file, meta: { ...file.meta, lamport: file.meta.lamport + 50 } };
    });
    expect(failure).toBeNull();
  });
});

describe('describeStorageFailure — a rejected token is a reconnect, not a folder check (US-32)', () => {
  it('sends a 401/403 to reconnect, and leaves other statuses on the generic wording', async () => {
    const { describeStorageFailure } = await import('./sync-manager');
    for (const status of [401, 403]) {
      const told = describeStorageFailure(new StorageError('Dropbox read failed (401): expired', undefined, undefined, status), 'Dropbox');
      expect(told.message).toContain('refused this connection');
      expect(told.hint).toContain('Reconnect');
    }
    const other = describeStorageFailure(new StorageError('Dropbox read failed (503): down', undefined, undefined, 503), 'Dropbox');
    expect(other.hint).not.toContain('Reconnect');
  });
});

describe('a caller’s signal reaches every adapter call (US-35 AC5)', () => {
  it('load and save read and write under it; once aborted, nothing starts and nothing is written', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const seen: Array<AbortSignal | undefined> = [];
    const read = adapter.read.bind(adapter);
    const write = adapter.write.bind(adapter);
    adapter.read = (name, signal) => { seen.push(signal); return read(name, signal); };
    adapter.write = (name, body, version, signal) => { seen.push(signal); return write(name, body, version, signal); };
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC);
    const controller = new AbortController();
    const file = await sync.load(controller.signal);
    await sync.save(file, controller.signal);
    expect(seen).toHaveLength(4); // load's read; save's read, write, verify read
    expect(seen.every((s) => s === controller.signal)).toBe(true);
    const version = cloud.files.get(ROADMAP_FILE_NAME)!.version;
    controller.abort();
    await expect(sync.save(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sync.load(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(version);
  });
});
