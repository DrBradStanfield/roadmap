import { useRef, useState, useEffect } from 'react';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);

  // Detect overflow and update fade visibility
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const checkOverflow = () => {
      setShowFade(
        el.scrollWidth > el.clientWidth &&
        el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      );
    };

    checkOverflow();
    el.addEventListener('scroll', checkOverflow);
    window.addEventListener('resize', checkOverflow);
    return () => {
      el.removeEventListener('scroll', checkOverflow);
      window.removeEventListener('resize', checkOverflow);
    };
  }, [visibleTabs.length]);

  // Auto-scroll active tab into view when it changes (e.g. via Next/Back)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const activeButton = el.querySelector('[aria-selected="true"]');
    if (activeButton) {
      activeButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [activeTab]);

  return (
    <div className={`mobile-tab-bar-container${showFade ? ' has-overflow' : ''}`}>
      <div className="mobile-tab-bar" ref={scrollRef} role="tablist">
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
    </div>
  );
}

interface MobileTabNavProps {
  tabs: Tab[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function MobileTabNav({ tabs, activeTab, onTabChange }: MobileTabNavProps) {
  const visible = tabs.filter(t => t.visible);
  const currentIndex = visible.findIndex(t => t.id === activeTab);
  const prev = currentIndex > 0 ? visible[currentIndex - 1] : null;
  const next = currentIndex < visible.length - 1 ? visible[currentIndex + 1] : null;

  return (
    <div className="mobile-tab-nav">
      {prev ? (
        <button className="mobile-tab-nav-btn" onClick={() => onTabChange(prev.id)}>
          &larr; {prev.label}
        </button>
      ) : <div />}
      {next ? (
        <button
          className={`mobile-tab-nav-btn${next.id === 'results' ? ' mobile-tab-nav-btn--primary' : ''}`}
          onClick={() => onTabChange(next.id)}
        >
          {next.id === 'results' ? 'View Results \u2192' : `${next.label} \u2192`}
        </button>
      ) : null}
    </div>
  );
}
