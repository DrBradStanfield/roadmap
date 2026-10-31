import type { KeyboardEvent, ReactNode } from 'react';

export type TabId = 'input' | 'plan' | 'chat';

/** The iPhone app's three tabs (RootView.swift), in its order and words. */
const TABS: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  {
    id: 'input',
    label: 'My data',
    // list.bullet.clipboard
    icon: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h4" /></>,
  },
  {
    id: 'plan',
    label: 'My plan',
    // heart.text.square
    icon: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 11.5c-1.6-2.2-4.5-1-3.6 1.2.6 1.4 3.6 3.3 3.6 3.3s3-1.9 3.6-3.3c.9-2.2-2-3.4-3.6-1.2zM7 7h10" /></>,
  },
  {
    id: 'chat',
    label: 'Chat',
    // bubble.left.and.text.bubble.right
    icon: <><path d="M4 5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /><path d="M16 9h4a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v3l-3-3h-3a2 2 0 0 1-2-1.5" /></>,
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
