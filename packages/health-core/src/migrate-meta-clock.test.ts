import { describe, expect, it } from 'vitest';
import { migrateFile } from './migrate';
import { mergeFiles } from './merge';
import { createEmptyFile, createMeasurement, type FileDocument } from './roadmap-file';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter } from './memory-adapter';
import { recordSync } from './roadmap-doc';
import { upsertMedication } from './state-edits';

const EARLY = '2026-09-03T00:00:00.000Z';
const LATE = '2026-10-26T00:00:00.000Z';
const VALID = '2026-08-01T00:00:00.000Z';
const ROW = '2026-09-15T00:00:00.000Z';
const BAD = '2026-99-01T00:00:00Z';
const ctx = (now: string, deviceId = 'synthetic') => ({ now, deviceId });
function rawFile() {
  const raw = createEmptyFile(ctx(VALID));
  raw.measurements = [createMeasurement({ id: 'synthetic-weight', metricType: 'weight', value: 70,
    recordedAt: '2026-07-01', createdAt: ROW })];
  raw.labValues = [{ id: 'synthetic-lab', metricName: 'ferritin', value: 85, unit: 'µg/L',
    referenceLow: null, referenceHigh: null, recordedAt: '2026-07-01', createdAt: ROW,
    source: 'manual', status: 'active', correctsId: null }];
  return raw;
}

