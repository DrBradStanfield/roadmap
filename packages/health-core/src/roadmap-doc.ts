/**
 * `health-roadmap.json` as a `DocumentSpec` — the schema half of the
 * read-merge-write loop in `sync-manager.ts`.
 *
 * It lived beside `RoadmapStore` in the widget until the hosted MCP server
 * (US-32) needed the same loop over the same file from Node. Both callers must
 * migrate and merge the record identically or two writers disagree about what
 * the file means, so the spec is one object here rather than one per surface.
 */
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import type { RoadmapFile } from './roadmap-file';
import { ROADMAP_FILE_NAME } from './adapter';
import type { DocumentSpec } from './sync-manager';

export const ROADMAP_DOC: DocumentSpec<RoadmapFile> = {
  fileName: ROADMAP_FILE_NAME,
  migrate: (raw, ctx) => migrateFile(raw as RoadmapFile | null, ctx),
  merge: (local, base, ctx) => mergeFiles(local, base, ctx),
};
