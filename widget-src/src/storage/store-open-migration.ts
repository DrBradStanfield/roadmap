// The open's one-time move into one blood-test table (US-66 AC13, AC14): the
// stored bytes it compares and the write it makes (moved from roadmap-store.ts, US-64).
import type { RecordSession } from '@roadmap/health-core/record-session';
import { bloodTableReport } from '@roadmap/health-core/blood-tests';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';

/** What first opening a record in the old shape moved, for `blood_tests_unified` (US-66 AC13): counts only. */
export type BloodTableReport = ReturnType<typeof bloodTableReport>;

/** `adapter`, with its first read of the record handed to `seen`: the stored
 *  bytes the open migrates (US-66 AC14). Every other call passes through. */
export function tapFirstRead(adapter: StorageAdapter, seen: (body: unknown) => void): StorageAdapter {
  let first = true;
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'read') {
        return async (fileName: string, signal?: AbortSignal) => {
          const result = await target.read(fileName, signal);
          if (first && fileName === ROADMAP_FILE_NAME) { first = false; seen(result.body); }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A stored body's rows, junk left out, as `bloodTableReport` reads them. */
function storedRows<T>(body: Record<string, unknown>, key: string): T[] {
  const rows = body[key];
  return Array.isArray(rows) ? rows.filter((row): row is T => typeof row === 'object' && row !== null) : [];
}

  /**
   * US-66 AC14: the open moved blood tests out of `measurements`, or folded
   * old lab rows named like a core test, compared with the stored bytes:
   * write the record once, through the normal save. A moved record has
   * nothing left to move, so the next open writes nothing.
   */
export function writeMovedRecord(session: RecordSession, stored: unknown): Promise<BloodTableReport | null> {
    if (typeof stored !== 'object' || stored === null) return Promise.resolve(null);
    const body = stored as Record<string, unknown>;
    const report = bloodTableReport({ measurements: storedRows(body, 'measurements'), labValues: storedRows(body, 'labValues') }, session.file);
    if (!report.moved && !report.folded) return Promise.resolve(null);
    // Under the erase the open read, as the engine's move (ios/engine/cloud.ts): no press starts it.
    session.edit(() => {}, session.eraseIdentity);
    return session.flush().then(() => report, () => null);
}
