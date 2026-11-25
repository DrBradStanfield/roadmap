import { describe, it, expect } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { pickOf, uploadThrough, type PickedReport } from '../testing/upload-save-kit';

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
    expect(toOldShape(file).measurements.find((m) => m.id === oldId)!.status).toBe('entered-in-error');
    const newRow = toOldShape(file).measurements.find((m) => m.id !== oldId && m.metricType === 'ldl')!;
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.source).toBe('lab_import');
    expect(newRow.value).toBe(3.2);
    expect(newRow.recordedAt).toBe('2024-06-01T00:00:00.000Z');
    // One active row per (metric, day) survives the correction.
    expect(toOldShape(file).measurements.filter((m) => m.metricType === 'ldl' && m.status === 'active')).toHaveLength(1);
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
    store.correctValue(oldId, 4.0);

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
    const first = await uploadThrough(store, [{ report: 'first.pdf', reportDate: '2024-06-01', values: [{ name: 'Ferritin', value: 120, unit: 'ug/L' }] }]);
    expect(first).toMatchObject({ ok: true, outcome: { values: 1 } });
    const oldId = store.file.labValues[0].id;

    // The upload's Replace, as the review offers it for a held row on the same day.
    const result = await uploadThrough(store, [{ report: 'second.pdf', reportDate: '2024-06-01', values: [{ name: 'Ferritin', value: 95, unit: 'ug/L' }], choices: { replace: { a0: oldId } } }]);
    expect(result).toMatchObject({ ok: true, outcome: { values: 1 } });
    expect(result.ok && result.outcome.skippedLabValues).toBeFalsy();
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.labValues.find((l) => l.id === oldId)!.status).toBe('entered-in-error');
    const newRow = file.labValues.find((l) => l.id !== oldId)!;
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.source).toBe('lab_import');
    expect(newRow.value).toBe(95);
    expect(newRow.recordedAt).toBe(file.labValues.find((l) => l.id === oldId)!.recordedAt); // the held row's day
    expect(file.labValues.filter((l) => l.status === 'active')).toHaveLength(1);
  });

  it('two batch rows naming the same lab correctsId leave ONE active row (US-32)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    await uploadThrough(store, [{ report: 'first.pdf', reportDate: '2024-06-01', values: [{ name: 'Ferritin', value: 120, unit: 'ug/L' }] }]);
    const oldId = store.file.labValues[0].id;
    const result = await uploadThrough(store, [{ report: 'second.pdf', reportDate: '2024-06-01', values: [
      { name: 'Ferritin', value: 95, unit: 'ug/L' },
      { name: 'Ferritin', value: 96, unit: 'ug/L' },
    ], choices: { replace: { a0: oldId, a1: oldId } } }]);
    expect(result).toMatchObject({ ok: true, outcome: { values: 1 } });
    expect(store.loadLabValues()).toHaveLength(1); // loadLabValues() is already active-only
  });
});

// US-66 AC6: a core test's name writes its core row, range-checked on the
// converted value. A refused number reaches the caller to show, not dropped.
describe('RoadmapStore.bulkSaveLabValues with a core name (US-66 AC6)', () => {
  it('hands back an out-of-range core value as a measurement refusal', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    const picked: PickedReport[] = [{ report: 'labs.pdf', reportDate: '2024-06-01', values: [{ name: 'LDL-C', value: 99999, unit: 'mg/dL' }] }];
    const { s } = await pickOf(store.file, picked);
    const review = uploadReview(s, store.file, new Date().toISOString());
    const result = await uploadThrough(store, picked);
    // The upload's review holds it as unsure, for the person to clear, and Save writes none of it (roadmap-data.ts saveUpload).
    expect(review.classification.values.map((v) => v.group)).toEqual(['unsure']);
    expect(result).toMatchObject({ ok: true, outcome: { values: 0 } });
    // The record's one bulk rule, which the Save's commit runs, hands it back as a measurement refusal.
    const rule = bulkAppendValues(store.file, [{ kind: 'lab', metricName: 'LDL-C', value: 99999, unit: 'mg/dL', recordedAt: '2024-06-01T00:00:00.000Z', source: 'manual' }], new Date().toISOString());
    expect(rule.saved).toHaveLength(0);
    expect(rule.measurementRefusals).toEqual([expect.objectContaining({ metricType: 'ldl', reason: 'out-of-range', bound: 'above' })]);
    expect([...store.file.labValues, ...store.file.measurements]).toEqual([]);
  });
});
