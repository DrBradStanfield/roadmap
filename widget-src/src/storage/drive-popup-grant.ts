/**
 * The save half of the Drive popup reconnect (US-09 AC45). The adapter's
 * acquireViaPopup() gets the ~1 h token and writes nothing; this keeps it,
 * with the stored account, under the log-off id the reconnect began under.
 * True when both were saved; when either is dropped, neither stays (setSignIns).
 */
import { getSignIn, setSignIns, type LogOffId } from '../lib/storage';
import { CONFIG_KEY, TOKENS_KEY } from './drive';

export function savePopupGrant(token: { accessToken: string; expiresAt: number }, gen: LogOffId): boolean {
  return setSignIns({ [TOKENS_KEY]: token, [CONFIG_KEY]: getSignIn<object>(CONFIG_KEY) ?? {} }, gen);
}
