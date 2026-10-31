// @vitest-environment jsdom
/**
 * Web redesign phase 1, as the person sees the whole widget:
 * US-09 AC30 — the storage button sits in the input column's header, where
 * "Supercharge this tool" was, on desktop and on a phone.
 * US-38 AC1 — "Supercharge this tool" is one card at the foot of the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { GUIDE_URL } from './GuideLink';

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
let phone = false;

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
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

describe.each([['desktop', false], ['phone', true]] as const)('on %s', (_, isPhone) => {
  beforeEach(() => { phone = isPhone; });

  it('US-09 AC30: the input header holds the storage button and keeps it on a phone; no Supercharge there', async () => {
    const view = render(<HealthTool storageBar={<button type="button">Sign in</button>} />);
    const header = await waitFor(() => {
      const el = view.container.querySelector('.health-input-panel > .hr-col-header');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(header.querySelector('.hr-col-meta')?.textContent).toBe('Sign in');
    expect(header.classList.contains('hr-col-header--actions')).toBe(true); // the 768px rule keeps it
    expect(view.container.querySelector('.health-input-panel')?.textContent).not.toContain('Supercharge');
  });

  it('US-38 AC1: Supercharge is one card at the foot of the plan, linking to the guide', async () => {
    const view = render(<HealthTool />);
    const card = await waitFor(() => {
      const links = [...view.container.querySelectorAll('a')].filter((a) => a.textContent?.includes('Supercharge this tool'));
      expect(links).toHaveLength(1);
      return links[0];
    });
    expect(card.closest('.health-results-panel')).not.toBeNull();
    expect(card.textContent).toContain('Open source. Use your record with ChatGPT, Claude or the command line.');
    expect(card.getAttribute('href')).toBe(GUIDE_URL);
    // At the foot: after the disclaimer, before the privacy link.
    const panel = card.closest('.health-results-panel')!;
    const order = (el: Element | null) => [...panel.querySelectorAll('*')].indexOf(el!);
    expect(order(card)).toBeGreaterThan(order(panel.querySelector('.health-disclaimer')));
    expect(order(card)).toBeLessThan(order(panel.querySelector('.privacy-notice-link')));
  });

  it('US-38 AC1: before a plan exists, the empty plan still ends with the card', async () => {
    localStorage.clear();
    await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
    const view = render(<HealthTool />);
    const card = await waitFor(() => {
      const link = view.container.querySelector('.health-results-panel .hr-guide-card');
      expect(link).not.toBeNull();
      return link!;
    });
    expect(view.container.querySelector('.plan-empty-preview')).not.toBeNull(); // the empty branch
    expect(card.textContent).toContain('Supercharge this tool');
    expect(card.getAttribute('href')).toBe(GUIDE_URL);
  });

  it('without a storage button (no picker host), the input header stays hidden on a phone', async () => {
    const view = render(<HealthTool />);
    await act(async () => {});
    const header = view.container.querySelector('.health-input-panel > .hr-col-header');
    expect(header?.classList.contains('hr-col-header--actions')).toBe(false);
  });
});
