export type TabId = 'profile' | 'vitals' | 'blood-tests' | 'medications' | 'screening' | 'results';

export interface Tab {
  id: TabId;
  label: string;
  visible: boolean;
}

interface MobileTabBarProps {
  tabs: Tab[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function MobileTabBar({ tabs, activeTab, onTabChange }: MobileTabBarProps) {
  const visibleTabs = tabs.filter(t => t.visible);

  return (
    <div className="mobile-tab-bar" role="tablist">
      {visibleTabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`mobile-tab${activeTab === tab.id ? ' mobile-tab--active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
