import { describe, it, expect } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME } from '@roadmap/health-core';

function readCloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

function insertedRow(result: ReturnType<RoadmapStore['addMeasurement']>) {
  if (result.status !== 'inserted') throw new Error('setup failed');
  return result.row;
}

// US-32 · A website upload never silently loses a value to a connector row.
describe('RoadmapStore.bulkSaveMeasurements with correctsId (US-32)', () => {
  it('flips the occupied row to entered-in-error and appends the upload value with correctsId', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T00:00:00.000Z')).id;

    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import', correctsId: oldId },
    ]);
    expect(result.saved).toHaveLength(1);
    expect(result.skippedDuplicates).toBe(0);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.measurements.find((m) => m.id === oldId)!.status).toBe('entered-in-error');
    const newRow = file.measurements.find((m) => m.id !== oldId && m.metricType === 'ldl')!;
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.source).toBe('lab_import');
    expect(newRow.value).toBe(3.2);
    expect(newRow.recordedAt).toBe('2024-06-01T00:00:00.000Z');
    // One active row per (metric, day) survives the correction.
    expect(file.measurements.filter((m) => m.metricType === 'ldl' && m.status === 'active')).toHaveLength(1);
  });

  it('without correctsId an occupied slot is still skipped (US-32)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T00:00:00.000Z'));
    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import' },
    ]);
    expect(result.saved).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('a stale correctsId (row already superseded elsewhere) is skipped, never duplicated (US-32)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T00:00:00.000Z')).id;
    store.correctMeasurement(oldId, 4.0);

    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import', correctsId: oldId },
    ]);
    expect(result.saved).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(1);
    expect(store.loadAllHistory().filter((m) => m.metricType === 'ldl' && m.status === 'active')).toHaveLength(1);
  });

  it('two batch rows naming the same correctsId leave ONE active row — the second is stale (US-32)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T00:00:00.000Z')).id;
    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import', correctsId: oldId },
      { metricType: 'ldl', value: 3.3, recordedAt: '2024-06-01T00:00:00.000Z', source: 'lab_import', correctsId: oldId },
    ]);
    expect(result.saved).toHaveLength(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(store.loadAllHistory().filter((m) => m.metricType === 'ldl' && m.status === 'active')).toHaveLength(1);
  });
});

describe('RoadmapStore.bulkSaveLabValues with correctsId (US-32)', () => {
  it('flips the occupied lab row and appends the upload value with correctsId', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const first = store.bulkSaveLabValues([
      { metricName: 'Ferritin', value: 120, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z' },
    ]);
    const oldId = first.saved[0].id;

    const result = store.bulkSaveLabValues([
      { metricName: 'Ferritin', value: 95, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z', correctsId: oldId },
    ]);
    expect(result.saved).toHaveLength(1);
    expect(result.skippedDuplicates).toBe(0);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.labValues.find((l) => l.id === oldId)!.status).toBe('entered-in-error');
    const newRow = file.labValues.find((l) => l.id !== oldId)!;
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.source).toBe('lab_import');
    expect(newRow.value).toBe(95);
    expect(newRow.recordedAt).toBe('2024-06-01T00:00:00.000Z');
    expect(file.labValues.filter((l) => l.status === 'active')).toHaveLength(1);
  });

  it('two batch rows naming the same lab correctsId leave ONE active row (US-32)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    const oldId = store.bulkSaveLabValues([
      { metricName: 'Ferritin', value: 120, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z' },
    ]).saved[0].id;
    const result = store.bulkSaveLabValues([
      { metricName: 'Ferritin', value: 95, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z', correctsId: oldId },
      { metricName: 'Ferritin', value: 96, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z', correctsId: oldId },
    ]);
    expect(result.saved).toHaveLength(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(store.loadLabValues().filter((l) => l.status === 'active')).toHaveLength(1);
  });
});
