import { useCallback, useRef, useState } from 'react';
import { deleteUserData, getEraseIdentity, getShownErase, markEraseShown } from '../lib/roadmap-data';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING, ERASE_DONE_CHAT_UNREAD, ERASE_FAILED } from '../lib/erase-copy';

/**
 * The erase the screen shows, and this tab's own "Delete all my data"
 * (US-16 AC2a, AC2c; US-11 AC6).
 *
 * The store marks the erase the screen shows and refuses every write made
 * under another (US-16 AC2a). Against the store's own erase identity the
 * screen is in one of three states:
 * - shown: the screen shows the store's erase;
 * - unshown (`eraseUnshown`): the store holds an erase the screen does not
 *   show yet: this tab's erase still writing or failed to write, or another
 *   device's erase whose re-read has not landed (the relay never holds an
 *   erase, US-11 AC6). The screen's values are pre-erase then, so no chat
 *   banner is made or answered;
 * - erasing (`erasing`): this tab's erase is writing. The form is locked, and
 *   a save it refuses is no news (the erase throws the change away anyway).
 *
 * `shownErase` is the same erase as React state: the upload modal is keyed
 * on it, so an erase ends a review read before it (US-16 AC2c).
 */
export interface Erase {
  shownErase: string;
  erasing: boolean;
  /** The screen now shows this erase. `onShown` runs once per move. */
  showErase: (erase: string) => void;
  eraseUnshown: () => boolean;
  /** A save the store refused: true if it is news to say, once per erase. */
  refusalIsNews: () => boolean;
  /** Ask, erase, and on a moved erase clear the screen with `forget`. Says how it went; true on success. */
  eraseAll: (forget: () => void) => Promise<boolean>;
}

export function useErase(onShown: () => void): Erase {
  const shownHook = useRef(onShown);
  shownHook.current = onShown;
  const [shownErase, setShownErase] = useState(getShownErase);
  const [erasing, setErasing] = useState(false);
  const erasingNow = useRef(false); // the same, for a refusal inside the erase's own turn
  const saidFor = useRef(''); // the erase whose refusal was last said

  const showErase = useCallback((erase: string) => {
    if (erase === getShownErase()) return;
    markEraseShown(erase);
    setShownErase(erase);
    shownHook.current();
  }, []);
  const eraseUnshown = useCallback(() => getEraseIdentity() !== getShownErase(), []);
  const refusalIsNews = useCallback(() => {
    // One alert per erase, however many saves it refuses (adversary R5).
    if (erasingNow.current || saidFor.current === getEraseIdentity()) return false;
    saidFor.current = getEraseIdentity();
    return true;
  }, []);

  const eraseAll = useCallback(async (forget: () => void) => {
    if (!window.confirm(ERASE_CONFIRM)) return false;
    setErasing(true);
    erasingNow.current = true;
    const before = getEraseIdentity();
    const result = await deleteUserData();
    erasingNow.current = false;
    setErasing(false);

    // An erase whose write failed still leaves the erased copy in the store,
    // which retries it: the screen shows that copy too (US-16 AC2a). A
    // refused erase moved nothing, whatever else the screen is behind.
    if (result.success || getEraseIdentity() !== before) {
      forget();
      // Cleared here too: a re-read during the write may have shown this
      // erase already, and showErase then clears nothing (adversary R1).
      shownHook.current();
      showErase(getEraseIdentity());
      // A refusal of this erase's own leftovers is not news (adversary R3).
      saidFor.current = getEraseIdentity();
    }
    if (result.success) {
      const done = result.chatErased ? ERASE_DONE : result.chatUnread ? ERASE_DONE_CHAT_UNREAD : ERASE_DONE_CHAT_PENDING;
      window.alert(result.warning ? `${done}\n\n${result.warning}` : done);
    } else {
      window.alert(result.error || ERASE_FAILED);
    }
    return result.success;
  }, [showErase]);

  return { shownErase, erasing, showErase, eraseUnshown, refusalIsNews, eraseAll };
}
