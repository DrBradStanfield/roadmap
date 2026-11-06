// @vitest-environment jsdom
/**
 * US-20 AC6, the phone's bottom tab bar, as the person sees the whole widget:
 * three tabs (My data, My plan, Chat) pick one panel each; arrow keys move
 * between them; each tab keeps its own scroll position; the bar is sticky inside
 * the widget, opaque, never fixed to the viewport; the chat's draft survives a
 * switch. US-20 AC2: crossing the breakpoint mid-session never crashes. US-20
 * AC7: the storage button sits in a top bar seen from every tab. jsdom ignores
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
import { HealthTool } from './HealthTool';

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
  // US-62 AC16: two tabs, My health and Chat; the plan's cards sit in My health's topics.
  it('two tabs, in the iPhone\'s words; each controls one panel and only the active panel shows', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['My health', 'Chat']);
    for (const tab of tabs) {
      const panel = panelOf(view, tab);
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    const [health, chat] = tabs;
    expect(panelOf(view, health).querySelector('.health-input-panel .mh-sections .suggestion-card')).not.toBeNull();
    expect(panelOf(view, chat).querySelector('.chat-embed')).not.toBeNull();

    const shown = () => tabs.filter((t) => !panelOf(view, t).hidden).map((t) => t.textContent);
    const selected = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
    expect(shown()).toEqual(['My health']);
    expect(selected()).toEqual(['My health']);

    fireEvent.click(chat);
    expect(shown()).toEqual(['Chat']);
    expect(selected()).toEqual(['Chat']);
    expect(chat.className).toContain('hr-tab--active');

    fireEvent.click(health);
    expect(shown()).toEqual(['My health']);
  });

  it('arrow keys move along the tabs and wrap; Home and End jump; focus follows; one tab stop', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const [health, chat] = within(bar).getAllByRole('tab');
    expect([health, chat].map((t) => t.tabIndex)).toEqual([0, -1]);

    fireEvent.keyDown(health, { key: 'ArrowRight' });
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chat);
    expect([health, chat].map((t) => t.tabIndex)).toEqual([-1, 0]);

    fireEvent.keyDown(chat, { key: 'ArrowRight' }); // wraps
    expect(health.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(health);

    fireEvent.keyDown(health, { key: 'ArrowLeft' }); // wraps back
    expect(chat.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(chat, { key: 'Home' });
    expect(health.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(health, { key: 'End' });
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(panelOf(view, chat).hidden).toBe(false);
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

// US-20 AC7 as amended by US-62 AC24 (design review 2026-11-06): no band of its own;
// the storage and person buttons sit on My health's title line.
describe('US-20 AC7: Sign in on My health\'s title line', () => {
  it('on a phone the storage and person buttons share the title row; no top bar', async () => {
    const view = await renderPhone(<button type="button">Sign in</button>);
    const signIn = view.getByRole('button', { name: 'Sign in' });
    const header = signIn.closest('.mh-header')!;
    expect(header.querySelector('.mh-title')?.textContent).toBe('My health');
    expect(within(header as HTMLElement).getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(view.container.querySelector('.hr-top-bar')).toBeNull();
    expect(view.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).not.toContain('.hr-top-bar {');
  });
});

describe('US-15 AC53 and US-62 AC14: one chat on a phone', () => {
  it('a phone shows no floating chat button: the Chat tab is the chat', async () => {
    await renderPhone();
    expect(document.querySelector('.chat-fab')).toBeNull();
  });
});
