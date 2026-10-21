/**
 * The open record's session rules, shared by the web widget's RoadmapStore and
 * the iPhone app (ios/architecture.md D4): what counts as a change to take in,
 * what counts as one to announce, which erase a copy is at, and the session's
 * timings. No DOM and no Node: engine-portability.test.ts checks.
 */
import { CLOCK_KEYS } from './merge';
import { stableStringify, type RoadmapFile } from './roadmap-file';

/** How long a burst of edits waits before one save carries them all. */
export const PERSIST_DEBOUNCE_MS = 800;

/**
 * How the open page keeps up with a record something else is writing (US-34).
 * The provider says so when it can — the adapter's `watch` — and the two
 * moments a user comes back to the page catch whatever a watch missed. The
 * slow poll is the fallback for backends with no change signal at all; a
 * watch-capable one never runs it. The throttle stops two return signals that
 * fire together (focus and visibilitychange on the web) from making two round
 * trips out of one return.
 */
export const REMOTE_POLL_MS = 60_000;
export const REMOTE_THROTTLE_MS = 5_000;

/** Which erase the record is at. It lives in `meta` beside the clocks but is
 *  not one: an erase that leaves the record as empty as it was is still a
 *  change, and the page drops the chat's banners for it (US-16 AC2a). */
function eraseOf(file: RoadmapFile): [number, string | null] {
  return [file.meta.eraseEpoch ?? 0, file.meta.erasedAt ?? null];
}

/** Which erase this copy is at, as one comparable string (US-16 AC2a). */
export function eraseIdentityOf(file: RoadmapFile): string {
  return JSON.stringify(eraseOf(file));
}

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
