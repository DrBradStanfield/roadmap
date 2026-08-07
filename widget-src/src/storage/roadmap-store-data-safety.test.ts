import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_FILE_NAME } from './adapter';

/** The file as it landed in the (simulated) cloud after a flush. */
function readCloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

/** Unwrap an addMeasurement result the setup expects to have inserted. */
function insertedRow(result: ReturnType<RoadmapStore['addMeasurement']>) {
  if (result.status !== 'inserted') throw new Error('setup failed');
  return result.row;
}

// US-04 · Correcting a saved value (FHIR) — coverage priority #1
// (docs/user-stories.md: "RoadmapStore.correctMeasurement itself untested").
describe('RoadmapStore.correctMeasurement (US-04)', () => {
  it('flips the old row to entered-in-error and appends a manual_correction row with correctsId', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;

    const result = store.correctMeasurement(oldId, 3.2);
    expect(result.status).toBe('ok');
    await store.flush();

    const file = readCloudFile(cloud);
    const oldRow = file.measurements.find((m) => m.id === oldId)!;
    expect(oldRow.status).toBe('entered-in-error');

    const newRow = file.measurements.find((m) => m.id !== oldId && m.metricType === 'ldl')!;
    expect(newRow.source).toBe('manual_correction');
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.value).toBe(3.2);
    expect(newRow.status).toBe('active');
  });

  it('results/latest reads use only the active (corrected) row', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.correctMeasurement(insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id, 3.2);

    // Both loadAllHistory() and loadLatestMeasurements() filter to status==='active'.
    const history = store.loadAllHistory();
    expect(history.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(history.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);

    const latest = store.loadLatestMeasurements();
    expect(latest.previousMeasurements.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(latest.previousMeasurements.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);
  });

  it('correcting a non-existent id returns not_found and leaves the file untouched', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await store.flush();
    const before = readCloudFile(cloud);

    const result = store.correctMeasurement('does-not-exist', 3.2);
    expect(result.status).toBe('not_found');
    await store.flush();

    const after = readCloudFile(cloud);
    expect(after.measurements).toHaveLength(before.measurements.length);
    expect(after.measurements).toEqual(before.measurements);
  });

  it('correcting an already-corrected (entered-in-error) id also returns not_found, without corrupting state', async () => {
    // Same documented failure shape as the unknown-id case — correctMeasurement
    // only accepts oldId pointing at a currently-active row (roadmap-store.ts:261).
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;
    store.correctMeasurement(oldId, 3.2); // first correction — oldId now entered-in-error

    const second = store.correctMeasurement(oldId, 2.9); // re-correcting the now-dead row
    expect(second.status).toBe('not_found');
    await store.flush();

    const file = readCloudFile(cloud);
    // Still exactly one active row for the slot — the second call added nothing.
    expect(
      file.measurements.filter((m) => m.metricType === 'ldl' && m.status === 'active'),
    ).toHaveLength(1);
    expect(file.measurements.filter((m) => m.metricType === 'ldl')).toHaveLength(2);
  });

  it('at most one active row per (metric, day) survives a correction, and the slot re-blocks a duplicate add', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const day = '2024-06-01T09:00:00.000Z';
    store.correctMeasurement(insertedRow(store.addMeasurement('ldl', 4.5, day)).id, 3.2);

    const activeForSlot = store
      .loadAllHistory()
      .filter((m) => m.metricType === 'ldl');
    expect(activeForSlot).toHaveLength(1);

    // The slot guard (roadmap-store.ts addMeasurement) still sees one active
    // row for this (metric, day) — a fresh add for the same day is blocked.
    const dup = store.addMeasurement('ldl', 5.0, day);
    expect(dup.status).toBe('duplicate');
  });
});

