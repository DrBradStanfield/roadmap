export type TabId = 'input' | 'plan';

export interface MobileTabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function MobileTabBar({ activeTab, onTabChange }: MobileTabBarProps) {
  return (
    <div className="mobile-tab-bar-container">
      <div className="mobile-tab-bar" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'input'}
          className={`mobile-tab${activeTab === 'input' ? ' mobile-tab--active' : ''}`}
          onClick={() => onTabChange('input')}
        >
          Input
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'plan'}
          className={`mobile-tab${activeTab === 'plan' ? ' mobile-tab--active' : ''}`}
          onClick={() => onTabChange('plan')}
        >
          Plan
        </button>
      </div>
    </div>
  );
}
