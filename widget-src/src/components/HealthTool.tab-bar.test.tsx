// @vitest-environment jsdom
/**
 * US-20 AC6, the phone's bottom tab bar, as the person sees the whole widget:
 * three tabs (My data, My plan, Chat) pick one panel each; arrow keys move
 * between them; each tab keeps its own scroll position; the bar hides while the
 * widget is off screen and is never fixed to the viewport; the chat's draft
 * survives a switch. US-20 AC7: the storage button sits in a top bar seen from
 * every tab. (Swiper, the old carousel, is gone: US-20 AC2's hazard with it.)
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

/** IntersectionObserver stand-in: the test decides when the widget is on screen. */
const observers: Array<{ el: Element; cb: IntersectionObserverCallback }> = [];
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) { observers.push({ el, cb: this.cb }); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}
function widgetOnScreen(visible: boolean) {
  const watched = observers.filter((o) => o.el.matches('.health-tool'));
  expect(watched.length).toBeGreaterThan(0);
  act(() => {
    for (const o of watched) o.cb([{ isIntersecting: visible, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

const stops: Array<() => void> = [];
let phone = true;
let scrollY = 0;
const scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; });

beforeEach(async () => {
  phone = true;
  scrollY = 0;
  scrollTo.mockClear();
  observers.length = 0;
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('IntersectionObserver', FakeObserver);
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
  await waitFor(() => expect(view.container.querySelector('.health-results-panel .suggestion-title')).not.toBeNull());
  return view;
}
const panelOf = (view: ReturnType<typeof render>, tab: HTMLElement) =>
  view.container.querySelector<HTMLElement>(`[id="${tab.getAttribute('aria-controls')}"]`)!;

describe('US-20 AC6: the bottom tab bar', () => {
  it('three tabs, in the iPhone\'s words; each controls one panel and only the active panel shows', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['My data', 'My plan', 'Chat']);
    for (const tab of tabs) {
      const panel = panelOf(view, tab);
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    const [data, plan, chat] = tabs;
    expect(panelOf(view, data).querySelector('.health-input-panel')).not.toBeNull();
    expect(panelOf(view, plan).querySelector('.health-results-panel')).not.toBeNull();
    expect(panelOf(view, chat).querySelector('.chat-embed')).not.toBeNull();

    const shown = () => tabs.filter((t) => !panelOf(view, t).hidden).map((t) => t.textContent);
    const selected = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
    expect(shown()).toEqual(['My data']);
    expect(selected()).toEqual(['My data']);

    fireEvent.click(plan);
    expect(shown()).toEqual(['My plan']);
    expect(selected()).toEqual(['My plan']);
    expect(plan.className).toContain('hr-tab--active');

    fireEvent.click(chat);
    expect(shown()).toEqual(['Chat']);
    expect(selected()).toEqual(['Chat']);
  });

  it('arrow keys move along the tabs and wrap; Home and End jump; focus follows; one tab stop', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    const [data, plan, chat] = within(bar).getAllByRole('tab');
    expect([data, plan, chat].map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(data, { key: 'ArrowRight' });
    expect(plan.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(plan);
    expect([data, plan, chat].map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(plan, { key: 'ArrowRight' });
    fireEvent.keyDown(chat, { key: 'ArrowRight' }); // wraps
    expect(data.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(data);

    fireEvent.keyDown(data, { key: 'ArrowLeft' }); // wraps back
    expect(chat.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(chat, { key: 'Home' });
    expect(data.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(data, { key: 'End' });
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(panelOf(view, chat).hidden).toBe(false);
  });

  it('each tab keeps its own scroll position; a first visit opens at the widget\'s top', async () => {
    const view = await renderPhone();
    const root = view.container.querySelector<HTMLElement>('.health-tool')!;
    let widgetTop = -300; // the widget's top, relative to the viewport
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ top: widgetTop } as DOMRect));
    const [data, plan] = within(view.getByRole('tablist')).getAllByRole('tab');

    scrollY = 900; // down the form
    fireEvent.click(plan); // never visited: to the widget's top
    expect(scrollTo).toHaveBeenLastCalledWith(0, 600);

    scrollY = 1500; widgetTop = -900; // down the plan
    fireEvent.click(data);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 900);
    fireEvent.click(plan);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1500);

    // The widget's top on screen: a first visit leaves the page where it is.
    scrollTo.mockClear();
    widgetTop = 40;
    fireEvent.click(within(view.getByRole('tablist')).getByRole('tab', { name: 'Chat' }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('the bar hides while the widget is off screen, and comes back with it', async () => {
    const view = await renderPhone();
    const bar = view.getByRole('tablist');
    expect(bar.classList.contains('hr-tabbar--offscreen')).toBe(false);
    widgetOnScreen(false);
    expect(bar.classList.contains('hr-tabbar--offscreen')).toBe(true);
    widgetOnScreen(true);
    expect(bar.classList.contains('hr-tabbar--offscreen')).toBe(false);
  });

  it('the bar lives inside the widget, sticky, never fixed; the old fixed plan button is gone', async () => {
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
    // Hidden off screen without losing its height, so the page below never moves.
    expect(rule('.hr-tabbar--offscreen')).toContain('visibility: hidden;');
    expect(rule('.hr-tab--active')).toContain('color: var(--color-brand-text);');
    expect(css).not.toMatch(/swiper|mobile-view-plan-btn|mobile-tab/i);
  });

  it('the chat\'s draft survives a tab switch: the panel stays mounted', async () => {
    const view = await renderPhone();
    const tabs = within(view.getByRole('tablist'));
    fireEvent.click(tabs.getByRole('tab', { name: 'Chat' }));
    const box = view.getByPlaceholderText('Ask a follow-up…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'What about my LDL?' } });
    fireEvent.click(tabs.getByRole('tab', { name: 'My data' }));
    fireEvent.click(tabs.getByRole('tab', { name: 'Chat' }));
    expect(view.getByPlaceholderText('Ask a follow-up…')).toBe(box);
    expect(box.value).toBe('What about my LDL?');
  });

  it('desktop has no tab bar and no tab panels', async () => {
    phone = false;
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.health-tool-content')).not.toBeNull());
    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.container.querySelector('[role="tabpanel"]')).toBeNull();
  });
});

describe('US-20 AC7: the top bar', () => {
  it('on a phone the storage button sits above the panels, seen from every tab', async () => {
    const view = await renderPhone(<button type="button">Sign in</button>);
    const signIn = view.getByRole('button', { name: 'Sign in' });
    expect(signIn.parentElement?.className).toBe('hr-top-bar');
    expect(signIn.closest('[role="tabpanel"]')).toBeNull();
    for (const name of ['My data', 'My plan', 'Chat']) {
      fireEvent.click(within(view.getByRole('tablist')).getByRole('tab', { name }));
      expect(signIn.closest('[hidden]')).toBeNull();
    }
    expect(view.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1); // not in the input header too
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain('.hr-top-bar { display: flex; justify-content: flex-end; padding: 8px 10px 0; }'); // the cards' 10px gutter
  });

  it('without a storage button, no top bar', async () => {
    const view = await renderPhone();
    expect(view.container.querySelector('.hr-top-bar')).toBeNull();
  });
});
