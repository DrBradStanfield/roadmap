/**
 * The save half of the Drive popup reconnect (US-09 AC45). The adapter's
 * acquireViaPopup() gets the ~1 h token and writes nothing; this keeps it,
 * with the stored account and the account pin, under the log-off id the
 * reconnect began under. True when all were saved; when one is dropped, none
 * stays (setSignIns). Nothing is saved once this device's chosen home is no
 * longer Google Drive (another tab moved it): the reconnect then reloads onto
 * that choice. Nothing is saved either once `current` says the reconnect
 * stopped during the account read. Another account than this browser's
 * throws AccountRefusedError before anything is kept (US-09 AC54).
 */
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { driveAccountOf, driveFileVersion, readDriveRecord } from '@roadmap/health-core/drive-rest';
import { BACKEND_KEY, getSignIn, safeGetItem, setSignIns, type LogOffId } from '../lib/storage';
import { admitAccount, type ProviderCheck } from './account-gate';
import { CONFIG_KEY, GoogleDriveAdapter, TOKENS_KEY, type GoogleDriveConfig } from './drive';

/** What a new Drive sign-in is checked against before it is kept (US-09 AC54): read
 *  with its own token, the earlier grant's account, and the record file id cached here. */
export function driveCheck(accessToken: string, config: GoogleDriveConfig, gen: LogOffId, reconnect = false): ProviderCheck {
  const fileId = getSignIn<{ fileIds?: Record<string, string> }>(CONFIG_KEY)?.fileIds?.[ROADMAP_FILE_NAME];
  return {
    provider: 'google-drive',
    label: 'Google Drive',
    reconnect,
    account: () => driveAccountOf(accessToken),
    readRecord: async () => (await readDriveRecord(accessToken, new Set())).body,
    earlierAccount: getSignIn(TOKENS_KEY) ? () => new GoogleDriveAdapter(config, gen).account() : undefined,
    cachedFileVisible: fileId ? async () => (await driveFileVersion(accessToken, fileId)) !== null : undefined,
  };
}

export async function savePopupGrant(token: { accessToken: string; expiresAt: number }, config: GoogleDriveConfig, gen: LogOffId, current: () => boolean): Promise<boolean> {
  const homeIsDrive = () => safeGetItem(BACKEND_KEY) === 'google-drive';
  if (!homeIsDrive()) return false;
  const pin = await admitAccount(driveCheck(token.accessToken, config, gen, true), gen);
  if (!current() || !homeIsDrive()) return false;
  return setSignIns({ [TOKENS_KEY]: token, [CONFIG_KEY]: getSignIn<object>(CONFIG_KEY) ?? {}, ...pin }, gen);
}
