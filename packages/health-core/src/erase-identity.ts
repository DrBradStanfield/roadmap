/**
 * The erase identity's one owner: its format, and the epoch order the merge
 * keeps (merge.ts: a higher eraseEpoch wins). record-session.ts re-exports it;
 * the web widget's erase machine orders by `epochOf` (fix 4, design Q4).
 */
import { eraseTimeLater } from './merge';
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

/** The identity's [epoch, erasedAt]; null when it cannot be read. */
export function readErase(identity: string): [number, string | null] | null {
  try {
    const value = JSON.parse(identity) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [epoch, at] = value as unknown[];
    return typeof epoch === 'number' && Number.isFinite(epoch) && (at === null || typeof at === 'string') ? [epoch, at] : null;
  } catch {
    return null;
  }
}

/** Whether `record`'s erase came after `kept`'s: a higher epoch, or the same
 *  epoch with a later erasedAt in the merge's own order (`eraseTimeLater`).
 *  A `kept` that cannot be read is earlier than any erase; a `record` that
 *  cannot be read is never later (US-11 AC6). */
export function eraseLater(record: string, kept: string): boolean {
  const [r, k] = [readErase(record), readErase(kept)];
  if (!r) return false;
  if (!k) return true;
  return r[0] !== k[0] ? r[0] > k[0] : eraseTimeLater(r[1] ?? undefined, k[1] ?? undefined);
}

/** The one rule for an owed clear, at a session's open and in it (US-11 AC6):
 *  the record's erase is later than the one the off-file data was cleared up
 *  to. `clearedFor` is always readable (a session takes a kept erase only when
 *  it reads, else the record's own); one that is not, like a record identity
 *  that is not, owes nothing, so no unreadable value ever clears. */
export function clearOwed(record: string, clearedFor: string): boolean {
  return readErase(clearedFor) != null && eraseLater(record, clearedFor);
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
