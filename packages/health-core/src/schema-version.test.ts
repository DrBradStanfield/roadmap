/**
 * US-66 AC15: a record holding a core blood row is schemaVersion 3, so an app
 * from before US-66 refuses it ("update the app", US-65 AC5) and writes
 * nothing. A record with no core row keeps 1, or 2 when it carries an erase list.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildErasedFile } from './erase';
import { FileAdapter } from './file-adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeFiles } from './merge';
import { migrateFile, SchemaTooNewError } from './migrate';
import {
  appendLabValue, appendMeasurement, bulkAppendValues, correctValue, placeMeasurement,
} from './record-edits';
import { ROADMAP_DOC } from './roadmap-doc';
import {
  BASE_SCHEMA_VERSION, CORE_ROWS_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, ERASED_ROWS_SCHEMA_VERSION,
  createEmptyFile, createLabValue, createMeasurement, recordSchemaVersion, type RoadmapFile,
} from './roadmap-file';
import { SyncManager } from './sync-manager';
import { ROADMAP_FILE_NAME } from './adapter';
import { createCoreRow } from './blood-tests';

const CTX = { deviceId: 'dev_v3', now: '2026-11-02T10:00:00.000Z' };
const DAY = '2026-10-01';

const weight = (id: string) => createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: DAY, createdAt: `${DAY}T08:00:00.000Z` });
/** A blood test as a record from before US-66 held it: a measurement. */
const oldLdl = (id: string) => createMeasurement({ id, metricType: 'ldl', value: 2.1, recordedAt: DAY, createdAt: `${DAY}T08:00:00.000Z` });
const coreLdl = (id: string, status: 'active' | 'entered-in-error' = 'active') =>
  ({ ...createCoreRow({ id, metric: 'ldl', value: 2.1, recordedAt: DAY, createdAt: `${DAY}T08:00:00.000Z` }), status });

function file(version: number, opts: { measurements?: RoadmapFile['measurements']; labValues?: RoadmapFile['labValues']; erased?: boolean } = {}): RoadmapFile {
  const f = createEmptyFile(CTX);
  f.schemaVersion = version;
  f.measurements = opts.measurements ?? [];
  f.labValues = opts.labValues ?? [];
  if (opts.erased) {
    f.meta.eraseEpoch = 1;
    f.erasedRows = { fromEpoch: 1, ids: ['gone'] };
  }
  return f;
}
const raw = (f: RoadmapFile): unknown => JSON.parse(JSON.stringify(f));

describe('US-66 AC15: the version constants', () => {
  it('names 2 for the erase list and 3 for core rows; the app reads 3', () => {
    expect([BASE_SCHEMA_VERSION, ERASED_ROWS_SCHEMA_VERSION, CORE_ROWS_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]).toEqual([1, 2, 3, 3]);
  });
});

describe('US-66 AC15: recordSchemaVersion', () => {
  it('is 1 for a plain file, 2 with an erase list, 3 with a core row of any status', () => {
    expect(recordSchemaVersion(file(1, { measurements: [weight('w')] }))).toBe(1);
    expect(recordSchemaVersion(file(1, { erased: true }))).toBe(2);
    expect(recordSchemaVersion(file(1, { labValues: [coreLdl('c')] }))).toBe(3);
    expect(recordSchemaVersion(file(1, { labValues: [coreLdl('c', 'entered-in-error')] }))).toBe(3);
    expect(recordSchemaVersion(file(2, { erased: true, labValues: [coreLdl('c')] }))).toBe(3);
  });

  it('never lowers a stated version, and normalises it to an integer in [1, 3]', () => {
    expect(recordSchemaVersion(file(2))).toBe(2);
    expect(recordSchemaVersion(file(3))).toBe(3);
    expect(recordSchemaVersion({ schemaVersion: 2.5 })).toBe(2);
    expect(recordSchemaVersion({ schemaVersion: 1.5 })).toBe(1);
    for (const bad of [0, -1, Number.NaN, '3', null, undefined]) expect(recordSchemaVersion({ schemaVersion: bad })).toBe(1);
  });

  it('counts only a labValues row flagged core: true, not a lab row named like a core test', () => {
    const named = createLabValue({ id: 'n', metricName: 'ldl', value: 2.1, unit: 'mmol/L', recordedAt: DAY, createdAt: `${DAY}T08:00:00.000Z` });
    expect(recordSchemaVersion(file(1, { labValues: [named] }))).toBe(1);
  });
});

