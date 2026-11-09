// US-66: every blood test lives in `labValues`. The web store moves a record
// in the old shape as it opens it, writes it once (AC14), reports what moved
// by counts only (AC13), and shows core rows as the blood tests they are:
// in the history, never as extra lab rows (AC7, AC8, AC9).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile, createMeasurement, type RoadmapFile, createLabValue } from '@roadmap/health-core/roadmap-file';
import { measurementsToInputs } from '@roadmap/health-core/mappings';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from './roadmap-store';
import { LocalStorageAdapter } from './local-storage-adapter';
import { lpaRowsToCheck } from '../lib/lpa-unit';

const DAY = '2024-06-01T00:00:00.000Z';
const NOW = '2026-11-01T00:00:00.000Z';

const readCloudFile = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;

/** A record as an app built before US-66 wrote it: LDL beside the weight in `measurements`. */
async function seedOldShape(cloud: MemoryCloud, edit: (file: RoadmapFile) => void = () => {}): Promise<void> {
  const file = createEmptyFile({ deviceId: 'old_app', now: NOW });
  file.measurements.push(
    createMeasurement({ id: 'w1', metricType: 'weight', value: 80, recordedAt: DAY, createdAt: NOW }),
    createMeasurement({ id: 'ldl1', metricType: 'ldl', value: 3.2, recordedAt: DAY, createdAt: NOW }),
  );
  edit(file);
  await new MemoryAdapter(cloud).write(ROADMAP_FILE_NAME, file, null);
}

/** An adapter on `cloud` that counts its writes. */
function counted(cloud: MemoryCloud) {
  const adapter = new MemoryAdapter(cloud);
  const write = vi.spyOn(adapter, 'write');
  return { adapter, write };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('US-66 AC14: a record in the old shape is moved on open and written once', () => {
  it('writes the moved record once, and the next open writes nothing', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud);
    const first = counted(cloud);
    const store = await RoadmapStore.create(first.adapter);
    expect(await store.bloodTablesUnified).toEqual({ moved: 1, folded: 0, keptApart: 0 });
    expect(first.write).toHaveBeenCalledTimes(1);
    const file = readCloudFile(cloud);
    expect(file.measurements.map((m) => m.metricType)).toEqual(['weight']);
    expect(file.labValues).toMatchObject([{ id: 'ldl1', metricName: 'ldl', value: 3.2, unit: 'mmol/L', core: true, status: 'active' }]);

    const again = counted(cloud);
    const reopened = await RoadmapStore.create(again.adapter);
    expect(await reopened.bloodTablesUnified).toBeNull();
    await reopened.flush();
    expect(again.write).not.toHaveBeenCalled();
  });

  it('folds an old lab row named like a core test, and counts one it keeps apart', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud, (file) => {
      file.measurements = file.measurements.filter((m) => m.metricType === 'weight');
      file.labValues.push(
        createLabValue({ id: 'lab-hdl', metricName: 'HDL Cholesterol', value: 1.4, unit: 'mmol/L', recordedAt: DAY, createdAt: NOW }),
        createLabValue({ id: 'lab-cr', metricName: 'Creatinine', value: 80, unit: 'µmol/L', recordedAt: DAY, createdAt: NOW }),
      );
    });
    const { adapter, write } = counted(cloud);
    const store = await RoadmapStore.create(adapter);
    expect(await store.bloodTablesUnified).toEqual({ moved: 0, folded: 1, keptApart: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(measurementsToInputs(store.loadLatestMeasurements().previousMeasurements)).toMatchObject({ hdlC: 1.4 });
    // Creatinine is never folded (it may be urine): it stays an extra row.
    expect(store.loadLabValues().map((row) => row.metricName)).toEqual(['Creatinine']);
  });

  it('a record with nothing to move writes nothing and reports nothing', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud, (file) => { file.measurements = file.measurements.filter((m) => m.metricType === 'weight'); });
    const { adapter, write } = counted(cloud);
    const store = await RoadmapStore.create(adapter);
    expect(await store.bloodTablesUnified).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('a new record (nothing stored) reports nothing', async () => {
    const { adapter, write } = counted(new MemoryCloud());
    const store = await RoadmapStore.create(adapter);
    expect(await store.bloodTablesUnified).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('US-66 AC7 / AC8: the screens read core rows as blood tests', () => {
  it('a moved LDL is in the history and the plan inputs, and never an extra lab row', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud);
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.loadAllHistory().map((m) => [m.metricType, m.value]).sort()).toEqual([['ldl', 3.2], ['weight', 80]]);
    expect(measurementsToInputs(store.loadLatestMeasurements().previousMeasurements)).toMatchObject({ ldlC: 3.2 });
    expect(store.loadLabValues()).toEqual([]);
  });

  it('a typed blood test is saved as a core lab row and read back as a measurement', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const added = store.addMeasurement('apob', 0.9, DAY);
    expect(added).toMatchObject({ status: 'inserted', row: { metricType: 'apob', value: 0.9 } });
    expect(added.status === 'inserted' && 'metricName' in added.row).toBe(false);
    await store.flush();
    expect(readCloudFile(cloud)).toMatchObject({ measurements: [], labValues: [{ metricName: 'apob', core: true, unit: 'g/L' }] });
    expect(store.loadLabValues()).toEqual([]);
  });
});

