// @vitest-environment jsdom
/**
 * US-20 AC6, the phone's bottom tab bar, as the person sees the whole widget:
 * three tabs (My health, Chat, Account; US-62 AC16, AC34) pick one panel each;
 * arrow keys move between them; each tab keeps its own scroll position; the bar is sticky inside
 * the widget, opaque, never fixed to the viewport; the chat's draft survives a
 * switch. US-20 AC2: crossing the breakpoint mid-session never crashes. US-62
 * AC34: Sign in and Settings live in the Account tab, not on a row. jsdom ignores
 * media queries, so the phone CSS is checked as text here and by computed style
 * in tools/webkit-verify.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
// Where the record lives: this browser unless a test connects a cloud (US-62 AC34's card order).
const backend = vi.hoisted(() => ({ kind: 'local' as 'local' | 'cloud' }));
vi.mock('../lib/roadmap-data', async original => ({
  ...(await original<typeof import('../lib/roadmap-data')>()),
  getBackendKind: () => backend.kind,
}));
import { HealthTool } from './HealthTool';
import { GuestContext } from '../lib/storage-notice';
// standalone/app.tsx marks a true guest (no provider to reconnect) once per page load.
const AsGuest = ({ children }: { children: React.ReactNode }) => <GuestContext.Provider value>{children}</GuestContext.Provider>;

const stops: Array<() => void> = [];
let phone = true;
let scrollY = 0;
const heard = new Set<{ q: string; listener: (e: { matches: boolean }) => void }>();
function turn(toPhone: boolean) {
  act(() => {
    phone = toPhone;
    for (const h of [...heard]) h.listener({ matches: h.q.includes('max-width') ? phone : !phone });
  });
}
const scrollTo = vi.fn((x: number | ScrollToOptions, y?: number) => { scrollY = typeof x === 'object' ? x.top! : y!; });

beforeEach(async () => {
  phone = true;
  backend.kind = 'local';
  scrollY = 0;
  scrollTo.mockClear();
  localStorage.clear(); sessionStorage.clear();
  // A live matchMedia: flipping `phone` and calling `turn()` crosses 768px.
  heard.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q.includes('max-width') ? phone : !phone; }, media: q,
    addEventListener: (_: string, listener: (e: { matches: boolean }) => void) => heard.add({ q, listener }),
    removeEventListener: (_: string, listener: (e: { matches: boolean }) => void) => {
      for (const h of heard) if (h.listener === listener) heard.delete(h);
    },
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  vi.stubGlobal('scrollTo', scrollTo);
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function renderPhone(storageBar?: React.ReactNode) {
  const view = render(<HealthTool storageBar={storageBar} />);
  await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
  return view;
}
const panelOf = (view: ReturnType<typeof render>, tab: HTMLElement) =>
  view.container.querySelector<HTMLElement>(`[id="${tab.getAttribute('aria-controls')}"]`)!;

describe('US-20 AC6: the bottom tab bar', () => {
  // US-62 AC16, AC34: My health and Chat in the iPhone's words, then Account; the plan's cards sit in My health's topics.
  it('three tabs; each controls one panel and only the active panel shows', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['My health', 'Chat', 'Account']);
    for (const tab of tabs) {
      const panel = panelOf(view, tab);
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    const [health, chat, account] = tabs;
    expect(panelOf(view, health).querySelector('.health-input-panel .mh-sections .suggestion-card')).not.toBeNull();
    expect(panelOf(view, chat).querySelector('.chat-embed')).not.toBeNull();
    // Every tab draws the same icon style: one 24-unit stroked svg, hidden from screen readers.
    for (const tab of tabs) expect(tab.querySelector('svg.hr-tab-icon[viewBox="0 0 24 24"][aria-hidden="true"]')).not.toBeNull();

    const shown = () => tabs.filter((t) => !panelOf(view, t).hidden).map((t) => t.textContent);
    const selected = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
    expect(shown()).toEqual(['My health']);
    expect(selected()).toEqual(['My health']);

    fireEvent.click(chat);
    expect(shown()).toEqual(['Chat']);
    expect(selected()).toEqual(['Chat']);
    expect(chat.className).toContain('hr-tab--active');

    fireEvent.click(account);
    expect(shown()).toEqual(['Account']);
    expect(selected()).toEqual(['Account']);
    expect(panelOf(view, account).querySelector('.mh-settings')).not.toBeNull();

    fireEvent.click(health);
    expect(shown()).toEqual(['My health']);
  });

  it('arrow keys move along the tabs and wrap; Home and End jump; focus follows; one tab stop', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const [health, chat, account] = within(bar).getAllByRole('tab');
    expect([health, chat, account].map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(health, { key: 'ArrowRight' });
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chat);
    expect([health, chat, account].map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(account.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(account); // Account's panel takes no focus from its tab (US-62 AC34)
    fireEvent.keyDown(account, { key: 'ArrowRight' }); // wraps
    expect(health.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(health);

    fireEvent.keyDown(health, { key: 'ArrowLeft' }); // wraps back
    expect(account.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(account, { key: 'Home' });
    expect(health.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(health, { key: 'End' });
    expect(account.getAttribute('aria-selected')).toBe('true');
    expect(panelOf(view, account).hidden).toBe(false);
  });

  // Instant, not the theme's smooth scroll: a smooth restore slid from the top for a second (live test 2026-11-06).
  const at = (top: number) => ({ top, behavior: 'instant' });
  it('each tab keeps its own scroll position, restored at once; a first visit opens at its panel\'s top', async () => {
    const view = await renderPhone();
    const [health, chat] = within(view.getByRole('tablist')).getAllByRole('tab');
    let chatTop = 250; // the chat panel's top, relative to the viewport, under the page's title block
    vi.spyOn(panelOf(view, chat), 'getBoundingClientRect').mockImplementation(() => ({ top: chatTop } as DOMRect));

    scrollY = 900; // down My health
    fireEvent.click(chat); // never visited: its panel fills the screen, from its top (design review 2026-11-06)
    expect(scrollTo).toHaveBeenLastCalledWith(at(1150));

    scrollY = 1500; chatTop = -350; // down the chat
    fireEvent.click(health);
    expect(scrollTo).toHaveBeenLastCalledWith(at(900));
    fireEvent.click(chat);
    expect(scrollTo).toHaveBeenLastCalledWith(at(1500));
  });

  // Live test 2026-11-06: the card ended 3-5px under the bar, sized from the header plus a constant.
  it('the chat card is sized from its own measured top and the bar\'s height, so it ends at the bar', async () => {
    const view = await renderPhone();
    const [, chat] = within(view.getByRole('tablist')).getAllByRole('tab');
    const panel = panelOf(view, chat);
    vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => ({ top: 250 } as DOMRect));
    vi.spyOn(panel.querySelector('.chat-embed')!, 'getBoundingClientRect').mockImplementation(() => ({ top: 267 } as DOMRect));
    vi.spyOn(view.container.querySelector('.hr-tabbar')!, 'getBoundingClientRect').mockImplementation(() => ({ height: 51 } as DOMRect));
    fireEvent.click(chat);
    const root = view.container.querySelector<HTMLElement>('.health-tool')!;
    expect(root.style.getPropertyValue('--hr-chat-top')).toBe('17px'); // no theme header here: the card's own inset
    expect(root.style.getPropertyValue('--hr-tabbar-h')).toBe('51px');
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/height: calc\(100svh - var\(--hr-chat-top, 0px\) - var\(--hr-tabbar-h, 51px\) - 12px\)/);
  });

  it('the bar lives inside the widget, sticky, opaque, never fixed; the old fixed plan button is gone', async () => {
    const view = await renderPhone();
    expect(view.getByRole('tablist').closest('.health-tool')).not.toBeNull();
    expect(view.queryByText('See Your Personalized Plan')).toBeNull();
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const rule = (selector: string) => {
      const at = css.indexOf(`  ${selector} {`);
      expect(at).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.hr-tabbar')).toContain('position: sticky;');
    expect(rule('.hr-tabbar')).toContain('bottom: 0;');
    expect(rule('.hr-tabbar')).toContain('padding-bottom: env(safe-area-inset-bottom, 0px);');
    expect(rule('.hr-tabbar')).not.toContain('fixed');
    expect(rule('.hr-tabbar')).toContain('background: #f8f8fa;'); // opaque: nothing shows through
    expect(css).not.toContain('backdrop-filter');
    expect(rule('.hr-tab--active')).toContain('color: var(--color-brand-text);');
    expect(css).not.toMatch(/swiper|mobile-view-plan-btn|mobile-tab/i);
  });

  it('the chat\'s draft survives a tab switch: the panel stays mounted', async () => {
    const view = await renderPhone();
    const tabs = within(view.getByRole('tablist'));
    fireEvent.click(tabs.getByRole('tab', { name: 'Chat' }));
    const box = view.getByPlaceholderText('Ask a question') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'What about my LDL?' } });
    fireEvent.click(tabs.getByRole('tab', { name: 'My health' }));
    fireEvent.click(tabs.getByRole('tab', { name: 'Chat' }));
    expect(view.getByPlaceholderText('Ask a question')).toBe(box);
    expect(box.value).toBe('What about my LDL?');
  });

  it('US-20 AC2: crossing the breakpoint mid-session never crashes, and the tab survives', async () => {
    const view = await renderPhone();
    fireEvent.click(within(view.getByRole('tablist')).getByRole('tab', { name: 'Chat' }));
    turn(false); // widened past 768px: the desktop column
    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.container.querySelector('.health-tool-content .health-tool-main .mh-sections')).not.toBeNull();
    turn(true); // and back
    const chat = within(view.getByRole('tablist')).getByRole('tab', { name: 'Chat' });
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(panelOf(view, chat).hidden).toBe(false);
  });

  it('desktop has no tab bar and no tab panels', async () => {
    phone = false;
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.health-tool-content')).not.toBeNull());
    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.container.querySelector('[role="tabpanel"]')).toBeNull();
  });
});

// US-62 AC34 (option A, Brad 2026-11-09): a phone has no row for Sign in and Settings; the
// Account tab holds them. Amends US-20 AC7 and US-62 AC16, AC24, AC32.
describe('US-62 AC34: the Account tab', () => {
  const tabNamed = (view: ReturnType<typeof render>, name: string) => within(view.getByRole('tablist')).getByRole('tab', { name });

  it('My health draws no controls on its title line; its title stays, for screen readers and the landings', async () => {
    const view = await renderPhone(<button type="button">Sign in</button>);
    const header = view.container.querySelector<HTMLElement>('.mh-header')!;
    expect(header.querySelector('h2.mh-title')?.textContent).toBe('My health');
    expect(header.querySelectorAll('button')).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Sign in' })).toBeNull(); // not until Account shows
    expect(view.container.querySelector('.hr-top-bar')).toBeNull();
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const phone = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
    expect(phone).toMatch(/\.mh-header\s*\{\s*display:\s*contents;/); // no row, no gap
  });

  // Brad 2026-11-09: one sign-in, the storage card's button. The title line holds only what the
  // storage bar draws there (on a phone, no Sign in: standalone/storage-bar.test.tsx).
  const guestCard = ({ hasData }: { hasData: boolean }) => (hasData
    ? <div className="hr-sync"><button type="button" className="hr-sync-btn hr-sync-btn-full">Keep my record in Dropbox or Google Drive</button></div>
    : null);

  it('signed out: Account holds Settings\' parts under its heading, the storage card\'s button the one sign-in; no Done', async () => {
    const view = render(<HealthTool syncControl={guestCard} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    const account = tabNamed(view, 'Account');
    fireEvent.click(account);
    const panel = panelOf(view, account);
    const sheet = panel.querySelector<HTMLElement>('.mh-settings')!;
    const heading = within(sheet).getByRole('heading', { name: 'Account' });
    expect(heading.closest('.mh-settings-head')!.querySelectorAll('button')).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Keep my record in Dropbox or Google Drive' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /Switch units/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Delete all my data' })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Done' })).toBeNull();
    expect(document.activeElement).not.toBe(heading); // the tab keeps the focus
    // Inside the widget's Clarity mask and its erase lock.
    expect(sheet.closest('[data-clarity-mask="true"]')).not.toBeNull();
    expect(sheet.closest('fieldset.health-form-lock')).not.toBeNull();
    // Escape is not a way out of a tab: nothing closes.
    fireEvent.keyDown(within(sheet).getByRole('button', { name: 'Delete all my data' }), { key: 'Escape' });
    expect(account.getAttribute('aria-selected')).toBe('true');
    expect(panel.querySelector('.mh-settings')).not.toBeNull();
    // The card keeps the storage button's filled style there (the flat Settings rule skips Account).
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/:not\(\.mh-account\) > \.mh-settings \.hr-sync \.hr-sync-btn,/);
  });

  it('a new guest with nothing entered still finds the sign-in in Account, and no pitch on My health', async () => {
    localStorage.clear();
    await initRoadmapStore(new LocalStorageAdapter());
    const view = render(<HealthTool syncControl={guestCard} />);
    const signIn = () => view.queryByRole('button', { name: 'Keep my record in Dropbox or Google Drive' });
    await waitFor(() => expect(view.container.querySelector('.health-input-panel')).not.toBeNull());
    expect(view.container.querySelector('.hr-sync')).toBeNull(); // nothing to save yet (US-09 AC5)
    fireEvent.click(tabNamed(view, 'Account'));
    expect(signIn()!.closest('.mh-settings')).not.toBeNull();
    fireEvent.click(tabNamed(view, 'My health'));
    expect(view.container.querySelector('.hr-sync')).toBeNull();
  });

  it('signed in: Account says where the record lives, as text, on its title line and shows the storage card', async () => {
    const card = () => <div className="hr-sync">Your health record lives in your Dropbox</div>;
    const view = render(<HealthTool storageBar={<span className="hr-storage-state">Synced to Dropbox</span>} syncControl={card} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    const account = tabNamed(view, 'Account');
    fireEvent.click(account);
    const sheet = panelOf(view, account).querySelector<HTMLElement>('.mh-settings')!;
    expect(sheet.querySelector('.mh-settings-head .mh-header-actions')?.textContent).toBe('Synced to Dropbox');
    expect([...view.container.querySelectorAll('.hr-sync')].map((c) => !!c.closest('.mh-settings'))).toEqual([true]); // one card, one picker
  });

  it('a sync problem shows atop My health on a phone, not only in Account; desktop keeps it on the title line', async () => {
    const problem = <button type="button" className="action-btn-small">Sign in to Google again</button>;
    const view = render(<HealthTool syncAlert={problem} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    const shown = view.getByRole('button', { name: 'Sign in to Google again' });
    expect(shown.closest('.mh-header')).not.toBeNull();
    expect(shown.closest('[hidden]')).toBeNull();
    turn(false);
    expect(view.queryByRole('button', { name: 'Sign in to Google again' })).toBeNull(); // desktop: the storage bar says it
  });

  it('a half-typed reminder email survives a tab switch: Account stays mounted', async () => {
    const view = render(<HealthTool remindersSection={<input aria-label="Email for your reminders" />} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    fireEvent.click(tabNamed(view, 'Account'));
    fireEvent.change(view.getByRole('textbox', { name: 'Email for your reminders' }), { target: { value: 'half@exa' } });
    fireEvent.click(tabNamed(view, 'Chat'));
    fireEvent.click(tabNamed(view, 'Account'));
    expect((view.getByRole('textbox', { name: 'Email for your reminders' }) as HTMLInputElement).value).toBe('half@exa');
  });

  it('a guest\'s storage card sits at the foot of My health, and moves to Account while it shows: one at a time', async () => {
    const card = () => <div className="hr-sync">Keep my record in Dropbox or Google Drive</div>;
    const view = render(<HealthTool storageBar={<button type="button">Sign in</button>} syncControl={card} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    const cards = () => [...view.container.querySelectorAll('.hr-sync')];
    expect(cards()).toHaveLength(1);
    expect(cards()[0].closest('.mh-foot-storage')?.hasAttribute('hidden')).toBe(false);
    fireEvent.click(tabNamed(view, 'Account'));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].closest('.mh-settings')).not.toBeNull();
    fireEvent.click(tabNamed(view, 'Chat'));
    expect(cards()).toHaveLength(1);
    // Mounted in the hidden My health, so the picker it hosts still opens from a banner or the upload.
    expect(cards()[0].closest('.mh-foot-storage')).not.toBeNull();
  });

  // Brad 2026-11-09: a guest's sign-in heads Account; a connected record's card stays low.
  const settingsOrder = (view: ReturnType<typeof render>) => {
    const sheet = [...view.container.querySelectorAll<HTMLElement>('.mh-settings')].find((el) => !el.closest('[hidden]'))!;
    return [...sheet.children].map((el) => (el.matches('.mh-settings-head') ? 'title'
      : el.matches('.hr-sync') ? 'storage'
        : el.querySelector('.basic-info-units, [aria-label^="Switch units"]') || el.matches('.basic-info-section, .about-you-card') ? 'about'
          : el.matches('.delete-data-section') ? 'delete' : 'other'));
  };

  it('a guest\'s storage card comes first in Account, straight under the title, before About you (US-62 AC34)', async () => {
    const view = render(<AsGuest><HealthTool syncControl={guestCard} /></AsGuest>);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    fireEvent.click(tabNamed(view, 'Account'));
    const order = settingsOrder(view);
    expect(order.slice(0, 3)).toEqual(['title', 'storage', 'about']);
    expect(order.indexOf('storage')).toBeLessThan(order.indexOf('delete'));
    expect(order.filter((p) => p === 'storage')).toHaveLength(1);
    expect(view.getByRole('button', { name: 'Keep my record in Dropbox or Google Drive' }).closest('.mh-settings')).not.toBeNull();
  });

  it('a new guest\'s storage card also comes first in Account (US-62 AC34)', async () => {
    localStorage.clear();
    await initRoadmapStore(new LocalStorageAdapter());
    const view = render(<AsGuest><HealthTool syncControl={guestCard} /></AsGuest>);
    await waitFor(() => expect(view.container.querySelector('.health-input-panel')).not.toBeNull());
    fireEvent.click(tabNamed(view, 'Account'));
    expect(settingsOrder(view).slice(0, 2)).toEqual(['title', 'storage']);
  });

  it('a connected record keeps its storage card low in Account, after About you (US-62 AC34)', async () => {
    backend.kind = 'cloud';
    const card = () => <div className="hr-sync">Your health record lives in your Dropbox</div>;
    const view = render(<HealthTool storageBar={<span className="hr-storage-state">Synced to Dropbox</span>} syncControl={card} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    fireEvent.click(tabNamed(view, 'Account'));
    const order = settingsOrder(view);
    expect(order[1]).toBe('about');
    expect(order.indexOf('storage')).toBeGreaterThan(order.indexOf('about'));
    expect(order.indexOf('storage')).toBeLessThan(order.indexOf('delete'));
  });

  it('a reconnect keeps its storage card low in Account, after About you: its title line holds the reconnect (US-62 AC34)', async () => {
    // A reconnect: the record waits on this device (backend local), but it is not a guest.
    const card = () => <div className="hr-sync"><button type="button" className="hr-sync-btn">Sign in to Dropbox again</button></div>;
    const reconnect = <button type="button" className="action-btn-small">Sign in to Dropbox again</button>;
    const view = render(<HealthTool storageBar={reconnect} syncAlert={reconnect} syncControl={card} />);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    fireEvent.click(tabNamed(view, 'Account'));
    const order = settingsOrder(view);
    expect(order[1]).toBe('about');
    expect(order.indexOf('storage')).toBeGreaterThan(order.indexOf('about'));
    expect(order.indexOf('storage')).toBeLessThan(order.indexOf('delete'));
  });

  it('desktop Settings keep the storage card after About you, guest or not (US-62 AC34)', async () => {
    phone = false;
    const view = render(<AsGuest><HealthTool storageBar={<button type="button">Sign in</button>} syncControl={guestCard} /></AsGuest>);
    await waitFor(() => expect(view.container.querySelector('.mh-sections .suggestion-title')).not.toBeNull());
    fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    const order = settingsOrder(view);
    expect(order[1]).toBe('about');
    expect(order.indexOf('storage')).toBeGreaterThan(order.indexOf('about'));
  });

  it('Delete all my data in Account lands on My health, its title focused', async () => {
    vi.stubGlobal('confirm', () => true);
    const view = await renderPhone();
    const account = tabNamed(view, 'Account');
    fireEvent.click(account);
    fireEvent.click(view.getByRole('button', { name: 'Delete all my data' }));
    await waitFor(() => expect(tabNamed(view, 'My health').getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector('.mh-title')));
    expect(panelOf(view, account).hidden).toBe(true);
  });
});

describe('US-15 AC53 and US-62 AC14: one chat on a phone', () => {
  it('a phone shows no floating chat button: the Chat tab is the chat', async () => {
    await renderPhone();
    expect(document.querySelector('.chat-fab')).toBeNull();
  });
});