describe('US-66 AC15: migrateFile stamps after the move and fold', () => {
  it('an old v2 file with old blood measurements migrates to 3', () => {
    const f = migrateFile(raw(file(2, { erased: true, measurements: [oldLdl('l1'), weight('w1')] })), CTX);
    expect(f.labValues.some((row) => row.core === true)).toBe(true);
    expect(f.schemaVersion).toBe(3);
  });

  it('an old v1 file with an old blood measurement migrates to 3', () => {
    expect(migrateFile(raw(file(1, { measurements: [oldLdl('l1')] })), CTX).schemaVersion).toBe(3);
  });

  it('an old core-named lab row that folds makes the file 3', () => {
    const printed = createLabValue({ id: 'p', metricName: 'LDL Cholesterol', value: 2.1, unit: 'mmol/L', recordedAt: DAY, createdAt: `${DAY}T08:00:00.000Z` });
    const f = migrateFile(raw(file(1, { labValues: [printed] })), CTX);
    expect(f.labValues.some((row) => row.core === true)).toBe(true);
    expect(f.schemaVersion).toBe(3);
  });

  it('a vitals-only record keeps its version: 1 stays 1, a stated 2 stays 2', () => {
    expect(migrateFile(raw(file(1, { measurements: [weight('w1')] })), CTX).schemaVersion).toBe(1);
    expect(migrateFile(raw(file(2, { measurements: [weight('w1')] })), CTX).schemaVersion).toBe(2);
    expect(migrateFile(raw(file(2, { erased: true, measurements: [weight('w1')] })), CTX).schemaVersion).toBe(2);
  });

  it('a v3 file reads; a v4 file still throws SchemaTooNewError', () => {
    expect(migrateFile(raw(file(3, { labValues: [coreLdl('c')] })), CTX).schemaVersion).toBe(3);
    expect(() => migrateFile({ ...(raw(file(1)) as object), schemaVersion: 4 }, CTX)).toThrow(SchemaTooNewError);
  });

  it('a reader of version 2 refuses a migrated record holding a core row, and still reads a vitals-only one', async () => {
    const moved = raw(migrateFile(raw(file(1, { measurements: [oldLdl('l1')] })), CTX));
    const vitals = raw(migrateFile(raw(file(2, { erased: true, measurements: [weight('w1')] })), CTX));
    vi.resetModules();
    vi.doMock('./roadmap-file', async (original) => ({ ...(await original<typeof import('./roadmap-file')>()), CURRENT_SCHEMA_VERSION: 2 }));
    try {
      const old = await import('./migrate');
      expect(() => old.migrateFile(moved, CTX)).toThrow(old.SchemaTooNewError);
      expect(old.migrateFile(vitals, CTX).measurements).toHaveLength(1);
    } finally {
      vi.doUnmock('./roadmap-file');
      vi.resetModules();
    }
  });
});

describe('US-66 AC15: mergeFiles', () => {
  it('v1 + v3 is 3, in both orders', () => {
    const v1 = migrateFile(raw(file(1, { measurements: [weight('w1')] })), CTX);
    const v3 = migrateFile(raw(file(1, { measurements: [oldLdl('l1')] })), CTX);
    expect(mergeFiles(v1, v3, CTX).schemaVersion).toBe(3);
    expect(mergeFiles(v3, v1, CTX).schemaVersion).toBe(3);
  });

  it('lifts an unstamped in-memory copy holding a core row to 3', () => {
    expect(mergeFiles(file(1, { labValues: [coreLdl('c')] }), file(1), CTX).schemaVersion).toBe(3);
  });

  it('vitals-only stays as before: 1 + 1 is 1, 1 + an erase list is 2', () => {
    expect(mergeFiles(file(1, { measurements: [weight('w1')] }), file(1), CTX).schemaVersion).toBe(1);
    expect(mergeFiles(file(1, { measurements: [weight('w1')] }), file(2, { erased: true }), CTX).schemaVersion).toBe(2);
  });
});

describe('US-66 AC15: buildErasedFile', () => {
  it('stamps the erase list version, 2, even when the copies held core rows', () => {
    const noCore = buildErasedFile({ stored: file(1, { measurements: [weight('w1')] }), own: file(1), device: null, ctx: CTX });
    expect(noCore.schemaVersion).toBe(2);
    const core = buildErasedFile({ stored: file(3, { labValues: [coreLdl('c')] }), own: file(3, { labValues: [coreLdl('c')] }), device: null, ctx: CTX });
    expect(core.labValues).toEqual([]);
    expect(core.schemaVersion).toBe(2);
  });
});

