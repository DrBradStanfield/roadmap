/**
 * The save half of the Drive popup reconnect (US-09 AC45). The adapter's
 * acquireViaPopup() gets the ~1 h token and writes nothing; this keeps it,
 * with the stored account and the account pin, under the log-off id the
 * reconnect began under. The kept grant when all were saved; when one is
 * dropped, none stays (setSignIns) and the answer is null. Nothing is saved once this device's chosen home is no
 * longer Google Drive (another tab moved it): the reconnect then reloads onto
 * that choice. Nothing is saved either once `current` says the reconnect
 * stopped during the account check. `live` hands in the record open on the
 * page, judged with the device copy before anything is kept (US-09 AC55).
 */
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { driveAccountOf, driveFileVersion, readDriveRecord } from '@roadmap/health-core/drive-rest';
import { BACKEND_KEY, getSignIn, safeGetItem, safeRemoveItem, setSignIn, type LogOffId } from '../lib/storage';
import { keepWithPin, reconnectDecision, releasePin, settleCheck } from './account-gate';
import { CONFIG_KEY, TOKENS_KEY } from './drive';

type Token = { accessToken: string; expiresAt: number };

/** A kept grant. `onEmpty`: the outcome was `no_pin_empty_copy` (US-09 AC55); `settle` counts it once the
 *  copy was read again before the lift. `takeBack` removes it and its pin and puts back the tokens it replaced. */
export interface PopupGrant {
  readonly onEmpty: boolean;
  settle(stillEmpty: boolean): void;
  takeBack(): void;
}

const LABEL = 'Google Drive';

export async function savePopupGrant(token: Token, gen: LogOffId, current: () => boolean = () => true, live?: () => unknown): Promise<PopupGrant | null> {
  const homeIsDrive = () => safeGetItem(BACKEND_KEY) === 'google-drive';
  if (!homeIsDrive()) return null;
  const stored = getSignIn<{ fileId?: string; fileIds?: Record<string, string> }>(CONFIG_KEY);
  const fileId = stored?.fileIds?.[ROADMAP_FILE_NAME] ?? stored?.fileId;
  const earlier = getSignIn<Partial<Token>>(TOKENS_KEY);
  const earlierToken = (earlier?.expiresAt ?? 0) > Date.now() ? earlier?.accessToken : undefined; // a live one only: nothing is refreshed here
  const decision = await reconnectDecision({
    provider: 'google-drive',
    label: LABEL,
    account: () => driveAccountOf(token.accessToken),
    earlierAccount: earlierToken ? () => driveAccountOf(earlierToken) : undefined,
    cachedFileVisible: fileId ? async () => (await driveFileVersion(token.accessToken, fileId)) !== null : undefined,
    cloudRecord: async () => (await readDriveRecord(token.accessToken, new Set())).body,
    live,
    settlesEmptyLater: true,
  });
  let handedOn = decision.onEmpty !== true; // an empty-copy check is counted once: by the kept grant's settle, or below
  try {
    if (!current() || !homeIsDrive()) return null;
    if (!keepWithPin({ [TOKENS_KEY]: token, [CONFIG_KEY]: getSignIn<object>(CONFIG_KEY) ?? {} }, decision, gen)) return null;
    handedOn = true;
    return {
      onEmpty: decision.onEmpty === true,
      settle: (stillEmpty) => settleCheck('google-drive', LABEL, stillEmpty ? 'no_pin_empty_copy' : 'no_pin_unproven'),
      takeBack: () => {
        safeRemoveItem(TOKENS_KEY); // the pin and the new tokens go first: a stop between leaves no sign-in, never another account's
        releasePin();
        if (earlier) setSignIn(TOKENS_KEY, earlier, gen);
      },
    };
  } finally {
    if (!handedOn) settleCheck('google-drive', LABEL, 'no_pin_empty_copy');
  }
}
