// Other tabs' sends (US-15 AC17, AC17a-d): the state and its rules are chatBusy.ts. This hook holds the
// state, sends it events, and runs the one timer its next expiry asks for: the timer only feeds the
// `expired` event, it never holds the mode.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Key } from '@roadmap/health-core/chat-turn';
import { IDLE, nextExpiry, othersReplyIn, othersSending, transition, type BusyEvent } from './chatBusy';

export { REMOTE_PENDING_MS } from './chatBusy';

/** Another tab's post, as the hook hears it. */
export interface RemotePost { sending: boolean | undefined; shows: boolean; asked: Key | undefined; shown: Key | undefined }

export function useChatBusy() {
  // One copy of the state, read now by Send before the re-render (US-15 AC7a) and by render through the store.
  const [box] = useState(() => {
    let current = IDLE;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      apply: (e: BusyEvent) => { current = transition(current, e); listeners.forEach((l) => l()); },
    };
  });
  const state = useSyncExternalStore(box.subscribe, box.get);
  const { apply } = box;
  const othersBusyNow = useCallback(() => othersSending(box.get()), [box]);
  /** This tab's send ended: an older bundle's wait ends with it (AC17c). */
  const ownEnded = useCallback(() => apply({ type: 'own-ended' }), [apply]);
  /** Another tab's word on its own send (AC17c), heard as `local` is shown here after the mirror (AC17d). */
  const onRemote = useCallback((from: string, post: RemotePost, local: Key) => apply({ type: 'post', from, ...post, local, now: Date.now() }), [apply]);
  const until = nextExpiry(state);
  useEffect(() => {
    if (until === null) return;
    // The timer runs on the monotonic clock: a wall clock that lags it must still end the wait (PR 1745 R1).
    const timer = setTimeout(() => apply({ type: 'expired', now: Math.max(Date.now(), until) }), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until, apply]);
  return {
    othersBusy: othersSending(state),
    /** Another tab's reply asked in the chat shown here (AC17d). */
    othersReplyIn: (shown: Key) => othersReplyIn(state, shown),
    othersBusyNow, ownEnded, onRemote,
  };
}
