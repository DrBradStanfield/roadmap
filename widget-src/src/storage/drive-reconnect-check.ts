/**
 * US-09 AC65: whether the Drive popup reconnect reaches the record this browser
 * was saving, asked before its grant is kept. A record file shared with the
 * account that signed in counts as found. Only Drive's definite answer that
 * the cached file is not there for the new sign-in (driveFileVersion's 404)
 * says it does not; a lookup that fails for any other reason decides nothing.
 */
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { driveFileVersion } from '@roadmap/health-core/drive-rest';
import { CLOCK_KEYS } from '@roadmap/health-core/merge';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { BACKEND_KEY, getSignIn, logOffId, safeGetItem } from '../lib/storage';
import { CONFIG_KEY, type Stored } from './drive';
import { LocalStorageAdapter } from './local-storage-adapter';

/** `notVisible` alone stops the reconnect. */
export type DriveReconnectCheck = 'sameRecord' | 'notVisible' | 'noCachedId' | 'emptyCopy' | 'checkFailed';

/** The keys a fresh record's parts may carry, read from createEmptyFile; anything else is held data. */
const FRESH = createEmptyFile({ deviceId: '', now: '' });
const LISTS: ReadonlySet<string> = new Set(Object.keys(FRESH).filter((key) => Array.isArray(FRESH[key as keyof typeof FRESH])));
const FRESH_META: ReadonlySet<string> = new Set([...Object.keys(FRESH.meta), 'eraseEpoch']);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Clocks only, and no field stamp: a stamped clear is a change. */
const blankSingleton = (value: unknown): boolean => isObject(value) && Object.entries(value)
  .every(([key, part]) => CLOCK_KEYS.has(key) && (key !== 'fieldStamps' || (isObject(part) && Object.keys(part).length === 0)));
const blankMeta = (value: unknown): boolean =>
  isObject(value) && Object.entries(value).every(([key, part]) => FRESH_META.has(key) && (key !== 'eraseEpoch' || part === 0));

/**
 * Empty only when it matches a fresh record (fail closed): no body, or an
 * object whose every key is a fresh record's, with every list empty, the
 * profile and screenings holding clocks and no field stamp, and the meta
 * holding no erase. An erase list, a reminder opt-in, any key this does not
 * know, or a body that is not an object, is held data.
 */
export function copyEmpty(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (!isObject(body)) return false;
  return Object.entries(body).every(([key, value]) => {
    if (key === 'schemaVersion') return typeof value === 'number';
    if (key === 'meta') return blankMeta(value);
    if (key === 'profile' || key === 'screenings') return blankSingleton(value);
    return LISTS.has(key) && Array.isArray(value) && value.length === 0;
  });
}

/** This device's stored record is empty; a read that throws holds data. */
function storedEmpty(): boolean {
  try {
    return copyEmpty(new LocalStorageAdapter().readSyncStrict(ROADMAP_FILE_NAME).body);
  } catch {
    return false;
  }
}

const cachedRecordId = (): string | undefined => {
  const config = getSignIn<Stored>(CONFIG_KEY);
  return config?.fileIds?.[ROADMAP_FILE_NAME] ?? config?.fileId;
};

/** The stored Drive sign-in the lookup is made for: the remembered home, the log-off id and the cached record file id. */
export const driveSignInNow = (): string => JSON.stringify([safeGetItem(BACKEND_KEY), logOffId(), cachedRecordId()]);

/** `live` is the record open on the page: the reconnect's flush and lift send it too. */
export async function driveReconnectCheck(accessToken: string, live: unknown): Promise<DriveReconnectCheck> {
  if (copyEmpty(live) && storedEmpty()) return 'emptyCopy';
  const fileId = cachedRecordId();
  if (!fileId) return 'noCachedId';
  try {
    return (await driveFileVersion(accessToken, fileId)) === null ? 'notVisible' : 'sameRecord';
  } catch {
    return 'checkFailed';
  }
}
