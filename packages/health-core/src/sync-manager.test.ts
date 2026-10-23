import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import type { RoadmapFile } from './roadmap-file';
import { SyncManager, describeStorageFailure } from './sync-manager';
import { ROADMAP_FILE_NAME, ConflictError, LostUpdateError, StorageError } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-doc';
import { SchemaTooNewError } from './migrate';
import { FileAdapter } from './file-adapter';

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

describe('SyncManager.save — making a removed file again (US-10 AC6)', () => {
  // The read of a missing file migrates to the empty record, stamped now. Merged
  // over this device's copy, its empty profile and screenings used to win
  // wherever the copy's lamport was 0 or absent, and the save wrote them empty.
  it('keeps a profile and screenings whose lamport is 0 or absent', async () => {
    const adapter = new MemoryAdapter(new MemoryCloud());
    const sync = new SyncManager(adapter, 'device-a', ROADMAP_DOC, { now: () => '2024-06-01T00:00:00.000Z' });
    const local = makeFile('device-a');
    local.profile = { sex: 'female', heightCm: 165, updatedAt: '2024-01-01T00:00:00.000Z' };
    local.screenings = { colorectalMethod: 'fit_annual', updatedAt: '2024-01-01T00:00:00.000Z', lamport: 0 };

    const { file } = await sync.save(local);
    const written = await sync.load();

    // Values and stamp kept; the merge records each field's clock beside them.
    for (const f of [file, written]) {
      expect(f.profile).toMatchObject(local.profile);
      expect(f.screenings).toMatchObject(local.screenings);
    }
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

describe('SyncManager.save — a non-browser writer keeps what it wrote after an erase (US-09 AC20)', () => {
  // The CLI and the stdio MCP write through FileAdapter. Their copy predates an
  // erase another device made; the row they add after it must survive the gate,
  // and the rows from before it must not.
  it('an offline CLI copy adds a row after another device erased: the row lands, the old rows stay erased', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erased-at-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    try {
      writeFileSync(path, JSON.stringify(makeFile('device-a')));
      const cli = new SyncManager(new FileAdapter(path), 'cli', ROADMAP_DOC, { now: () => '2024-03-01T00:00:00.000Z' });
      const offline = await cli.load();
      offline.measurements.push(createMeasurement({
        id: 'pre-erase', metricType: 'weight', value: 90,
        recordedAt: '2024-01-15T00:00:00.000Z', createdAt: '2024-01-15T00:00:00.000Z',
      }));

      // Another device erases: the file on disk is replaced by the erased copy.
      const erased = makeFile('device-a');
      erased.meta = { ...erased.meta, updatedAt: '2024-02-01T00:00:00.000Z', eraseEpoch: 1, erasedAt: '2024-02-01T00:00:00.000Z' };
      writeFileSync(path, JSON.stringify(erased));

      // The CLI, still holding its pre-erase copy, records a new value and saves.
      offline.measurements.push(createMeasurement({
        id: 'post-erase', metricType: 'weight', value: 80,
        recordedAt: '2024-03-01T00:00:00.000Z', createdAt: '2024-03-01T00:00:00.000Z',
      }));
      const { file } = await cli.save(offline);
      expect(file.measurements.map((m) => m.id)).toEqual(['post-erase']);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as RoadmapFile;
      expect(onDisk.measurements.map((m) => m.id)).toEqual(['post-erase']);
      expect(onDisk.meta).toMatchObject({ eraseEpoch: 1, erasedAt: '2024-02-01T00:00:00.000Z' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('SyncManager.save — uncertainty survives later failures', () => {
  it.each(['read', 'schema', 'verify'] as const)('does not claim nothing was written after a landed write then %s failure', async (mode) => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const read = adapter.read.bind(adapter);
    const write = adapter.write.bind(adapter);
    const fatal = new StorageError('synthetic access refused', undefined, undefined, 403);
    let reads = 0;
    let writes = 0;
    adapter.read = async (...args) => {
      reads++;
      if (reads === 2) {
        if (mode === 'verify') throw fatal;
        throw new LostUpdateError('synthetic verification lost update');
      }
      if (reads === 3) {
        if (mode === 'read') throw fatal;
        return { body: { ...makeFile('future'), schemaVersion: 999 }, version: 'future' };
      }
      return read(...args);
    };
    adapter.write = async (...args) => { writes++; return write(...args); };
    const failure = await new SyncManager(adapter, 'writer', ROADMAP_DOC).save(makeFile('writer')).then(() => null, (error: unknown) => error);
    expect(writes).toBe(1);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(true);
    const told = describeStorageFailure(failure, 'Memory');
    expect(`${told.message} ${told.hint}`).not.toMatch(/nothing was (written|changed)/i);
    expect(told.hint).toMatch(/may.*landed/);
    if (mode !== 'schema') expect(failure).toMatchObject({ cause: fatal });
  });

  it('keeps "may have landed" when the save is cancelled during verification (US-10 AC4a)', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const read = adapter.read.bind(adapter);
    const abort = new AbortController();
    let reads = 0;
    adapter.read = async (...args) => {
      if (++reads === 2) {
        abort.abort();
        abort.signal.throwIfAborted();
      }
      return read(...args);
    };
    const failure = await new SyncManager(adapter, 'writer', ROADMAP_DOC).save(makeFile('writer'), abort.signal).then(() => null, (error: unknown) => error);
    expect(cloud.files.has(ROADMAP_FILE_NAME)).toBe(true);
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ cause: abort.signal.reason });
    const told = describeStorageFailure(failure, 'Memory');
    expect(`${told.message} ${told.hint}`).not.toMatch(/nothing was (written|changed)/i);
    expect(told.hint).toMatch(/may.*landed/);
  });

  it('still reports no writes for five ordinary pre-upload conflicts', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    let writes = 0;
    adapter.write = async () => { writes++; throw new ConflictError('pre-upload'); };
    const failure = await new SyncManager(adapter, 'writer', ROADMAP_DOC).save(makeFile('writer')).then(() => null, (error: unknown) => error);
    expect(writes).toBe(5);
    expect(cloud.files.size).toBe(0);
    expect(describeStorageFailure(failure, 'Memory').hint).toContain('nothing was written');
  });
});

describe('describeStorageFailure — a newer schema (US-10 AC4a)', () => {
  it('asks for an update without claiming reads refuse: on Drive the other copies still load', () => {
    const told = describeStorageFailure(new SchemaTooNewError(99, 2), 'Google Drive');
    expect(told.message).toContain('newer version');
    expect(told.hint).not.toMatch(/read/i);
    expect(told.hint).toContain('Nothing was written');
    expect(told.hint).toContain('update');
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
