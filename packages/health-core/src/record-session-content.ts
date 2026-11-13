/**
 * What counts as a change to the record, moved whole out of record-session.ts
 * (file budget): the content a merge is taken in by, and the content a person
 * would see, which decides what is announced.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { eraseOf } from './erase-identity';
import { CLOCK_KEYS } from './merge';
import { stableStringify, type RoadmapFile } from './roadmap-file';

/** The record minus its own clocks — what a person would call a change. Keys
 *  are sorted, as everywhere else content is compared: a merge rebuilds the
 *  objects it touches, and a reordered key is not a change anyone made. */
export function contentOf(file: RoadmapFile): string {
  const { meta: _clocks, ...rest } = file;
  return stableStringify([eraseOf(file), rest]);
}

/**
 * What a person would SEE of the record: `contentOf` with each list read as a
 * set and every record's own clocks (`updatedAt`, `lamport`, `fieldStamps`)
 * left out. A merge re-sorts rows by id, and against an empty backend it
 * trades one singleton's stamp for the other's; neither is a change anyone
 * made. This decides only what is ANNOUNCED (US-34 AC3). Taking a merge in
 * still goes by `contentOf`: a skipped clock-only lead would leave the profile
 * lamport behind the cloud's, and the next profile edit would lose the merge.
 */
export function visibleContentOf(file: RoadmapFile): string {
  // The erase list is bookkeeping too, and so is the version it raises: a
  // change to them alone is nothing a person sees (US-09 AC23). The erase
  // itself is: it drops the chat's banners (US-16 AC2a).
  const { meta: _clocks, erasedRows: _list, schemaVersion: _version, ...rest } = file;
  const seen: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    seen[key] = Array.isArray(value) ? value.map((row) => stableStringify(row, CLOCK_KEYS)).sort() : value;
  }
  return stableStringify([eraseOf(file), seen], CLOCK_KEYS);
}
