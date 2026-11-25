/**
 * The save half of the Drive popup reconnect (US-09 AC45). The adapter's
 * acquireViaPopup() gets the ~1 h token and writes nothing; this keeps it,
 * with the stored account, under the log-off id the reconnect began under.
 * True when both were saved; when either is dropped, neither stays (setSignIns).
 * Nothing is saved once this device's chosen home is no longer Google Drive
 * (another tab moved it): the reconnect then reloads onto that choice. Nothing
 * is saved either once `current` says the reconnect stopped during the account read.
 * Another account than this browser's throws AccountRefusedError before
 * anything is kept (US-09 AC54).
 */
import { driveAccountOf } from '@roadmap/health-core/drive-rest';
import { BACKEND_KEY, getSignIn, safeGetItem, setSignIns, type LogOffId } from '../lib/storage';
import { admitAccount } from './account-gate';
import { CONFIG_KEY, TOKENS_KEY } from './drive';

export async function savePopupGrant(token: { accessToken: string; expiresAt: number }, gen: LogOffId, current: () => boolean): Promise<boolean> {
  const homeIsDrive = () => safeGetItem(BACKEND_KEY) === 'google-drive';
  if (!homeIsDrive()) return false;
  await admitAccount('google-drive', 'Google Drive', () => driveAccountOf(token.accessToken), gen);
  if (!current() || !homeIsDrive()) return false;
  return setSignIns({ [TOKENS_KEY]: token, [CONFIG_KEY]: getSignIn<object>(CONFIG_KEY) ?? {} }, gen);
}
