/**
 * The widgets page follows a newer erase by starting over (US-75 AC8). Another writer's erase reaches this page
 * only by a re-read (the live refresh, or the flush inside a save), announced as REMOTE_CHANGED_EVENT. Then the
 * widget under it remounts, keyed by the erase it shows, so nothing typed under the old erase stays on screen,
 * and the store's mark moves once the new tree is committed, as the full app's useErase moves it (US-16 AC2d).
 */
import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { getEraseIdentity, getShownErase, markEraseShown } from '../lib/roadmap-data';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';

export function FollowErase({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(getShownErase);
  useEffect(() => {
    const follow = () => setShown(getEraseIdentity());
    follow(); // an erase heard before this mounted
    window.addEventListener(REMOTE_CHANGED_EVENT, follow);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, follow);
  }, []);
  useLayoutEffect(() => { markEraseShown(shown); }, [shown]);
  return <Fragment key={shown}>{children}</Fragment>;
}
