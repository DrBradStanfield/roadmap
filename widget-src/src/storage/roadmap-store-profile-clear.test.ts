import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T10:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('US-10 AC9: clearing Birth Month persists a stamped null through save and fresh load', async () => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  expect(store.saveChangedMeasurements({ birthMonth: 5, heightCm: 178 }, {})).toBe(true);
  await store.flush();
  const saved: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

  vi.advanceTimersByTime(1000);
  // HealthTool omits a cleared field from currentPrefill, but retains its
  // previous value in previousPrefill. This is a removal, not an absent edit.
  expect(store.saveChangedMeasurements({}, { birthMonth: 5 })).toBe(true);
  await store.flush();
  const cleared: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  expect(cleared.profile.birthMonth).toBeNull();
  expect(cleared.profile.fieldStamps!.birthMonth.updatedAt).not.toBe(saved.profile.fieldStamps!.birthMonth.updatedAt);
  expect(cleared.profile.fieldStamps!.heightCm).toEqual(saved.profile.fieldStamps!.heightCm);
  expect(cleared.profile.heightCm).toBe(178);

  const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
  expect(reloaded.getPrefillInputs().birthMonth).toBeUndefined();
});

it.each([
  ['heightCm', 178],
  ['birthYear', 1980],
] as const)('US-10 AC9: clearing %s persists without changing other profile fields', async (field, value) => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ sex: 'male', [field]: value }, {});
  await store.flush();
  vi.advanceTimersByTime(1000);
  store.saveChangedMeasurements({ [field]: undefined }, { [field]: value });
  await store.flush();
  const saved: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  expect(saved.profile[field]).toBeNull();
  expect(saved.profile.sex).toBe('male');
  expect((await RoadmapStore.create(new MemoryAdapter(cloud))).getPrefillInputs()[field]).toBeUndefined();
});

it('US-10 AC9: an absent unchanged field writes nothing', async () => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ birthMonth: 5 }, {});
  await store.flush();
  const before = { ...cloud.files.get(ROADMAP_FILE_NAME)! };
  vi.advanceTimersByTime(1000);
  store.saveChangedMeasurements({}, {});
  // Explicit flush is a forced save even without edits; observe the normal
  // debounce instead, so this checks whether the no-op scheduled a write.
  await vi.advanceTimersByTimeAsync(2000);
  expect(cloud.files.get(ROADMAP_FILE_NAME)).toEqual(before);
});

it('US-10 AC6, AC9: a stale different-field edit cannot restore a cleared month', async () => {
  const cloud = new MemoryCloud();
  const clearing = await RoadmapStore.create(new MemoryAdapter(cloud));
  clearing.saveChangedMeasurements({ birthMonth: 5, birthYear: 1980, heightCm: 178 }, {});
  await clearing.flush();
  const stale = await RoadmapStore.create(new MemoryAdapter(cloud));
  vi.advanceTimersByTime(1000);
  clearing.saveChangedMeasurements({}, { birthMonth: 5 });
  await clearing.flush();
  const clear: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

  vi.advanceTimersByTime(1000);
  stale.saveChangedMeasurements(
    { birthYear: 1981, birthMonth: 5, heightCm: 178 },
    { birthYear: 1980, birthMonth: 5, heightCm: 178 },
  );
  await stale.flush();
  const merged: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  expect(merged.profile).toMatchObject({ birthMonth: null, birthYear: 1981, heightCm: 178 });
  expect(merged.profile.fieldStamps!.birthMonth).toEqual(clear.profile.fieldStamps!.birthMonth);

  // Clearing is not permanent: an intentional later value wins normally.
  const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
  vi.advanceTimersByTime(1000);
  reloaded.saveChangedMeasurements({ birthMonth: 6 }, {});
  await reloaded.flush();
  expect((await RoadmapStore.create(new MemoryAdapter(cloud))).getPrefillInputs().birthMonth).toBe(6);
});

it('US-10 AC9: an erase mismatch refuses a clear without changing the saved record', async () => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ birthMonth: 5 }, {});
  await store.flush();
  const before = { ...cloud.files.get(ROADMAP_FILE_NAME)! };
  expect(store.saveChangedMeasurements({}, { birthMonth: 5 }, 'not-the-shown-erase')).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(cloud.files.get(ROADMAP_FILE_NAME)).toEqual(before);
});

it('US-60 AC2: a hand-edited alcohol value never reaches the form; the two answers do', async () => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ heightCm: 178 }, {});
  await store.flush();
  const file: RoadmapFile = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  for (const [stored, read] of [['sometimes', undefined], ['none', 'none'], ['drinks', 'drinks']] as const) {
    cloud.files.set(ROADMAP_FILE_NAME, { ...cloud.files.get(ROADMAP_FILE_NAME)!, json: JSON.stringify({ ...file, profile: { ...file.profile, alcohol: stored } }) });
    expect((await RoadmapStore.create(new MemoryAdapter(cloud))).getPrefillInputs().alcohol).toBe(read);
  }
});
