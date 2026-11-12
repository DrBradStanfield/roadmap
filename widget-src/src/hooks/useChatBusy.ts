// Other tabs' sends (US-15 AC17, AC17a-c): Send is disabled while any other
// tab's send is in flight. This tab's own send is the chat-turn store's `turn`
// (useChatState). Each other tab is tracked on its own: one entry each, from a
// message saying `sending` until that tab says it is not, or REMOTE_PENDING_MS
// after its latest such word (a tab closed mid-reply never says).
// Busy is derived from these on every change, so one tab's end never frees another's send.
// An older bundle's message has no `sending`, only what it shows, which can
// mirror another tab's reply and is never followed by its own end: such an
// entry ends at any tab's word that its send ended, this tab's included
// (`ownEnded`, the store's own-ended effect), as all waits did before.
import { useCallback, useEffect, useState } from 'react';

/** How long another tab's reply in flight may lock this tab's chat with no word from it (US-15 AC17a). */
export const REMOTE_PENDING_MS = 5 * 60_000;

export function useChatBusy() {
  const [othersBusy, setOthersBusy] = useState(false);
  const [remoteSends] = useState(() => new Map<string, ReturnType<typeof setTimeout>>());
  /** Another tab's send in flight now, before the re-render (US-15 AC7a). */
  const othersBusyNow = useCallback(() => remoteSends.size > 0, [remoteSends]);
  const [legacy] = useState(() => new Set<string>());
  const drop = useCallback((instanceId: string) => {
    clearTimeout(remoteSends.get(instanceId));
    remoteSends.delete(instanceId);
    legacy.delete(instanceId);
  }, [remoteSends, legacy]);
  /** This tab's send ended: an older bundle's wait ends with it (AC17c). */
  const ownEnded = useCallback(() => {
    legacy.forEach(drop);
    setOthersBusy(othersBusyNow());
  }, [legacy, drop, othersBusyNow]);
  /** Another tab's word on its own send (AC17c); `sending` is undefined from an older bundle, which says only what it `shows`. */
  const onRemote = useCallback((instanceId: string, sending: boolean | undefined, shows: boolean) => {
    drop(instanceId);
    if (sending ?? shows) {
      remoteSends.set(instanceId, setTimeout(() => { drop(instanceId); setOthersBusy(othersBusyNow()); }, REMOTE_PENDING_MS));
      if (sending === undefined) legacy.add(instanceId);
    } else if (!shows) legacy.forEach(drop); // a mirror (sending false, shows true) is no end
    setOthersBusy(othersBusyNow());
  }, [remoteSends, legacy, drop, othersBusyNow]);
  useEffect(() => () => { remoteSends.forEach(clearTimeout); remoteSends.clear(); legacy.clear(); }, [remoteSends, legacy]);
  return { othersBusy, othersBusyNow, ownEnded, onRemote };
}
