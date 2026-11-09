// @vitest-environment jsdom
// US-62 AC35 (c): the hero shows only above My health on a phone. The tab bar marks the page with
// the chosen tab (standalone.css hides `.hr-hero` for Chat and Account); desktop has no bar, no mark.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { BottomTabBar, type TabId } from './BottomTabBar';

function Bar() {
  const [tab, setTab] = useState<TabId>('health');
  return <BottomTabBar activeTab={tab} onTabChange={setTab} idPrefix="t"/>;
}

afterEach(cleanup);

describe('US-62 AC35 (c): the tab bar marks the page with its tab', () => {
  it('follows the chosen tab, and the mark goes when the bar goes (a phone widened to desktop)', () => {
    const view = render(<Bar/>);
    const mark = () => document.documentElement.getAttribute('data-hr-tab');
    expect(mark()).toBe('health');
    fireEvent.click(view.getByRole('tab', { name: 'Chat' }));
    expect(mark()).toBe('chat');
    fireEvent.click(view.getByRole('tab', { name: 'Account' }));
    expect(mark()).toBe('account');
    fireEvent.click(view.getByRole('tab', { name: 'My health' }));
    expect(mark()).toBe('health');
    view.unmount();
    expect(mark()).toBeNull();
  });
});
