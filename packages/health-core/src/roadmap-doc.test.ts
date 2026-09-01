/**
 * US-31 AC8 / US-32 AC6 — the shape gate on `health-roadmap.json`.
 *
 * `migrateFile` turns bytes it cannot recognise into a BLANK record. That is
 * right for a first run and a catastrophe for a write: pointed at a JSON array
 * or a bare string, a writer would replace the file with an empty record and
 * report success. The gate lives in the document spec, so EVERY adapter —
 * Dropbox, Drive, GitHub, local file, memory — inherits it through
 * `SyncManager.load()` and through the re-read that precedes a save.
 */
import { describe, it, expect } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordShapeError, SchemaTooNewError } from './migrate';
import { recordSync, ROADMAP_DOC } from './roadmap-doc';
import { createEmptyFile } from './roadmap-file';

const NOW = '2026-09-01T09:00:00Z';
const CTX = { deviceId: 'roadmap-doc', now: NOW };

/** A cloud holding exactly these bytes, and a sync over it. */
function syncOver(json?: string) {
  const cloud = new MemoryCloud();
  if (json !== undefined) cloud.files.set(ROADMAP_FILE_NAME, { json, version: 1 });
  return { cloud, sync: recordSync(new MemoryAdapter(cloud), CTX.deviceId, NOW) };
}

const NOT_RECORDS = ['[]', '"hello"', '42', '[{"id":"m1"}]', '{"measurements":[]}'];

describe('a record that is not a record is refused, never blanked', () => {
  it('refuses valid JSON that is not a health record, and leaves the bytes alone', async () => {
    for (const json of NOT_RECORDS) {
      const { cloud, sync } = syncOver(json);
      await expect(sync.load(), json).rejects.toBeInstanceOf(RecordShapeError);
      expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(json);
    }
  });

  it('refuses a file that carries schemaVersion but junk where its rows belong', async () => {
    const { sync } = syncOver('{"schemaVersion":1,"measurements":"nope","labValues":42}');
    await expect(sync.load()).rejects.toThrow(/measurements is not a list/);
  });

  it('refuses on the re-read a save does, so a file swapped mid-run is not overwritten', async () => {
    const { cloud, sync } = syncOver(JSON.stringify(createEmptyFile(CTX)));
    const file = await sync.load();

    const junk = '{"schemaVersion":1,"measurements":"nope"}';
    cloud.files.set(ROADMAP_FILE_NAME, { json: junk, version: 2 });
    await expect(sync.save(file)).rejects.toBeInstanceOf(RecordShapeError);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(junk);
  });

  it('still treats an absent file as a fresh record — nobody has saved yet', async () => {
    const { sync } = syncOver();
    const file = await sync.load();
    expect(file.measurements).toEqual([]);
    expect(ROADMAP_DOC.migrate(null, CTX).schemaVersion).toBe(1);
  });
});

describe('a record from a newer app is out of reach in both directions', () => {
  it('throws SchemaTooNewError out of load(), before any tool sees the file', async () => {
    const { sync } = syncOver(JSON.stringify({ ...createEmptyFile(CTX), schemaVersion: 99 }));
    await expect(sync.load()).rejects.toBeInstanceOf(SchemaTooNewError);
  });
});
