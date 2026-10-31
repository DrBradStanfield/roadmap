// @vitest-environment jsdom
/**
 * US-62 AC4 and AC5, the web redesign's baseline, on today's layout:
 * AC4 — `tool_opened` goes once per tab with the device the layout chose at mount.
 * AC5 — `results_viewed` goes when the plan is on screen, not when it mounts:
 * on a phone when the Plan tab is active, on desktop when the plan column
 * enters the viewport. The Pages build sends neither.
 *
 * The real `trackProductEvent` runs (its throttle and its Shopify gate), so each
 * test reads the POSTs the server would get.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

const surface = vi.hoisted(() => ({ shopify: true }));
vi.mock('../lib/build-flags', () => ({
  LOCAL_FIRST: true,
  get SHOPIFY_SURFACE() { return surface.shopify; },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
import { HealthTool } from './HealthTool';

/** Every product event POSTed, as { eventName, metadata }. */
let sent: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
const named = (name: string) => sent.filter((e) => e.eventName === name);

/** IntersectionObserver stand-in: the test decides when an element is on screen. */
const observers: Array<{ el: Element; cb: IntersectionObserverCallback; options?: IntersectionObserverInit }> = [];
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback, private options?: IntersectionObserverInit) {}
  observe(el: Element) { observers.push({ el, cb: this.cb, options: this.options }); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}
function scrollIntoViewport(selector: string) {
  const watched = observers.filter((o) => o.el.matches(selector));
  expect(watched.length).toBeGreaterThan(0);
  act(() => {
    for (const o of watched) o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

const stops: Array<() => void> = [];
let phone = false;

beforeEach(async () => {
  surface.shopify = true;
  sent = [];
  observers.length = 0;
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/events')) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{"success":true}');
    }
    throw new Error('Synthetic test: no network');
  }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  // Enough for a plan with suggestions.
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function renderPlan() {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-results-panel .suggestion-title')).not.toBeNull());
  return view;
}

describe('US-62 AC4: tool_opened', () => {
  it.each([['phone', true], ['desktop', false]] as const)('sends once per tab with device %s', async (device, isPhone) => {
    phone = isPhone;
    const view = await renderPlan();
    expect(named('tool_opened')).toEqual([{ eventName: 'tool_opened', visitorId: expect.any(String), metadata: { device } }]);
    // A second mount in the same tab (a remount, a second block) sends nothing more.
    view.unmount();
    await renderPlan();
    expect(named('tool_opened')).toHaveLength(1);
  });
});

describe('US-62 AC5: results_viewed when the plan is on screen', () => {
  it('on a phone: not while Input is active, then once on switching to Plan', async () => {
    phone = true;
    const view = await renderPlan();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(named('results_viewed')).toHaveLength(0); // all three slides are mounted, the plan is not seen

    fireEvent.click(view.getByRole('tab', { name: 'Plan' }));
    await waitFor(() => expect(named('results_viewed')).toHaveLength(1));
    expect(named('results_viewed')[0].metadata).toBeUndefined(); // the name alone, as before

    fireEvent.click(view.getByRole('tab', { name: 'Input' }));
    fireEvent.click(view.getByRole('tab', { name: 'Plan' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(named('results_viewed')).toHaveLength(1); // once per tab
  });

  it('on desktop: not at mount, then once when the plan column enters the viewport', async () => {
    phone = false;
    await renderPlan();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(named('results_viewed')).toHaveLength(0);

    scrollIntoViewport('.health-tool-right');
    expect(named('results_viewed')).toHaveLength(1);
    expect(named('results_viewed')[0].metadata).toBeUndefined();

    scrollIntoViewport('.health-tool-right');
    expect(named('results_viewed')).toHaveLength(1);
  });

  it('with no suggestions, nothing is sent even with the plan on screen', async () => {
    phone = false;
    localStorage.clear(); sessionStorage.clear();
    await initRoadmapStore(new LocalStorageAdapter());
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.health-tool-right')).not.toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    // Only the preview plan shows: no real suggestions yet.
    expect(view.container.querySelector('.health-tool-right')?.textContent).toContain('Real suggestions appear once you fill in your details.');
    const column = observers.filter((o) => o.el.matches('.health-tool-right'));
    act(() => { for (const o of column) o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(named('results_viewed')).toHaveLength(0);
  });
});

describe('US-62: the Pages build sends no events', () => {
  it.each([['phone', true], ['desktop', false]] as const)('on %s, neither tool_opened nor results_viewed', async (_, isPhone) => {
    surface.shopify = false;
    phone = isPhone;
    const view = await renderPlan();
    if (isPhone) fireEvent.click(view.getByRole('tab', { name: 'Plan' }));
    else scrollIntoViewport('.health-tool-right');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent).toEqual([]);
  });
});
