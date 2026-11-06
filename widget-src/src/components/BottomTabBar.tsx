import type { KeyboardEvent, ReactNode } from 'react';
import { CHAT_BUBBLES } from './icons';

export type TabId = 'health' | 'chat';

/** The iPhone app's two tabs (RootView.swift, US-73 AC1), in its order and words (US-62 AC16). */
const TABS: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  {
    id: 'health',
    label: 'My health',
    // heart.text.square
    icon: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 11.5c-1.6-2.2-4.5-1-3.6 1.2.6 1.4 3.6 3.3 3.6 3.3s3-1.9 3.6-3.3c.9-2.2-2-3.4-3.6-1.2zM7 7h10" /></>,
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: CHAT_BUBBLES,
  },
];

/** Panel and tab ids, so each tab's aria-controls names its panel. */
export const tabDomId = (prefix: string, tab: TabId) => `${prefix}-tab-${tab}`;
export const panelDomId = (prefix: string, tab: TabId) => `${prefix}-panel-${tab}`;

/**
 * US-20 AC6: the phone's bottom tab bar. Sticky at the foot of the widget, never
 * fixed to the viewport: a sticky child cannot leave its container, so it never
 * floats over the page around the widget.
 */
export function BottomTabBar({ activeTab, onTabChange, idPrefix }: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  idPrefix: string;
}) {
  // Arrow keys move along the tabs and wrap; Home and End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === activeTab);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const tab = TABS[(next + TABS.length) % TABS.length].id;
    onTabChange(tab);
    document.getElementById(tabDomId(idPrefix, tab))?.focus();
  };
  return (
    <div className="hr-tabbar no-print" role="tablist" aria-label="Sections" onKeyDown={onKeyDown}>
      {TABS.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={tabDomId(idPrefix, id)}
          aria-selected={activeTab === id}
          aria-controls={panelDomId(idPrefix, id)}
          tabIndex={activeTab === id ? 0 : -1}
          className={`hr-tab${activeTab === id ? ' hr-tab--active' : ''}`}
          onClick={() => onTabChange(id)}
        >
          <svg className="hr-tab-icon" viewBox="0 0 24 24" aria-hidden="true">{icon}</svg>
          <span className="hr-tab-label">{label}</span>
        </button>
      ))}
    </div>
  );
}
