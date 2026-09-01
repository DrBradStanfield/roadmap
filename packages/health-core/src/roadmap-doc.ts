/**
 * `health-roadmap.json` as a `DocumentSpec` — the schema half of the
 * read-merge-write loop in `sync-manager.ts`, plus the shape gate that decides
 * what counts as the record at all.
 *
 * It lived beside `RoadmapStore` in the widget until the hosted MCP server
 * (US-32) needed the same loop over the same file from Node. Both callers must
 * migrate and merge the record identically or two writers disagree about what
 * the file means, so the spec is one object here rather than one per surface.
 *
 * why: mcp-architecture.md §7
 */
import { mergeFiles } from './merge';
import { isObject, migrateFile, RecordShapeError } from './migrate';
import type { RoadmapFile } from './roadmap-file';
import { ROADMAP_FILE_NAME, type StorageAdapter } from './adapter';
import { SyncManager, type DocumentSpec } from './sync-manager';

/** The arrays a record keeps its rows in. Junk in any of them migrates to a
 *  blank record, so a write would replace real values with an empty file. */
const ROW_ARRAYS = ['measurements', 'labValues', 'medications', 'supplements'] as const;

/**
 * Refuse bytes that are not this record. An ABSENT file (null) is not a
 * failure — it is a user who has not saved yet, and becomes a fresh record —
 * but anything present must look like one, on the read AND on the re-read that
 * precedes every write.
 */
function assertRecordShape(raw: unknown): void {
  if (raw == null) return;
  if (!isObject(raw) || !('schemaVersion' in raw)) {
    throw new RecordShapeError('it holds something else entirely');
  }
  for (const key of ROW_ARRAYS) {
    // A missing or null array holds no rows, so normalising it to [] loses
    // nothing and a sloppy writer's file still opens. A string or a number
    // there is a different file wearing our name.
    if (raw[key] != null && !Array.isArray(raw[key])) {
      throw new RecordShapeError(`its ${key} is not a list`);
    }
  }
}

export const ROADMAP_DOC: DocumentSpec<RoadmapFile> = {
  fileName: ROADMAP_FILE_NAME,
  migrate: (raw, ctx) => {
    assertRecordShape(raw);
    return migrateFile(raw as RoadmapFile | null, ctx);
  },
  merge: (local, base, ctx) => mergeFiles(local, base, ctx),
  // The append-only, id-carrying arrays: rows here are never removed or
  // rewritten, so their ids are exactly what a write can be checked against
  // afterwards. (`recommendationSnapshots` are keyed by date, not id, and are
  // regenerated rather than appended — nothing to lose.)
  rowIds: (file) => [
    ...file.measurements, ...file.labValues, ...file.documents,
    ...file.medicationHistory, ...file.supplementHistory,
  ].map((row) => row.id),
};

/** The one write path over the user's record, whichever adapter holds it. */
export function recordSync(adapter: StorageAdapter, deviceId: string, now: string): SyncManager<RoadmapFile> {
  return new SyncManager<RoadmapFile>(adapter, deviceId, ROADMAP_DOC, () => now);
}
