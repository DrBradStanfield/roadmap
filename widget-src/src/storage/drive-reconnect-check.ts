/**
 * US-09 AC65: the Drive popup reconnect confirms the record file this browser
 * was saving before its grant is kept. Only Drive's definite answer that the
 * cached file is not there for the new sign-in (driveFileVersion's 404) says it
 * is not; a lookup that fails for any other reason decides nothing. A record
 * file shared with the account that signed in counts as found.
 */
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { driveFileVersion } from '@roadmap/health-core/drive-rest';
import { BACKEND_KEY, getSignIn, logOffId, safeGetItem } from '../lib/storage';
import { CONFIG_KEY, TOKENS_KEY, type Stored } from './drive';
import { LocalStorageAdapter } from './local-storage-adapter';

/** The stored Drive sign-in a reconnect began under: the remembered home, the log-off id, the cached record
 *  file id and the stored grant. `key` compares two readings; `fileId` is the record file to confirm. */
export function driveSignInNow(): { key: string; fileId?: string } {
  const config = getSignIn<Stored>(CONFIG_KEY);
  // The legacy slot fold, as GoogleDriveAdapter's constructor does it (drive.ts); read here without its write.
  const fileId = config?.fileIds?.[ROADMAP_FILE_NAME] ?? config?.fileId;
  return { key: JSON.stringify([safeGetItem(BACKEND_KEY), logOffId(), fileId, safeGetItem(TOKENS_KEY)]), fileId };
}

/** This device's record copy reads back (a strict read: blocked storage or corrupt bytes are false). */
export function deviceCopyReadable(): boolean {
  try {
    new LocalStorageAdapter().readSyncStrict(ROADMAP_FILE_NAME);
    return true;
  } catch {
    return false;
  }
}

/** True only on Drive's definite not-found; found, and any failed lookup, is false. */
export const driveRecordMissing = (accessToken: string, fileId: string): Promise<boolean> =>
  driveFileVersion(accessToken, fileId).then((version) => version === null, () => false);
