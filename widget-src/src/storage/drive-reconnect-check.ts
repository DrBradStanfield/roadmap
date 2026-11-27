/**
 * US-09 AC65: whether the Drive popup reconnect reaches the record this browser
 * was syncing, asked before its grant is kept. A record file shared with the
 * account that signed in counts as reached. Only Drive's definite answer that
 * the cached file is not there for the new sign-in (driveFileVersion's 404)
 * says it does not; a check that fails for any other reason decides nothing.
 */
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { driveFileVersion } from '@roadmap/health-core/drive-rest';
import { CLOCK_KEYS } from '@roadmap/health-core/merge';
import { ROW_ARRAYS } from '@roadmap/health-core/roadmap-file';
import { getSignIn } from '../lib/storage';
import { CONFIG_KEY, type Stored } from './drive';
import { LocalStorageAdapter } from './local-storage-adapter';

/** `notVisible` alone stops the reconnect. */
export type DriveReconnectCheck = 'sameRecord' | 'notVisible' | 'noCachedId' | 'emptyCopy' | 'checkFailed';

/** Every list a record keeps: its rows, reminder choices and plan snapshots. */
const LISTS: readonly string[] = [...ROW_ARRAYS, 'reminderPreferences', 'recommendationSnapshots'];
const answered = (value: unknown): boolean =>
  !!value && typeof value === 'object' && Object.keys(value).some((key) => !CLOCK_KEYS.has(key));

/**
 * A copy with nothing in it: no body, or a record with no list entry (a row
 * without an id counts), no erase history (no erase epoch, no erase list, even
 * an empty one) and no answer kept (profile, screenings, the reminder opt-in).
 * Anything else, a body that is not a record included, is not empty.
 */
export function copyEmpty(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const epoch = (record.meta as { eraseEpoch?: unknown } | undefined)?.eraseEpoch;
  const noEntries = LISTS.every((key) => { const list = record[key]; return list === undefined || (Array.isArray(list) && list.length === 0); });
  return noEntries && !record.erasedRows && !(typeof epoch === 'number' && epoch > 0)
    && !answered(record.profile) && !answered(record.screenings) && !record.reminderOptIn;
}

/** This device's stored record is empty; one that cannot be read is not (unlike web-record-host's reader, which throws). */
function storedEmpty(): boolean {
  try {
    return copyEmpty(new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body);
  } catch {
    return false;
  }
}

/** `live` is the record open on the page: the reconnect's flush and lift send it too. */
export async function driveReconnectCheck(accessToken: string, live: unknown): Promise<DriveReconnectCheck> {
  if (copyEmpty(live) && storedEmpty()) return 'emptyCopy';
  const config = getSignIn<Stored>(CONFIG_KEY);
  const fileId = config?.fileIds?.[ROADMAP_FILE_NAME] ?? config?.fileId;
  if (!fileId) return 'noCachedId';
  try {
    return (await driveFileVersion(accessToken, fileId)) === null ? 'notVisible' : 'sameRecord';
  } catch {
    return 'checkFailed';
  }
}