// US-11 · Deleting my data — coverage priority #1
// (docs/user-stories.md: "deleteUserData store path untested").
describe('RoadmapStore.deleteUserData (US-11)', () => {
  it('bumps eraseEpoch and empties every collection', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    store.saveMedication('statin', 'atorvastatin', 20, 'mg');
    store.saveSupplement('omega3', 'Omega-3', 1000, 'mg');
    store.saveScreening('colorectal_method', 'fit');
    await store.flush();
    const beforeErase = readCloudFile(cloud);
    expect(beforeErase.meta.eraseEpoch ?? 0).toBe(0);

    const result = await store.deleteUserData();
    expect(result.success).toBe(true);

    const file = readCloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(file.medications).toEqual([]);
    expect(file.medicationHistory).toEqual([]);
    expect(file.supplements).toEqual([]);
    expect(file.labValues).toEqual([]);
    expect(file.documents).toEqual([]);
  });

  // Regression (fixed 2026-08-07): `migrateFile()` used to drop `meta.eraseEpoch`
  // on every read from storage, so mergeFiles()'s wholesale-win gate never fired
  // for a re-read file and a stale device's flush resurrected erased data — a
  // data-deletion/privacy defect. This test failed against the buggy migrate()
  // and pins the fixed behavior.
  it('a stale device flushing after an erase does NOT resurrect the erased data', async () => {
    const cloud = new MemoryCloud();
    const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
    deviceA.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    deviceA.saveMedication('statin', 'atorvastatin', 20, 'mg');
    await deviceA.flush();

    // Device B loads the same populated cloud copy, but never sees the erase —
    // it stays "stale" in memory (no reload) while device A deletes everything.
    const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(deviceB.loadAllHistory()).toHaveLength(1);

    await deviceA.deleteUserData();

    // Device B, still holding its stale populated in-memory copy, flushes.
    // mergeFiles' eraseEpoch gate wins wholesale — B's data must NOT come back.
    await deviceB.flush();

    const file = readCloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(deviceB.loadAllHistory()).toEqual([]);
  });
});

// US-13 · Review before save — bulk-save dedup (coverage priority #1).
describe('RoadmapStore.bulkSaveMeasurements dedup (US-13)', () => {
  it('skips (metric, day) duplicates within a batch and reports skippedDuplicates', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
      // Same metric+day, different time-of-day — still one slot.
      { metricType: 'ldl', value: 3.4, recordedAt: '2024-06-01T18:00:00.000Z', source: 'lab_import' as const },
      { metricType: 'hdl', value: 1.3, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
    ]);
    expect(result.saved).toHaveLength(2);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('re-running the identical batch against existing data is a no-op success, not an error', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const batch = [
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
      { metricType: 'hdl', value: 1.3, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
    ];
    const first = store.bulkSaveMeasurements(batch);
    expect(first.saved).toHaveLength(2);
    await store.flush();

    const second = store.bulkSaveMeasurements(batch);
    expect(second.saved).toHaveLength(0);
    expect(second.skippedDuplicates).toBe(2);
    expect(second.errorCount).toBe(0);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.measurements.filter((m) => m.status === 'active')).toHaveLength(2);
  });
});

describe('RoadmapStore.bulkSaveLabValues dedup (US-13)', () => {
  it('skips (metricName, day) duplicates and reports skippedDuplicates', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const result = store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'ferritin', value: 82, unit: 'ng/mL', recordedAt: '2024-06-01T20:00:00.000Z' },
      { metricName: 'sodium', value: 140, unit: 'mmol/L', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    expect(result.saved).toHaveLength(2);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('re-uploading the same lab-value batch is a no-op success (all-duplicate ≠ error)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const batch = [
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
    ];
    store.bulkSaveLabValues(batch);
    await store.flush();

    const second = store.bulkSaveLabValues(batch);
    expect(second.saved).toEqual([]);
    expect(second.skippedDuplicates).toBe(1);
    expect(second.errorCount).toBe(0);
  });
});

// US-03 · Blood-test matrix entry & backfill — date-defaulting semantics
// (feedback 2026-03-22: a value appeared under a wrong date; root cause never
// found, so this pins the exact current defaulting behavior as a regression anchor).
describe('RoadmapStore.addMeasurement date semantics (US-03)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores the exact recordedAt when one is provided', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const explicit = '2020-01-15T03:00:00.000Z';
    expect(insertedRow(store.addMeasurement('weight', 80, explicit)).recordedAt).toBe(explicit);
  });

  it('defaults recordedAt to "now" (the clock at call time) when omitted', async () => {
    vi.setSystemTime(new Date('2026-08-07T12:34:56.000Z'));
    const store = await RoadmapStore.create(new MemoryAdapter());
    // roadmap-store.ts: `const when = recordedAt ?? new Date().toISOString();`
    expect(insertedRow(store.addMeasurement('weight', 80)).recordedAt).toBe('2026-08-07T12:34:56.000Z');
  });

  it('a second value for the same (metric, day) is blocked as a duplicate, never silently overwritten or double-stored', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const day = '2024-06-01T09:00:00.000Z';
    const first = store.addMeasurement('weight', 80, day);
    expect(first.status).toBe('inserted');

    // Same day, different time-of-day and a different value — still one slot.
    const second = store.addMeasurement('weight', 81, '2024-06-01T20:00:00.000Z');
    expect(second.status).toBe('duplicate');

    const active = store.loadAllHistory().filter((m) => m.metricType === 'weight');
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe(80); // the original — a same-day re-entry must route through correctMeasurement (US-04), not addMeasurement.
  });
});
