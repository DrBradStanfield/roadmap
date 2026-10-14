// US-05 AC2: the unit the user chose for Lp(a)'s field is kept in the record,
// a profile preference stamped like any other, so it follows them across
// devices.
import { describe, it, expect } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';

const readCloudFile = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;

describe('RoadmapStore — profile.lpaUnit (US-05 AC2)', () => {
  it('reads absent until chosen, then writes the choice with its own field stamp', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.getLpaUnit()).toBeUndefined();

    store.setLpaUnit('mg/L');
    await store.flush();
    const file = readCloudFile(cloud);
    expect(file.profile.lpaUnit).toBe('mg/L');
    expect(file.profile.fieldStamps?.lpaUnit).toBeDefined();

    // Another device opens the record and reads the same choice.
    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(other.getLpaUnit()).toBe('mg/L');
  });

  it('choosing the unit already held writes nothing', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.setLpaUnit('mg/dL');
    await store.flush();
    const stamp = readCloudFile(cloud).profile.fieldStamps?.lpaUnit;

    store.setLpaUnit('mg/dL');
    await store.flush();
    expect(readCloudFile(cloud).profile.fieldStamps?.lpaUnit).toEqual(stamp);
  });
});
