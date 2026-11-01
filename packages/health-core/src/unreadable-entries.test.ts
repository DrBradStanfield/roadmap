/**
 * US-65 (Brad 2026-11-01): a record with entries this build cannot read still
 * opens, and every save carries those entries back verbatim. Synthetic values
 * only.
 */
import { describe, it, expect } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { buildErasedFile } from './erase';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeFiles, stampFields } from './merge';
import { migrateFile } from './migrate';
import { unreadableCount } from './readable-rows';
import { ROADMAP_DOC, recordSync } from './roadmap-doc';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const DAY = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-05T00:00:00.000Z';
const CTX = { deviceId: 'dev_us64', now: LATER };

const WEIGHT = createMeasurement({ id: 'w1', metricType: 'weight', value: 82, recordedAt: DAY, createdAt: DAY });
/** A newer app's metric: this build has no such metricType. */
const FUTURE = { ...createMeasurement({ id: 'f1', metricType: 'weight', value: 5, recordedAt: DAY, createdAt: DAY }), metricType: 'synthetic_future_metric', extra: { kept: true } };
/** A row whose value is a word. */
const WORDY = { ...createMeasurement({ id: 'v1', metricType: 'hdl', value: 1, recordedAt: DAY, createdAt: DAY }), value: 'synthetic' };

function rawRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  const file = createEmptyFile({ deviceId: 'dev_writer', now: DAY }) as unknown as Record<string, unknown>;
  return { ...file, measurements: [WEIGHT], ...overrides };
}

function cloudWith(raw: unknown): { cloud: MemoryCloud; sync: ReturnType<typeof recordSync> } {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(raw), version: 1 });
  return { cloud, sync: recordSync(new MemoryAdapter(cloud), CTX.deviceId, LATER) };
}

const stored = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as Record<string, any>;

describe('US-65 AC1: an unknown metric row', () => {
  it('opens the record, shows the other rows, and survives a save byte-equal', async () => {
    const { cloud, sync } = cloudWith(rawRecord({ measurements: [WEIGHT, FUTURE] }));
    const file = await sync.load();
    expect(file.measurements.map((m) => m.id)).toEqual(['w1']);
    expect(unreadableCount(file)).toBe(1);

    file.measurements.push(createMeasurement({ id: 'w2', metricType: 'hdl', value: 1.4, recordedAt: LATER, createdAt: LATER }));
    await sync.save(file);
    const after = stored(cloud);
    expect(after.measurements.map((m: { id: string }) => m.id).sort()).toEqual(['w1', 'w2']);
    expect(after.unreadable.measurements.map((r: unknown) => JSON.stringify(r))).toEqual([JSON.stringify(FUTURE)]);
  });

  it('a null, an id-less row and a malformed day are kept too, not dropped (supersedes US-10 AC7, US-29 AC4a)', async () => {
    const noId = { ...WEIGHT, id: '' };
    const badDay = { ...WEIGHT, id: 'd1', recordedAt: 'not-a-day' };
    const { cloud, sync } = cloudWith(rawRecord({ measurements: [WEIGHT, null, noId, badDay] }));
    await sync.save(await sync.load());
    expect(stored(cloud).measurements.map((m: { id: string }) => m.id)).toEqual(['w1']);
    expect(stored(cloud).unreadable.measurements).toHaveLength(3);
  });
});

describe('US-65 AC2: a wrongly typed field', () => {
  it('a row with a wrongly typed value is parked, not computed with', () => {
    const file = ROADMAP_DOC.migrate(rawRecord({ measurements: [WEIGHT, WORDY] }), CTX);
    expect(file.measurements.map((m) => m.id)).toEqual(['w1']);
    expect(file.unreadable?.measurements).toEqual([WORDY]);
  });

  it('a wrongly typed profile field reads as absent, keeps its clock, and is written back raw', async () => {
    const profile = { updatedAt: DAY, lamport: 3, sex: 'female', heightCm: 'synthetic-tall' };
    const { cloud, sync } = cloudWith(rawRecord({ profile }));
    const file = await sync.load();
    expect(file.profile.heightCm).toBeUndefined();
    expect(file.profile.sex).toBe('female');
    expect(unreadableCount(file)).toBe(1);
    await sync.save(file);
    expect(stored(cloud).unreadable.profile).toEqual({ heightCm: { value: 'synthetic-tall', updatedAt: DAY, lamport: 3 } });
    expect(stored(cloud).profile.heightCm).toBeUndefined();
  });

  it('a later height written on this device supersedes the parked one', () => {
    const file = migrateFile(rawRecord({ profile: { updatedAt: DAY, lamport: 1, heightCm: 'synthetic-tall' } }), CTX);
    const edited = { ...file, profile: stampFields(file.profile, { heightCm: 170 }, LATER) };
    const merged = mergeFiles(edited, file, CTX);
    expect(merged.profile.heightCm).toBe(170);
    expect(merged.unreadable).toBeUndefined();
    expect(migrateFile(JSON.parse(JSON.stringify(merged)), CTX).unreadable).toBeUndefined();
  });

  it('a parked field still wins over an older readable value from another copy', () => {
    const older = migrateFile(rawRecord({ profile: { updatedAt: DAY, lamport: 1, heightCm: 160 } }), CTX);
    const newer = migrateFile(rawRecord({ profile: { updatedAt: LATER, lamport: 2, heightCm: 'synthetic-tall' } }), CTX);
    for (const merged of [mergeFiles(older, newer, CTX), mergeFiles(newer, older, CTX)]) {
      expect(merged.profile.heightCm).toBeUndefined();
      expect(merged.unreadable?.profile?.heightCm?.value).toBe('synthetic-tall');
    }
  });
});

