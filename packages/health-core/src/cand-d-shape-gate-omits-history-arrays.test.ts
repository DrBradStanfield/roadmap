/**
 * Witness for the parked lead `record/shape-gate-omits-history-arrays`.
 *
 * `assertRecordShape` (roadmap-doc.ts) refuses a present non-list for the
 * four ROW_ARRAYS (measurements, labValues, medications, supplements), but
 * ROADMAP_DOC.rowIds counts seven id-carrying arrays — documents,
 * medicationHistory, supplementHistory are in rowIds yet not in the gate,
 * and migrate's asArray turns their present non-list into [] BEFORE the
 * rowIds write check, so an ordinary save replaces those rows while a
 * non-list in a gated field is still refused.
 *
 * Built at the merge/save level (SyncManager over MemoryCloud, the
 * roadmap-doc.test.ts `syncOver` pattern) with dummy data only.
 *
 * Violated contract: US-31 AC8 — the load-time shape gate that "refuses a
 * file that carries schemaVersion but holds junk where its rows belong"
 * must cover every id-carrying row array, not only the four it started with.
 */
import { describe, it, expect } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordShapeError } from './migrate';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const DAY = '2026-09-01T00:00:00.000Z';

/** A raw record holding one real measurement plus whatever junk a case needs. */
function rawRecord(overrides: Record<string, unknown>): string {
  const file = createEmptyFile({ deviceId: 'cand-d-shape-gate', now: DAY }) as unknown as Record<string, unknown>;
  file.measurements = [createMeasurement({ id: 'w1', metricType: 'weight', value: 82, recordedAt: DAY, createdAt: DAY })];
  return JSON.stringify({ ...file, ...overrides });
}

type Sync = ReturnType<typeof recordSync>;

function syncOver(json: string): { cloud: MemoryCloud; sync: Sync } {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json, version: 1 });
  return { cloud, sync: recordSync(new MemoryAdapter(cloud), 'cand-d-shape-gate', DAY) };
}

/** The ordinary save every edit runs: load, add one more row, save. */
async function ordinarySave(sync: Sync): Promise<RoadmapFile> {
  const file = await sync.load();
  file.measurements.push(createMeasurement({ id: 'w2', metricType: 'hdl', value: 1.4, recordedAt: DAY, createdAt: DAY }));
  const saved = await sync.save(file);
  return saved.file;
}

/** One uploaded lab report's metadata row, as a proper list entry. */
const SCAN_ROW = {
  id: 'synthetic-doc',
  title: 'Synthetic scan',
  type: 'lab_report',
  date: '2026-09-01',
  fileRef: 'documents/synthetic-doc.pdf',
  contentHash: 'sha256-synthetic',
  mimeType: 'application/pdf',
  extractedText: 'synthetic extraction',
  addedAt: DAY,
};

function rawAfter(cloud: MemoryCloud): Record<string, unknown> {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
}

describe('cand-d witness: the shape gate omits the rowIds history arrays', () => {
  it('CONTROL (gated field): a non-list labValues is refused and the stored bytes are preserved', async () => {
    const { cloud, sync } = syncOver(rawRecord({ labValues: 'SYNTHETIC_NOT_A_LIST' }));
    await expect(sync.load()).rejects.toThrow(/labValues is not a list/);
    expect(rawAfter(cloud).labValues).toBe('SYNTHETIC_NOT_A_LIST');
  });

  it('CONTROL (append-only kept): populated documents rows survive an ordinary save', async () => {
    const { cloud, sync } = syncOver(rawRecord({ documents: [SCAN_ROW] }));
    await ordinarySave(sync);
    expect((rawAfter(cloud).documents as Array<{ id: string }>).map((d) => d.id)).toContain('synthetic-doc');
  });

  it('WITNESS: a record whose documents is a string is refused like its gated siblings', async () => {
    const { sync } = syncOver(rawRecord({ documents: 'SYNTHETIC_NOT_A_LIST' }));
    await expect(sync.load()).rejects.toBeInstanceOf(RecordShapeError);
  });

  it('WITNESS: an ordinary save does not rewrite a non-list documents field', async () => {
    const { cloud, sync } = syncOver(rawRecord({ documents: 'SYNTHETIC_NOT_A_LIST' }));
    // Adapted post-fix (US-31 AC8): gated like its siblings, the save now
    // REFUSES the whole write — the same graceful RecordShapeError the load
    // throws — instead of silently rewriting the field. Bytes untouched.
    await expect(ordinarySave(sync)).rejects.toBeInstanceOf(RecordShapeError);
    expect(rawAfter(cloud).documents).toBe('SYNTHETIC_NOT_A_LIST');
  });

  it('WITNESS: document rows held in a non-list shape are not dropped by an ordinary save', async () => {
    const { cloud, sync } = syncOver(rawRecord({ documents: { 'synthetic-doc': SCAN_ROW } }));
    // Adapted post-fix (US-31 AC8): the gate refuses the non-list shape, so
    // the rows it holds are neither loaded away nor written out — nothing is
    // dropped, and the bytes still carry them.
    await expect(sync.load()).rejects.toBeInstanceOf(RecordShapeError);
    expect(rawAfter(cloud).documents).toMatchObject({ 'synthetic-doc': { id: 'synthetic-doc' } });
  });

  it.each(['medicationHistory', 'supplementHistory'])('US-31 AC8: %s alone refuses and preserves bytes', async (field) => {
    const raw = rawRecord({ [field]: { saved: SCAN_ROW } });
    const { cloud, sync } = syncOver(raw);
    await expect(ordinarySave(sync)).rejects.toBeInstanceOf(RecordShapeError);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(raw);
  });
  it.each([null, undefined])('keeps optional absent/null arrays compatible: %s', async (value) => {
    const { sync } = syncOver(rawRecord({ documents: value, medicationHistory: value, supplementHistory: value }));
    await expect(ordinarySave(sync)).resolves.toBeDefined();
  });
});
