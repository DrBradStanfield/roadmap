import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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
 *
 * Three copies of the shown erase, each for a reason: React state (what the
 * tree renders), the `asked` ref (what showErase last asked for, so a second
 * ask before the commit is a no-op), and the store's mark, set only once the
 * tree that shows it commits, so a save asked from the old tree is refused
 * (US-16 AC2d).
 */
export interface Erase {
  shownErase: string;
  erasing: boolean;
  /** The screen now shows this erase; `onShown` runs on each move (and again in eraseAll, which may find it already shown). */
  showErase: (erase: string) => void;
  eraseUnshown: () => boolean;
  /** A save the store refused: true if it is news to say, once per erase. */
  refusalIsNews: () => boolean;
  /** Ask, erase, and on a moved erase clear the screen with `forget`. Says how it went; true on success. */
  eraseAll: (forget: () => void) => Promise<boolean>;
}

export function useErase(onShown: () => void): Erase {
  // The latest committed `onShown`, never one from a render that did not finish.
  const shownHook = useRef(onShown);
  useLayoutEffect(() => { shownHook.current = onShown; });
  const [shownErase, setShownErase] = useState(getShownErase);
  // The store's mark moves only once the screen shows the erase: until React
  // commits the new tree, the old one is on screen, and a save asked from it
  // keeps the old mark and is refused (US-16 AC2d). Children's layout effects
  // run before this one, so none may write; none does (2026-11-10).
  useLayoutEffect(() => { markEraseShown(shownErase); }, [shownErase]);
  const asked = useRef(shownErase); // the erase last asked of the screen, shown or still committing
  const [erasing, setErasing] = useState(false);
  const erasingNow = useRef(false); // the same, for a refusal inside the erase's own turn
  const saidFor = useRef(''); // the erase whose refusal was last said

  const showErase = useCallback((erase: string) => {
    if (erase === asked.current) return;
    asked.current = erase;
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
