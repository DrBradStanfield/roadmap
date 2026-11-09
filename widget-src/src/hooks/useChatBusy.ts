// The chat's busy state (US-15 AC17, AC17a-c): the dots show, and the input
// and Send are disabled, while this tab's own send or any other tab's is in
// flight. Each send is tracked on its own:
//   this tab:   ownSendRef, set as it sends, cleared as its reply or error lands;
//   other tabs: one entry each, from a message saying `sending` until that tab
//               says it is not, or REMOTE_PENDING_MS after its latest such word
//               (a tab closed mid-reply never says).
// Busy is derived from these by updateBusy, never set by hand, so one tab's
// end never frees another's send.
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long another tab's reply in flight may lock this tab's chat with no word from it (US-15 AC17a). */
export const REMOTE_PENDING_MS = 5 * 60_000;

export function useChatBusy() {
  const [isLoading, setIsLoading] = useState(false);
  const isLoadingRef = useRef(false);
  const ownSendRef = useRef(false);
  const [remoteSends] = useState(() => new Map<string, ReturnType<typeof setTimeout>>());
  const updateBusy = useCallback(() => {
    const busy = ownSendRef.current || remoteSends.size > 0;
    setIsLoading(busy);
    isLoadingRef.current = busy; // a load landing before the re-render reads it (US-15 AC7a)
  }, [remoteSends]);
  /** Another tab's word on its own send (AC17c). */
  const onRemote = useCallback((instanceId: string, sending: boolean) => {
    clearTimeout(remoteSends.get(instanceId));
    if (sending) remoteSends.set(instanceId, setTimeout(() => { remoteSends.delete(instanceId); updateBusy(); }, REMOTE_PENDING_MS));
    else remoteSends.delete(instanceId);
    updateBusy();
  }, [remoteSends, updateBusy]);
  useEffect(() => () => { remoteSends.forEach(clearTimeout); remoteSends.clear(); }, [remoteSends]);
  return { isLoading, isLoadingRef, ownSendRef, updateBusy, onRemote };
}
