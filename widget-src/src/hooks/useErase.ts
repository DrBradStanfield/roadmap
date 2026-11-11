import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { askedUnder, deleteUserData, getBackendKind, getEraseIdentity, getShownErase, markEraseShown } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { Sentry } from '../lib/sentry';
import { recordFailure } from '../lib/error-diagnostics';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING, ERASE_DONE_CHAT_UNREAD, ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';
import { createEraseStore, refusal, type EraseState, type EraseStore } from '../lib/erase-machine';

/**
 * The page's door to lib/erase-machine.ts: the erase the screen shows, and
 * this tab's own "Delete all my data" (US-16 AC2a, AC2c, AC2d; US-11 AC6).
 *
 * One EraseStore per page holds the state; every event reaches it from one of
 * its call sites: useRecordApply `apply` and the page's first read (`read`),
 * useRecordApply's REMOTE_CHANGED listener (`arrived`), its loaded effect and
 * `firstReadFailed` (`loaded`), `eraseAll` here (`own-start`, then `own-end`
 * or `own-failed`), and `writeRefused` here (`refused`). Its effects run
 * through the doors below, built from the latest committed props:
 * - clearDrafts, forget: the page's;
 * - read: the page's `shows` (useRecordApply: it ends a hold, clears the
 *   answer mark, and counts nothing);
 * - countRemoteChange: remote_change_applied, the one count of another
 *   writer's erase (the relay counts other changes only);
 * - alertRefused, sayOutcome: alerts.
 *
 * `eraseUnshown` stays a store query: true while the store holds an erase the
 * screen does not show yet (this tab's erase writing or failed to write, or
 * another writer's whose re-read has not landed), so no chat banner is made or
 * answered on pre-erase values.
 *
 * The tree reads the store through state its listener sets, not
 * useSyncExternalStore. Measured on React 18.2 (PR 1283): useSyncExternalStore
 * commits a store change at sync priority, ahead of state set in the same
 * async turn. A component changing both in one timer callback committed
 * `a=0 b=0`, `a=0 b=1`, `a=1 b=1`: an intermediate commit. Here that commit
 * would move the store's mark to the new erase while the old record is still
 * on screen, so a save asked from it would land (US-16 AC2d). Set from the
 * listener, the state commits with the record set in the same turn
 * (`a=0 b=0`, `a=1 b=1`). The AC2d pins in useErase.test.tsx guard it, one rendered outside act(). `shownErase` keys
 * the upload modal, so an erase ends a review read before it (US-16 AC2c).
 */
export interface EraseDoorProps {
  clearDrafts: () => void;
  /** This tab's erase moved the record: the page forgets the old one, on the device and on screen. */
  forget: () => void;
  /** A whole re-read of the record, through the page's read policy: a refusal with no erase heard. */
  reread: (reason: 'refused' | 'left') => void;
  /** The machine's read: another writer's erase shows (useRecordApply `shows`). */
  shows: () => void;
  /** The machine read for a refusal of the record shown: the answer mark is spent, as a 'refused' re-read spends it (US-62 AC25b). */
  spend: () => void;
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
    read: () => doors.current.shows(),
    countRemoteChange: () => trackProductEvent('remote_change_applied', { backend: getBackendKind() }),
    alertRefused: () => window.alert(WRITE_REFUSED),
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
  // run before this one, so none may write; none does (2026-11-10). The same
  // moment counts another writer's erase now on screen (`committed`, Codex R1).
  useLayoutEffect(() => { markEraseShown(state.shown); store.dispatch({ type: 'committed', identity: state.shown }); }, [state.shown, store]);

  const eraseUnshown = useCallback(() => getEraseIdentity() !== getShownErase(), []);

  const writeRefused = useCallback((erase?: string) => {
    // A save asked of a record the screen has left spends no landing of the one it shows (US-16 AC2d, US-62 AC25b).
    const spends = erase === undefined || erase === store.getSnapshot().shown;
    // F4c: the erase the save was asked under; the supplement stop names none, so the mark's (PR 3).
    // The machine says WRITE_REFUSED when it is news, then reads a heard erase itself (Q3): the alert comes first.
    const { news, reads } = refusal(store, erase ?? askedUnder());
    if (reads) { if (news && spends) doors.current.spend(); return; } // one read, never two; a repeat spends nothing (R2)
    if (news) doors.current.reread(spends ? 'refused' : 'left');
  }, [store]);

  const eraseAll = useCallback(async () => {
    // One erase at a time: the machine answers synchronously, so a second asked in the same turn is refused unasked (US-16 AC2f).
    if (store.getSnapshot().phase === 'erasing' || !window.confirm(ERASE_CONFIRM)) return false;
    const before = getEraseIdentity();
    store.dispatch({ type: 'own-start' });
    // A throw is reported, then taken as a failed write: the erase still ends, or the lock sticks (US-16 AC2f).
    const result: Awaited<ReturnType<typeof deleteUserData>> = await deleteUserData().catch((error: unknown) => {
      Sentry.captureException(recordFailure(error, 'Erase failed'), { tags: { area: 'erase', op: 'delete-all' } });
      return { success: false, chatErased: false };
    });
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