// US-10 AC8a: metadata recovery is a function of the bytes, not the reader clock.
describe('metadata clock recovery', () => {
  it('recovers only known clocks, not timestamp-looking extension data', () => {
    const raw = rawFile();
    raw.meta.createdAt = raw.meta.updatedAt = BAD;
    const extended = { ...raw, extension: { updatedAt: LATE },
      measurements: raw.measurements.map((r) => ({ ...r, updatedAt: LATE })),
      recommendationSnapshots: [{ date: '2026-07-01', updatedAt: LATE }] };
    expect(migrateFile(extended, ctx(EARLY)).meta.updatedAt).toBe(ROW);
  });


  it.each([
    ['2026-08-01', VALID],
    ['2026-08-01t00:00:00z', VALID],
    ['2026-08-01 02:00:00+02', VALID],
    ['2026-08-01T02:00:00+02:00', VALID],
    ['2026-08-01T14:00:00+14:00', VALID],
    ['2026-08-01T00:00Z', '2026-08-01T00:00Z'],
    ['2026-08-01T00:00:00.123456789Z', '2026-08-01T00:00:00.123456789Z'],
    ['2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'],
  ])('preserves accepted metadata granularity and future policy: %s', (stamp, expected) => {
    const raw = rawFile();
    raw.meta.createdAt = raw.meta.updatedAt = stamp;
    const first = migrateFile(raw, ctx(EARLY));
    expect(first.meta.createdAt).toBe(expected);
    expect(first.meta.updatedAt).toBe(expected);
    expect(migrateFile(raw, ctx(LATE))).toEqual(first);
    expect(migrateFile(first, ctx(LATE))).toEqual(first);
  });

  it.each([BAD, '2026-08-01T99:00:00Z', '2026-08-01T00:00:00ZZZ',
    '2026-02-30T00:00:00Z', '2026-08-01T00:00:00+15:00', '2026-08-01T00:00:00+23:00'])
  ('rejects the same malformed grammar for metadata and mutable rows: %s', (bad) => {
    const raw = upsertMedication(rawFile(), { medicationKey: 'statin', drugName: 'Synthetic', doseValue: null, doseUnit: null }, VALID).file;
    raw.meta.updatedAt = bad;
    raw.medications[0].updatedAt = bad;
    const file = migrateFile(raw, ctx(EARLY));
    expect(file.meta.updatedAt).toBe(VALID);
    expect(file.medications[0].updatedAt).toBe('');
  });

  // Preserve the published PR's real medication/save controls, replacing its
  // rejected assertion that malformed metadata should take the reader's now.
  it.each([VALID, BAD])('an offline medication edit survives load/save/fresh read with anchor %s', async (anchor) => {
    const med = { medicationKey: 'statin' as const, drugName: 'Synthetic', doseValue: 10, doseUnit: 'mg' };
    const original = upsertMedication(rawFile(), med, VALID).file;
    const adapter = new MemoryAdapter();
    const seeded = await adapter.write(ROADMAP_FILE_NAME, original, null);
    const offline = await recordSync(adapter, 'offline', LATE).load();
    const raw = structuredClone(original);
    raw.meta.updatedAt = anchor;
    raw.medications[0].updatedAt = '2099-01-01T00:00:00.000Z';
    await adapter.write(ROADMAP_FILE_NAME, raw, seeded.version);
    const stored = await adapter.read(ROADMAP_FILE_NAME);
    const sync = recordSync(adapter, 'editor', LATE);
    const loaded = await sync.load();
    expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual(stored);
    expect(loaded.meta.updatedAt).toBe(VALID);
    expect(loaded.medications[0].updatedAt).toBe(VALID);
    const edit = upsertMedication(offline, { ...med, doseValue: 20 }, LATE).file;
    for (const [a, b] of [[loaded, edit], [edit, loaded]]) expect(mergeFiles(a, b, ctx(LATE)).medications[0].doseValue).toBe(20);
    await sync.save(edit);
    const fresh = await recordSync(adapter, 'fresh', LATE).load();
    expect(fresh.medications[0].doseValue).toBe(20);
  });

  it('keeps a valid future medication clock and an edit made after reading it', async () => {
    const future = '2099-01-01T00:00:00.000Z';
    const med = { medicationKey: 'statin' as const, drugName: 'Synthetic', doseValue: 10, doseUnit: 'mg' };
    const raw = upsertMedication(rawFile(), med, future).file;
    const adapter = new MemoryAdapter();
    await adapter.write(ROADMAP_FILE_NAME, raw, null);
    const sync = recordSync(adapter, 'editor', LATE);
    const loaded = await sync.load();
    expect(loaded.meta.updatedAt).toBe(future);
    expect(loaded.medications[0].updatedAt).toBe(future);
    const edit = upsertMedication(loaded, { ...med, doseValue: 20 }, LATE).file;
    for (const [a, b] of [[loaded, edit], [edit, loaded]]) expect(mergeFiles(a, b, ctx(LATE)).medications[0].doseValue).toBe(20);
    await sync.save(edit);
    expect((await recordSync(adapter, 'fresh', LATE).load()).medications[0].doseValue).toBe(20);
  });

  it('normalizes both malformed clocks read-only, then persists recovery on ordinary save', async () => {
    const raw = rawFile();
    raw.meta.createdAt = raw.meta.updatedAt = BAD;
    const adapter = new MemoryAdapter();
    await adapter.write(ROADMAP_FILE_NAME, raw, null);
    const stored = await adapter.read(ROADMAP_FILE_NAME);
    const sync = recordSync(adapter, 'synthetic', EARLY);
    const loaded = await sync.load();
    expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual(stored);
    expect(loaded).toEqual(migrateFile(raw, ctx(LATE)));
    const saved = await sync.save(loaded);
    const fresh = await recordSync(adapter, 'synthetic', LATE).load();
    expect(fresh).toEqual(saved.file);
    expect(fresh.measurements).toEqual(raw.measurements);
    expect(fresh.meta.createdAt).toBe(ROW);
  });

  it.each([VALID, BAD])('preserves document tombstones and listed erasure with metadata %s', async (anchor) => {
    const doc: FileDocument = { id: 'synthetic-document', sourceFileName: 'Synthetic', title: 'Synthetic',
      type: 'clinic_letter', date: '2026-07-01', fileRef: '', contentHash: '', mimeType: '',
      extractedText: 'Synthetic', addedAt: ROW };
    const live = rawFile(), dead = rawFile();
    live.meta.createdAt = BAD;
    live.meta.updatedAt = anchor;
    live.documents = [doc];
    dead.meta.updatedAt = LATE;
    dead.documents = [{ ...doc, deleted: true }];
    const a = migrateFile(live, ctx(EARLY)), b = migrateFile(dead, ctx(LATE));
    for (const [x, y] of [[a, b], [b, a]]) {
      const merged = mergeFiles(x, y, ctx(LATE));
      expect(merged.documents).toEqual(dead.documents);
      const adapter = new MemoryAdapter();
      await recordSync(adapter, 'editor', LATE).save(merged);
      expect((await recordSync(adapter, 'fresh', LATE).load()).documents).toEqual(dead.documents);
    }
    const erased = createEmptyFile(ctx(LATE));
    erased.meta.eraseEpoch = 1;
    erased.erasedRows = { fromEpoch: 1, ids: [live.measurements[0].id, doc.id] };
    for (const [x, y] of [[a, erased], [erased, a]]) {
      const merged = mergeFiles(x, y, ctx(LATE));
      expect(merged.measurements).toEqual([]);
      expect(merged.documents).toEqual([]);
    }
  });

  // US-10 AC2: status absorption requires identical immutable content, even
  // when a companion fallback is earlier than one revision's row clock.
  it.each([VALID, BAD])('different metadata (%s) never revives a deleted measurement or lab', async (anchor) => {
    const live = rawFile(), dead = rawFile();
    live.meta.createdAt = BAD;
    live.meta.updatedAt = anchor;
    live.labValues = [{ id: 'synthetic-lab', metricName: 'ferritin', value: 85, unit: 'µg/L',
      referenceLow: null, referenceHigh: null, recordedAt: '2026-07-01', createdAt: ROW,
      source: 'manual', status: 'active', correctsId: null }];
    dead.meta.updatedAt = LATE;
    dead.measurements = live.measurements.map((r) => ({ ...r, status: 'entered-in-error' }));
    dead.labValues = live.labValues.map((r) => ({ ...r, status: 'entered-in-error' }));
    const a = migrateFile(live, ctx(EARLY)), b = migrateFile(dead, ctx(LATE));
    expect(a.measurements[0].createdAt).toBe(ROW);
    expect(a.labValues[0].createdAt).toBe(ROW);
    for (const [x, y] of [[a, b], [b, a]]) {
      const merged = mergeFiles(x, y, ctx(LATE));
      expect(merged.measurements).toEqual(dead.measurements);
      expect(merged.labValues).toEqual(dead.labValues);
      expect(migrateFile(merged, ctx(EARLY)).measurements).toEqual(dead.measurements);
      expect(migrateFile(merged, ctx(EARLY)).labValues).toEqual(dead.labValues);
      const adapter = new MemoryAdapter();
      await recordSync(adapter, 'editor', LATE).save(merged);
      const fresh = await recordSync(adapter, 'fresh', LATE).load();
      expect(fresh.measurements).toEqual(dead.measurements);
      expect(fresh.labValues).toEqual(dead.labValues);
    }
  });

  it.each([
    { createdAt: BAD, updatedAt: BAD },
    { createdAt: '', updatedAt: null },
    {},
  ])('recovers two unknown metadata clocks from the latest valid row clock: %j', (meta) => {
    const raw = { ...rawFile(), meta: { ...meta, lastDeviceId: 'synthetic' } };
    const bytes = JSON.stringify(raw);
    const a = migrateFile(JSON.parse(bytes), ctx(EARLY));
    const b = migrateFile(JSON.parse(bytes), ctx(LATE));
    expect(a.meta.createdAt).toBe(ROW);
    expect(a.meta.updatedAt).toBe(ROW);
    expect(a).toEqual(b);
    expect(migrateFile(a, ctx(LATE))).toEqual(a);
    expect(migrateFile(JSON.parse(bytes), ctx(LATE, 'other-device'))).toEqual(a);
    expect(a.measurements[0].createdAt).toBe(ROW);
    for (const pair of [[a, b], [b, a]]) expect(mergeFiles(pair[0], pair[1], ctx(LATE)).measurements).toHaveLength(1);
  });

  it('uses the epoch for absent metadata without row clocks, not a reader clock', () => {
    const raw = { schemaVersion: 1 };
    const a = migrateFile(raw, ctx(EARLY));
    expect(a.meta.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(a.meta.updatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(migrateFile(raw, ctx(LATE))).toEqual(a);
    expect(migrateFile(a, ctx(LATE))).toEqual(a);
  });

  it.each(['createdAt', 'updatedAt'] as const)('recovers invalid %s from its valid companion at either reader time', (field) => {
    const raw = rawFile();
    raw.meta[field] = BAD;
    const bytes = JSON.stringify(raw);
    const first = migrateFile(JSON.parse(bytes), ctx(EARLY));
    const second = migrateFile(JSON.parse(bytes), ctx(LATE));
    expect(first.meta.createdAt).toBe(VALID);
    expect(first.meta.updatedAt).toBe(VALID);
    expect(first).toEqual(second);
    expect(migrateFile(JSON.parse(bytes), ctx(LATE, 'other-device'))).toEqual(first);
    expect(migrateFile(first, ctx(LATE))).toEqual(first);
    for (const [a, b] of [[first, second], [second, first]]) {
      expect(mergeFiles(a, b, ctx(LATE)).measurements).toHaveLength(1);
      expect(mergeFiles(a, b, ctx(LATE)).measurements[0].id).toBe('synthetic-weight');
      expect(mergeFiles(a, b, ctx(LATE)).labValues).toEqual(raw.labValues);
    }
    expect(JSON.stringify(raw)).toBe(bytes);
  });
});
