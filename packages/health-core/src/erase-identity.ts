/**
 * The erase identity's one owner: its format, and the epoch order the merge
 * keeps (merge.ts: a higher eraseEpoch wins). record-session.ts re-exports it;
 * the web widget's erase machine orders by `epochOf` (fix 4, design Q4).
 */
import type { RoadmapFile } from './roadmap-file';

/** Which erase the record is at. It lives in `meta` beside the clocks but is
 *  not one: an erase that leaves the record as empty as it was is still a
 *  change, and the page drops the chat's banners for it (US-16 AC2a). */
export function eraseOf(file: RoadmapFile): [number, string | null] {
  return [file.meta.eraseEpoch ?? 0, file.meta.erasedAt ?? null];
}

/** Which erase this copy is at, as one comparable string (US-16 AC2a). */
export function eraseIdentityOf(file: RoadmapFile): string {
  return JSON.stringify(eraseOf(file));
}

/** The identity's erase epoch; -1, the floor, when it cannot be read. */
export function epochOf(identity: string): number {
  try {
    const [epoch] = JSON.parse(identity) as unknown[];
    return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : -1;
  } catch {
    return -1;
  }
}
