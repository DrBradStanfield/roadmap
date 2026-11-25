/**
 * A widget follows a newer erase by starting over (US-75 AC8). Another writer's erase reaches the widgets page
 * only by a re-read (the live refresh, or the flush inside a save), announced as REMOTE_CHANGED_EVENT. Then the
 * tree under FollowErase remounts, keyed by the erase it shows, so nothing typed under the old erase stays on
 * screen, and the store's mark moves once the new tree is committed, as the full app's useErase moves it (US-16 AC2d).
 *
 * Each block is its own React root, so one may follow before another. A tree's saves therefore take the erase it
 * was mounted under (useTreeErase), never the page's mark: a tree not yet followed writes under the old erase,
 * which the store refuses.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { getEraseIdentity, getShownErase, markEraseShown } from '../lib/roadmap-data';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';

const TreeErase = createContext<string | null>(null);

/** The erase this tree was mounted under; it never changes for the tree's life. Only under FollowErase. */
export function useTreeErase(): string {
  const erase = useContext(TreeErase);
  if (erase === null) throw new Error('useTreeErase outside FollowErase');
  return erase;
}

export function FollowErase({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(getShownErase);
  useEffect(() => {
    const follow = () => setShown(getEraseIdentity());
    follow(); // an erase heard before this mounted
    window.addEventListener(REMOTE_CHANGED_EVENT, follow);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, follow);
  }, []);
  useLayoutEffect(() => { markEraseShown(shown); }, [shown]);
  return <TreeErase.Provider key={shown} value={shown}>{children}</TreeErase.Provider>;
}
