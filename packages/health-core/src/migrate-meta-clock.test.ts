import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeFiles, stampInstant } from './merge';
import { hasStampShape, migrateFile } from './migrate';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, createMeasurement, type FileDocument } from './roadmap-file';
import { upsertMedication } from './state-edits';

const BEFORE = '2026-06-01T00:00:00.000Z';
const NOW = '2026-10-22T12:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';
const CTX = { deviceId: 'synthetic', now: NOW };
const MED = { medicationKey: 'statin' as const, drugName: 'Synthetic', doseValue: 10, doseUnit: 'mg' };
const base = () => upsertMedication(createEmptyFile({ ...CTX, now: BEFORE }), MED, BEFORE).file;
const BAD = ['2026-99-01T00:00:00Z', '2026-06-01T99:00:00Z', '2026-06-01T00:00:00ZZZ', '2026-02-30T00:00:00Z'];

// US-10 AC8 / US-29 AC4: malformed metadata must not defeat the existing
// sanitation anchor. Exercise the real edit and SyncManager persistence path.
describe('malformed metadata clocks', () => {
  it.each(BAD)('an offline medication edit survives an external malformed anchor %s', async (bad) => {
    for (const field of ['createdAt', 'updatedAt'] as const) {
      const original = base();
      const adapter = new MemoryAdapter(new MemoryCloud());
      const seeded = await adapter.write(ROADMAP_FILE_NAME, original, null);
      const offline = await recordSync(adapter, 'offline', NOW).load();
      const raw = structuredClone(original);
      raw.meta[field] = bad;
      raw.medications[0].updatedAt = FUTURE;
      await adapter.write(ROADMAP_FILE_NAME, raw, seeded.version);
      const sync = recordSync(adapter, 'editor', NOW);
      const edited = upsertMedication(offline, { ...MED, doseValue: 20 }, NOW).file;
      const loaded = await sync.load();
      const saved = await sync.save(edited);
      expect((await recordSync(adapter, 'fresh', NOW).load()).medications[0].doseValue).toBe(20);
      expect(saved.file.medications[0].doseValue).toBe(20);
      for (const [a, b] of [[loaded, edited], [edited, loaded]]) {
        expect(mergeFiles(a, b, CTX).medications[0].doseValue).toBe(20);
      }
      expect(migrateFile(raw, CTX).meta[field]).toBe(NOW);
    }
  });

  it('a valid old anchor still lets the offline edit win after save and fresh read', async () => {
    const original = base();
    const adapter = new MemoryAdapter();
    const seeded = await adapter.write(ROADMAP_FILE_NAME, original, null);
    const offline = await recordSync(adapter, 'offline', NOW).load();
    const raw = structuredClone(original);
    raw.medications[0].updatedAt = FUTURE;
    await adapter.write(ROADMAP_FILE_NAME, raw, seeded.version);
    const edited = upsertMedication(offline, { ...MED, doseValue: 20 }, NOW).file;
    const loaded = await recordSync(adapter, 'reader', NOW).load();
    expect(loaded.meta.updatedAt).toBe(BEFORE);
    expect(loaded.medications[0].updatedAt).toBe(BEFORE);
    for (const [a, b] of [[loaded, edited], [edited, loaded]]) {
      expect(mergeFiles(a, b, CTX).medications[0].doseValue).toBe(20);
    }
    await recordSync(adapter, 'editor', NOW).save(edited);
    expect((await recordSync(adapter, 'fresh', NOW).load()).medications[0].doseValue).toBe(20);
  });

  it.each(BAD)('fallback for %s is read-only, repeat-stable, and matches the existing shapeless fallback', async (bad) => {
    const raw = base();
    raw.meta.createdAt = bad;
    raw.meta.updatedAt = bad;
    raw.medications[0].updatedAt = FUTURE;
    const bytes = JSON.stringify(raw);
    const adapter = new MemoryAdapter();
    await adapter.write(ROADMAP_FILE_NAME, raw, null);
    const stored = await adapter.read(ROADMAP_FILE_NAME);
    const once = await recordSync(adapter, 'reader', NOW).load();
    expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual(stored);
    expect(JSON.stringify(raw)).toBe(bytes);
    expect(once.meta.createdAt).toBe(NOW);
    expect(once.meta.updatedAt).toBe(NOW);
    expect(once.medications[0].updatedAt).toBe(NOW);
    const later = { ...CTX, now: '2026-11-01T00:00:00.000Z' };
    expect(migrateFile(once, later)).toEqual(once);
    const shapeless = { ...raw, meta: { ...raw.meta, createdAt: '', updatedAt: '' } };
    expect(migrateFile(raw, CTX)).toEqual(migrateFile(shapeless, CTX));
    // Existing fallback is the reader's now, NOT a new deterministic repair.
    // Two readers of the raw malformed bytes can clamp to different clocks;
    // each normalized result is stable when subsequently read or persisted.
    const other = migrateFile(raw, later);
    expect(other.meta.updatedAt).toBe(later.now);
    expect(other.medications[0].updatedAt).toBe(later.now);
    expect(other).toEqual(migrateFile(shapeless, later));
    expect(other).not.toEqual(once);
    expect(migrateFile(other, CTX)).toEqual(other);
  });

  it.each([
    ['2026-06-01T02:00:00+02:00', BEFORE],
    ['2026-06-01T00:00:00.123456789Z', '2026-06-01T00:00:00.123456789Z'],
    ['2026-06-01T00:00Z', '2026-06-01T00:00Z'],
    [FUTURE, FUTURE],
  ])('preserves valid metadata behavior for %s', (stamp, expected) => {
    const raw = base();
    raw.meta.createdAt = stamp;
    raw.meta.updatedAt = stamp;
    raw.medications[0].updatedAt = stamp;
    const once = migrateFile(raw, CTX);
    expect(once.meta.createdAt).toBe(expected);
    expect(once.meta.updatedAt).toBe(expected);
    expect(once.medications[0].updatedAt).toBe(stamp);
    expect(migrateFile(raw, { ...CTX, now: FUTURE })).toEqual(once);
    expect(migrateFile(once, { ...CTX, now: FUTURE })).toEqual(once);
  });

  it('keeps the shape gate unchanged and invalid row clocks unknown', () => {
    expect(hasStampShape(BAD[0])).toBe(true);
    expect(hasStampShape('2026-06-01t00:00:00z')).toBe(false);
    expect(hasStampShape('2026-06-01')).toBe(false);
    expect(hasStampShape(42)).toBe(false);
    const raw = base();
    raw.meta.updatedAt = BAD[0];
    raw.medications[0].updatedAt = BAD[1];
    expect(migrateFile(raw, CTX).medications[0].updatedAt).toBe('');
    expect(Number.isNaN(stampInstant(BAD[0]))).toBe(true);
  });

  it('keeps valid self-consistent future clocks and protects an edit after reading them', async () => {
    const raw = upsertMedication(base(), MED, FUTURE).file;
    const adapter = new MemoryAdapter();
    await adapter.write(ROADMAP_FILE_NAME, raw, null);
    const sync = recordSync(adapter, 'editor', NOW);
    const loaded = await sync.load();
    expect(loaded.meta.updatedAt).toBe(FUTURE);
    expect(loaded.medications[0].updatedAt).toBe(FUTURE);
    const edit = upsertMedication(loaded, { ...MED, doseValue: 20 }, NOW).file;
    for (const [a, b] of [[loaded, edit], [edit, loaded]]) {
      expect(mergeFiles(a, b, CTX).medications[0].doseValue).toBe(20);
    }
    await sync.save(edit);
    expect((await recordSync(adapter, 'fresh', NOW).load()).medications[0].doseValue).toBe(20);
  });

  it.each([BEFORE, BAD[0]])('different metadata anchors (%s) never split a document or revive its deletion', async (anchor) => {
    const doc: FileDocument = { id: 'synthetic-document', sourceFileName: 'Synthetic', title: 'Synthetic',
      type: 'clinic_letter', date: '2026-06-01', fileRef: '', contentHash: '', mimeType: '',
      extractedText: 'Synthetic note', addedAt: FUTURE };
    const live = base(), dead = base();
    live.meta.updatedAt = anchor;
    dead.meta.updatedAt = NOW;
    live.documents = [doc];
    dead.documents = [{ ...doc, deleted: true }];
    const a = migrateFile(live, CTX), b = migrateFile(dead, CTX);
    expect(a.documents[0]).toEqual(doc);
    expect(b.documents[0]).toEqual({ ...doc, deleted: true });
    for (const [x, y] of [[a, b], [b, a]]) {
      const merged = mergeFiles(x, y, CTX);
      expect(merged.documents).toEqual([{ ...doc, deleted: true }]);
      const adapter = new MemoryAdapter();
      await recordSync(adapter, 'editor', NOW).save(merged);
      expect((await recordSync(adapter, 'fresh', NOW).load()).documents).toEqual([{ ...doc, deleted: true }]);
    }
  });

  it('keeps slot status absorption and listed erase behavior with a malformed anchor', () => {
    const a = base(), b = base();
    const row = createMeasurement({ id: 'synthetic-row', metricType: 'weight', value: 70,
      recordedAt: '2026-06-01', createdAt: BEFORE });
    a.meta.updatedAt = BAD[0];
    a.measurements = [row];
    b.measurements = [{ ...row, status: 'entered-in-error' }];
    const x = migrateFile(a, CTX), y = migrateFile(b, CTX);
    for (const [left, right] of [[x, y], [y, x]]) {
      expect(mergeFiles(left, right, CTX).measurements).toEqual([{ ...row, status: 'entered-in-error' }]);
    }
    const erased = createEmptyFile(CTX);
    erased.meta.eraseEpoch = 1;
    erased.erasedRows = { fromEpoch: 1, ids: [row.id] };
    for (const [left, right] of [[x, erased], [erased, x]]) {
      expect(mergeFiles(left, right, CTX).measurements).toEqual([]);
    }
  });
});
