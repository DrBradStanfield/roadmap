import { describe, it, expect } from 'vitest';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '@roadmap/health-core';
import { SyncManager } from './sync-manager';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-store';

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
