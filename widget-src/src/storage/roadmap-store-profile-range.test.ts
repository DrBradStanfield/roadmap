/**
 * US-02 AC5: a profile value outside its range never reaches the file,
 * whatever the caller (the form's autosave mid-typing, the chat, a stale tab).
 * The store refuses it as `addMeasurement` refuses a vital, and says why, so
 * the screen can show it. The other fields in the same save still write.
 * Synthetic values.
 */
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

const onDisk = (cloud: MemoryCloud): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

it.each([
  ['heightCm', 19, 'Height must be at least 50 cm'],
  ['heightCm', 300, 'Height must be at most 250 cm'],
  ['birthYear', 199, 'Birth year must be after 1900'],
] as const)('US-02 AC5: %s %s is refused, never written, and says why; the sex in the same save writes', async (field, value, message) => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  const result = store.saveChangedMeasurements({ sex: 'male', [field]: value }, {});
  expect(result).toEqual({ ok: true, birthRefused: null, refused: { [field]: message } });
  await store.flush();
  const file = onDisk(cloud);
  expect(file.profile[field] ?? null).toBeNull();
  expect(file.profile.sex).toBe('male');
});

it('US-02 AC5: a refused height leaves the saved one in place', async () => {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  store.saveChangedMeasurements({ heightCm: 178 }, {});
  await store.flush();
  vi.advanceTimersByTime(1000);
  expect(store.saveChangedMeasurements({ heightCm: 17 }, { heightCm: 178 })).toMatchObject({ ok: true, refused: { heightCm: 'Height must be at least 50 cm' } });
  await store.flush();
  expect(onDisk(cloud).profile.heightCm).toBe(178);
});