describe('US-66 AC15: every edit door that adds the first core row lifts the copy to 3', () => {
  const v1 = () => file(1, { measurements: [weight('w1')] });
  const now = CTX.now;

  it('appendMeasurement and placeMeasurement with a blood test', () => {
    const a = appendMeasurement(v1(), { metricType: 'ldl', value: 2.1, recordedAt: DAY, now });
    expect(a.ok && a.file.schemaVersion).toBe(3);
    const p = placeMeasurement(v1(), { metricType: 'hba1c', value: 40, recordedAt: DAY, now });
    expect(p.ok && p.file.schemaVersion).toBe(3);
  });

  it('appendLabValue with a core name', () => {
    const r = appendLabValue(v1(), { metricName: 'LDL Cholesterol', value: 2.1, unit: 'mmol/L', recordedAt: DAY, now });
    expect(r.ok && r.row.core).toBe(true);
    expect(r.ok && r.file.schemaVersion).toBe(3);
  });

  it('bulkAppendValues with a blood test, as a measurement or a lab row', () => {
    const m = bulkAppendValues(v1(), [{ kind: 'measurement', metricType: 'ldl', value: 2.1, recordedAt: DAY, source: 'manual' }], now);
    expect(m.saved).toHaveLength(1);
    expect(m.file.schemaVersion).toBe(3);
    const l = bulkAppendValues(v1(), [{ kind: 'lab', metricName: 'ApoB', value: 0.9, unit: 'g/L', recordedAt: DAY, source: 'lab_import' }], now);
    expect(l.saved).toHaveLength(1);
    expect(l.file.schemaVersion).toBe(3);
  });

  it('correctValue of a core row in a copy stated below 3 saves 3', () => {
    const stale = file(2, { labValues: [coreLdl('c')] });
    const r = correctValue(stale, { id: 'c', newValue: 2.4, now });
    expect(r.ok && r.file.schemaVersion).toBe(3);
  });

  it('a vitals edit leaves a v1 copy at 1', () => {
    const r = appendMeasurement(v1(), { metricType: 'weight', value: 81, recordedAt: '2026-10-02', now });
    expect(r.ok && r.file.schemaVersion).toBe(1);
  });
});

describe('US-66 AC15: saved files', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('SyncManager (hosted MCP, web cloud): a first core row over a stored v1 file is saved as 3', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file(1, { measurements: [weight('w1')] })), version: 1 });
    const sync = new SyncManager(new MemoryAdapter(cloud), CTX.deviceId, ROADMAP_DOC, { now: () => CTX.now });
    const loaded = await sync.load();
    expect(loaded.schemaVersion).toBe(1);
    const edit = appendMeasurement(loaded, { metricType: 'ldl', value: 2.1, recordedAt: DAY, now: CTX.now });
    if (!edit.ok) throw new Error(edit.message);
    await sync.save(edit.file);
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).schemaVersion).toBe(3);
  });

  it('SyncManager lifts an unstamped working copy too: the merge is the last stamp', async () => {
    const sync = new SyncManager(new MemoryAdapter(new MemoryCloud()), CTX.deviceId, ROADMAP_DOC, { now: () => CTX.now });
    const result = await sync.save(file(1, { labValues: [coreLdl('c')] }));
    expect(result.file.schemaVersion).toBe(3);
  });

  it('FileAdapter (CLI, stdio MCP): an old-shape file loaded and saved is written as 3', async () => {
    dir = mkdtempSync(join(tmpdir(), 'us66-v3-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, JSON.stringify(file(2, { measurements: [oldLdl('l1')] })));
    const sync = new SyncManager(new FileAdapter(path), CTX.deviceId, ROADMAP_DOC, { now: () => CTX.now });
    await sync.save(await sync.load());
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(3);
  });

  it('a vitals-only record saves at its own version', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file(1)), version: 1 });
    const sync = new SyncManager(new MemoryAdapter(cloud), CTX.deviceId, ROADMAP_DOC, { now: () => CTX.now });
    const edit = appendMeasurement(await sync.load(), { metricType: 'weight', value: 80, recordedAt: DAY, now: CTX.now });
    if (!edit.ok) throw new Error(edit.message);
    await sync.save(edit.file);
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).schemaVersion).toBe(1);
  });
});
