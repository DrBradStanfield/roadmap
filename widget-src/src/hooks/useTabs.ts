// The phone's tabs (US-20): which one shows, and each tab's own scroll
// position (AC6). The page scrolls, not the panel, so leaving a tab records
// the page's offset and coming back restores it; a tab not yet visited opens
// at the widget's top. On a switch it also sizes the chat's card to the
// screen between the sticky header and the tab bar (--hr-chat-top,
// --hr-tabbar-h on the widget root), measured once the new panel shows.
import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { stickyTop } from '../lib/reveal';
import { panelDomId, type TabId } from '../components/BottomTabBar';

export function useTabs(rootRef: RefObject<HTMLDivElement | null>) {
  const [activeTab, setActiveTab] = useState<TabId>('health');
  /** The prefix of the tabs' and panels' DOM ids. */
  const tabIds = useId();
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const scrollByTab = useRef<Partial<Record<TabId, number>>>({});
  const scrollOnSwitch = useRef(false);
  /** The chat's card (ChatEmbed) and the tab bar (BottomTabBar), measured on a switch. */
  const chatCardRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const selectTab = useCallback((tab: TabId) => {
    if (tab === activeTabRef.current) return;
    scrollByTab.current[activeTabRef.current] = window.scrollY;
    scrollOnSwitch.current = true;
    setActiveTab(tab);
  }, []);
  useLayoutEffect(() => {
    if (!scrollOnSwitch.current) return;
    scrollOnSwitch.current = false;
    const saved = scrollByTab.current[activeTab];
    // A first visit opens at the tab's panel, just under the theme's sticky header. The chat's
    // card is sized to the screen left between its own top (the header, then the card's measured
    // inset in its panel) and the tab bar (styles.css, --hr-chat-top, --hr-tabbar-h).
    const sticky = stickyTop();
    const panel = document.getElementById(panelDomId(tabIds, activeTab));
    const card = chatCardRef.current && panel?.contains(chatCardRef.current) ? chatCardRef.current : null;
    const inset = panel && card ? card.getBoundingClientRect().top - panel.getBoundingClientRect().top : 0;
    rootRef.current?.style.setProperty('--hr-chat-top', `${Math.round(sticky + inset)}px`);
    rootRef.current?.style.setProperty('--hr-tabbar-h', `${Math.round(tabBarRef.current?.getBoundingClientRect().height ?? 51)}px`);
    const top = (panel?.getBoundingClientRect().top ?? 0) - sticky;
    // At once: the theme's smooth scrolling would slide the page from the top.
    if (saved !== undefined) window.scrollTo({ top: saved, behavior: 'instant' });
    else if (top !== 0) window.scrollTo({ top: window.scrollY + top, behavior: 'instant' });
  }, [activeTab]);

  return { activeTab, selectTab, tabIds, chatCardRef, tabBarRef };
}
