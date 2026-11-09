// The chat's busy state (US-15 AC17, AC17a-c): the pending reply shows, and
// the input and Send are disabled, while this tab's own send or any other
// tab's is in flight. Each send is tracked on its own:
//   this tab:   from startOwnSend, as it sends, to endOwnSend, as its request settles;
//   other tabs: one entry each, from a message saying `sending` until that tab
//               says it is not, or REMOTE_PENDING_MS after its latest such word
//               (a tab closed mid-reply never says).
// Busy is derived from these on every change, so one tab's end never frees another's send.
// An older bundle's message has no `sending`, only what it shows, which can
// mirror another tab's reply and is never followed by its own end: such an
// entry ends at any tab's word that its send ended, this tab's included, as all waits did before.
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long another tab's reply in flight may lock this tab's chat with no word from it (US-15 AC17a). */
export const REMOTE_PENDING_MS = 5 * 60_000;

export function useChatBusy() {
  const [isLoading, setIsLoading] = useState(false);
  const ownSendRef = useRef(false);
  const [remoteSends] = useState(() => new Map<string, ReturnType<typeof setTimeout>>());
  /** Busy now, before the re-render (US-15 AC7a). */
  const busyNow = useCallback(() => ownSendRef.current || remoteSends.size > 0, [remoteSends]);
  const ownSending = useCallback(() => ownSendRef.current, []);
  const [legacy] = useState(() => new Set<string>());
  const drop = useCallback((instanceId: string) => {
    clearTimeout(remoteSends.get(instanceId));
    remoteSends.delete(instanceId);
    legacy.delete(instanceId);
  }, [remoteSends, legacy]);
  const setOwnSend = useCallback((on: boolean) => {
    ownSendRef.current = on;
    if (!on) legacy.forEach(drop); // this tab's word that its send ended
    setIsLoading(busyNow());
  }, [legacy, drop, busyNow]);
  const startOwnSend = useCallback(() => setOwnSend(true), [setOwnSend]);
  const endOwnSend = useCallback(() => setOwnSend(false), [setOwnSend]);
  /** Another tab's word on its own send (AC17c); `sending` is undefined from an older bundle, which says only what it `shows`. */
  const onRemote = useCallback((instanceId: string, sending: boolean | undefined, shows: boolean) => {
    drop(instanceId);
    if (sending ?? shows) {
      remoteSends.set(instanceId, setTimeout(() => { drop(instanceId); setIsLoading(busyNow()); }, REMOTE_PENDING_MS));
      if (sending === undefined) legacy.add(instanceId);
    } else if (!shows) legacy.forEach(drop); // a mirror (sending false, shows true) is no end
    setIsLoading(busyNow());
  }, [remoteSends, legacy, drop, busyNow]);
  useEffect(() => () => { remoteSends.forEach(clearTimeout); remoteSends.clear(); legacy.clear(); }, [remoteSends, legacy]);
  return { isLoading, busyNow, ownSending, startOwnSend, endOwnSend, onRemote };
}