describe('US-65 AC3: merge of two files each holding unreadable rows', () => {
  it('unions the rows, one copy of each, in either order, and leaves scalars and the epoch alone', () => {
    const shared = { ...FUTURE, id: 'shared' };
    const a = migrateFile(rawRecord({ measurements: [WEIGHT, FUTURE, shared], profile: { updatedAt: DAY, lamport: 1, sex: 'male' } }), CTX);
    const b = migrateFile(rawRecord({ measurements: [WORDY, shared], profile: { updatedAt: LATER, lamport: 2, sex: 'female' } }), CTX);
    const ab = mergeFiles(a, b, CTX);
    const ba = mergeFiles(b, a, CTX);
    expect(ab.unreadable).toEqual(ba.unreadable);
    expect(ab.unreadable?.measurements).toHaveLength(3);
    expect(ab.profile.sex).toBe('female');
    expect(ab.meta.eraseEpoch ?? 0).toBe(0);
    expect(ab.measurements.map((m) => m.id)).toEqual(['w1']);
    // Re-merging changes nothing.
    expect(mergeFiles(ab, b, CTX).unreadable).toEqual(ab.unreadable);
  });

  it('a reused id with different content keeps both raw copies untouched', () => {
    const a = migrateFile(rawRecord({ measurements: [FUTURE] }), CTX);
    const b = migrateFile(rawRecord({ measurements: [{ ...FUTURE, value: 6 }] }), CTX);
    const rows = mergeFiles(a, b, CTX).unreadable?.measurements as Array<{ id: string; value: number }>;
    expect(rows.map((r) => [r.id, r.value])).toEqual([['f1', 5], ['f1', 6]]);
  });
});

describe('US-65 AC4: erasing still erases', () => {
  it('the erased file holds no unreadable entries, lists their ids, and a stale copy cannot bring them back', () => {
    const before = migrateFile(rawRecord({ measurements: [WEIGHT, FUTURE], profile: { updatedAt: DAY, heightCm: 'synthetic-tall' } }), CTX);
    const erased = buildErasedFile({ stored: before, own: before, device: null, ctx: CTX });
    expect(erased.unreadable).toBeUndefined();
    expect(erased.erasedRows?.ids).toContain('f1');
    for (const merged of [mergeFiles(erased, before, CTX), mergeFiles(before, erased, CTX)]) {
      expect(merged.unreadable).toBeUndefined();
      expect(merged.measurements).toEqual([]);
    }
  });

  it('past an erase that listed nothing, a stale copy keeps no unreadable row from before it', () => {
    const before = migrateFile(rawRecord({ measurements: [FUTURE] }), CTX);
    const erased = migrateFile({ ...rawRecord({ measurements: [] }), meta: { ...createEmptyFile({ deviceId: 'x', now: LATER }).meta, eraseEpoch: 1, erasedAt: LATER } }, CTX);
    expect(mergeFiles(erased, before, CTX).unreadable).toBeUndefined();
  });
});

describe('US-65 AC6: an older device never drops a newer device\'s rows', () => {
  it('rows parked by this build come back when a build can read them, and the record converges', async () => {
    // A newer app wrote FUTURE; this build saves the record with an edit of its own.
    const { cloud, sync } = cloudWith(rawRecord({ measurements: [WEIGHT, FUTURE] }));
    const file = await sync.load();
    file.measurements.push(createMeasurement({ id: 'w2', metricType: 'hdl', value: 1.4, recordedAt: LATER, createdAt: LATER }));
    await sync.save(file);
    expect(stored(cloud).unreadable.measurements).toEqual([FUTURE]);
    // A build that reads the parked row (here, one this build reads) takes it back into its array.
    const readableNow = createMeasurement({ id: 'n1', metricType: 'ldl', value: 3, recordedAt: DAY, createdAt: DAY });
    const back = migrateFile({ ...stored(cloud), unreadable: { measurements: [FUTURE, readableNow] } }, CTX);
    expect(back.measurements.map((m) => m.id).sort()).toEqual(['n1', 'w1', 'w2']);
    expect(back.unreadable?.measurements).toEqual([FUTURE]);
  });

  it('a profile field parked here comes back to a build that reads it', () => {
    const parked = migrateFile(rawRecord({ profile: { updatedAt: DAY, lamport: 1, heightCm: 'synthetic-tall' } }), CTX);
    const json = JSON.parse(JSON.stringify(parked)) as RoadmapFile;
    // A newer build reads the value: simulate it by a value this build reads.
    json.unreadable!.profile!.heightCm.value = 171;
    const back = migrateFile(json, CTX);
    expect(back.profile.heightCm).toBe(171);
    expect(back.unreadable).toBeUndefined();
  });

  it('a record with nothing unreadable is unchanged: no unreadable key, no added stamps', () => {
    const raw = rawRecord({ profile: { updatedAt: DAY, lamport: 1, heightCm: 170 } });
    const file = migrateFile(raw, CTX);
    expect('unreadable' in file).toBe(false);
    expect(file.profile).toEqual({ updatedAt: DAY, lamport: 1, heightCm: 170 });
  });
});