describe('US-66 AC15: a saved record holding a core row is schemaVersion 3', () => {
  const readLocal = async (): Promise<RoadmapFile> => (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;

  it('the once-on-open write of a moved record is 3', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud);
    expect(readCloudFile(cloud).schemaVersion).toBe(1);
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(await store.bloodTablesUnified).toEqual({ moved: 1, folded: 0, keptApart: 0 }); // the write has landed
    expect(readCloudFile(cloud).schemaVersion).toBe(3);
  });

  it('the first blood test typed into a vitals-only record saves it as 3, in the cloud and on this device', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud, (file) => { file.measurements = file.measurements.filter((m) => m.metricType === 'weight'); });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.addMeasurement('apob', 0.9, DAY).status).toBe('inserted');
    await store.flush();
    expect(readCloudFile(cloud).schemaVersion).toBe(3);

    const local = createEmptyFile({ deviceId: 'old_app', now: NOW });
    await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, local, null);
    const device = await RoadmapStore.create(new LocalStorageAdapter());
    expect(device.addMeasurement('ldl', 3.1, DAY).status).toBe('inserted');
    await device.flush();
    expect((await readLocal()).schemaVersion).toBe(3);
  });

  it('a vitals-only record stays at 1 after a weight is typed', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud, (file) => { file.measurements = file.measurements.filter((m) => m.metricType === 'weight'); });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.addMeasurement('weight', 81, '2024-06-02T00:00:00.000Z').status).toBe('inserted');
    await store.flush();
    expect(readCloudFile(cloud).schemaVersion).toBe(1);
  });
});

describe('US-66 AC9: the Lp(a) check still fires on a moved Lp(a) row', () => {
  it('lpaRowsToCheck asks about a moved row typed while the field was mislabelled', async () => {
    const cloud = new MemoryCloud();
    await seedOldShape(cloud, (file) => {
      file.measurements.push(createMeasurement({
        id: 'lpa1', metricType: 'lpa', value: 37.44, recordedAt: DAY, createdAt: '2026-09-20T04:00:00.000Z', source: 'manual',
      }));
    });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    await store.bloodTablesUnified;
    expect(readCloudFile(cloud).labValues.some((row) => row.id === 'lpa1' && row.core)).toBe(true);
    expect(lpaRowsToCheck(store.loadAllHistory(), 'conventional')).toMatchObject([{ row: { id: 'lpa1' }, typed: 156 }]);
  });
});
