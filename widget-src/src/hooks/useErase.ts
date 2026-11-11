import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { askedUnder, deleteUserData, getEraseIdentity, getShownErase, markEraseShown } from '../lib/roadmap-data';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING, ERASE_DONE_CHAT_UNREAD, ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';
import { createEraseStore, refusal, type EraseState, type EraseStore } from '../lib/erase-machine';

/**
 * The page's door to lib/erase-machine.ts: the erase the screen shows, and
 * this tab's own "Delete all my data" (US-16 AC2a, AC2c, AC2d; US-11 AC6).
 *
 * One EraseStore per page holds the state; every event reaches it from one of
 * its call sites: useRecordApply `apply` and the page's first read (`read`),
 * `eraseAll` here (`own-start`, then `own-end` or `own-failed`), and
 * `writeRefused` here (`refused`). Its effects run through the doors below,
 * built from the latest committed props:
 * - clearDrafts, forget, reread: the page's;
 * - read: a whole re-read (`reread('left')`);
 * - countRemoteChange: nothing yet; the relay still counts (PR 2b-3);
 * - sayOutcome: an alert.
 *
 * `eraseUnshown` stays a store query: true while the store holds an erase the
 * screen does not show yet (this tab's erase writing or failed to write, or
 * another writer's whose re-read has not landed), so no chat banner is made or
 * answered on pre-erase values.
 *
 * The tree reads the store through state its listener sets, not
 * useSyncExternalStore: React 18 renders a store change at sync priority, so
 * a read's record and its erase would commit apart, the store's mark moving
 * while the old record is still on screen (US-16 AC2d). Set from the listener,
 * the state commits with the record set in the same turn. `shownErase` keys
 * the upload modal, so an erase ends a review read before it (US-16 AC2c).
 */
export interface EraseDoorProps {
  clearDrafts: () => void;
  /** This tab's erase moved the record: the page forgets the old one, on the device and on screen. */
  forget: () => void;
  /** A whole re-read of the record, through the page's read policy. */
  reread: (reason: 'refused' | 'left') => void;
}

export interface Erase {
  /** The machine: the page's first read and useRecordApply's re-reads dispatch `read` to it. */
  store: EraseStore;
  shownErase: string;
  erasing: boolean;
  eraseUnshown: () => boolean;
  /** A save the store refused, asked under `erase`: said once per erase, and the record re-read once. */
  writeRefused: (erase?: string) => void;
  /** Ask, erase, and say how it went; true on success. */
  eraseAll: () => Promise<boolean>;
}

export function useErase(props: EraseDoorProps): Erase {
  // The latest committed props, never ones from a render that did not finish.
  const doors = useRef(props);
  useLayoutEffect(() => { doors.current = props; });
  const [store] = useState(() => createEraseStore(getShownErase(), {
    clearDrafts: () => doors.current.clearDrafts(),
    forget: () => doors.current.forget(),
    read: () => doors.current.reread('left'),
    countRemoteChange: () => {},
    sayOutcome: message => window.alert(message),
  }));
  const [state, setState] = useState<EraseState>(store.getSnapshot);
  useLayoutEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getSnapshot()));
    setState(store.getSnapshot());
    return unsubscribe;
  }, [store]);
  // The store's mark moves only once the screen shows the erase: until React
  // commits the new tree, the old one is on screen, and a save asked from it
  // keeps the old mark and is refused (US-16 AC2d). Children's layout effects
  // run before this one, so none may write; none does (2026-11-10).
  useLayoutEffect(() => { markEraseShown(state.shown); }, [state.shown]);

  const eraseUnshown = useCallback(() => getEraseIdentity() !== getShownErase(), []);

  const writeRefused = useCallback((erase?: string) => {
    // F4c: the erase the save was asked under; the supplement stop names none, so the mark's (PR 3).
    const { news, reads } = refusal(store, erase ?? askedUnder());
    if (!news) return;
    window.alert(WRITE_REFUSED);
    // A heard erase the machine re-read itself (Q3): one read, never two.
    if (reads) return;
    // A save asked of a record the screen has left spends no landing of the one it shows (US-16 AC2d, US-62 AC25b).
    doors.current.reread(erase === undefined || erase === store.getSnapshot().shown ? 'refused' : 'left');
  }, [store]);

  const eraseAll = useCallback(async () => {
    if (!window.confirm(ERASE_CONFIRM)) return false;
    const before = getEraseIdentity();
    store.dispatch({ type: 'own-start' });
    const result = await deleteUserData();
    // Read in the turn it dispatches (2b-1 R1). An erase whose write failed
    // still leaves the erased copy in the store, which retries it: the screen
    // shows that copy too (US-16 AC2a). A refused erase moved nothing.
    const now = getEraseIdentity();
    const done = result.chatErased ? ERASE_DONE : result.chatUnread ? ERASE_DONE_CHAT_UNREAD : ERASE_DONE_CHAT_PENDING;
    const message = result.success ? (result.warning ? `${done}\n\n${result.warning}` : done) : result.error || ERASE_FAILED;
    store.dispatch(now !== before ? { type: 'own-end', identity: now, message } : { type: 'own-failed', message });
    return result.success;
  }, [store]);

  return { store, shownErase: state.shown, erasing: state.phase === 'erasing', eraseUnshown, writeRefused, eraseAll };
}
