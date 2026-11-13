// @vitest-environment jsdom
/**
 * Web redesign phase 1, as the person sees the whole widget:
 * US-09 AC30 — the storage button sits in the input column's header, where
 * "Supercharge this tool" was, on desktop; on a phone it sits in the Account
 * tab (US-62 AC34, HealthTool.tab-bar.test.tsx).
 * US-38 AC1 — "Supercharge this tool" is one card at the foot of the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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
import { trackLiveRefresh, stopLiveRefresh } from '../testing/health-tool-harness';

let phone = false;

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  trackLiveRefresh();
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  stopLiveRefresh();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each([['desktop', false], ['phone', true]] as const)('on %s', (_, isPhone) => {
  beforeEach(() => { phone = isPhone; });

  // US-62 AC16, AC24: My health's title line holds the storage and person buttons on desktop;
  // a phone's are in the Account tab (AC34, HealthTool.tab-bar.test.tsx).
  it.skipIf(isPhone)('US-09 AC30: the My health title line holds the storage and person buttons; no Supercharge there', async () => {
    const view = render(<HealthTool storageBar={<button type="button">Sign in</button>} />);
    const header = await waitFor(() => {
      const el = view.container.querySelector('.health-input-panel > .mh-header');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(header.querySelector('.mh-title')?.textContent).toBe('My health');
    const holder = header.querySelector('.mh-header-actions')!;
    expect(holder.querySelector('button')?.textContent).toBe('Sign in');
    expect(holder.querySelector('button[aria-label="Settings"]')).not.toBeNull();
    expect(view.container.querySelector('.hr-top-bar')).toBeNull();
    expect(view.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
    expect(header.textContent).not.toContain('Supercharge');
  });

  it('US-38 AC1: Supercharge is one card at the foot of My health, linking to the guide', async () => {
    const view = render(<HealthTool />);
    const card = await waitFor(() => {
      const links = [...view.container.querySelectorAll('a')].filter((a) => a.textContent?.includes('Supercharge this tool'));
      expect(links).toHaveLength(1);
      return links[0];
    });
    expect(card.closest('.mh-foot')).not.toBeNull();
    expect(card.textContent).toContain('Open source. Use your record with ChatGPT, Claude or the command line.');
    expect(card.getAttribute('href')).toBe(GUIDE_URL);
    // At the foot: after the disclaimer, before the privacy link.
    const foot = card.closest('.mh-foot')!;
    const order = (el: Element | null) => [...foot.querySelectorAll('*')].indexOf(el!);
    expect(order(card)).toBeGreaterThan(order(foot.querySelector('.health-disclaimer')));
    expect(order(card)).toBeLessThan(order(foot.querySelector('.privacy-notice-link')));
  });

  it('US-38 AC1: before a plan exists, the page still ends with the card', async () => {
    localStorage.clear();
    await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
    const view = render(<HealthTool />);
    const card = await waitFor(() => {
      const link = view.container.querySelector('.mh-foot .hr-guide-card');
      expect(link).not.toBeNull();
      return link!;
    });
    expect(view.container.querySelector('.plan-empty-preview')).not.toBeNull(); // no plan yet
    expect(card.textContent).toContain('Supercharge this tool');
    expect(card.getAttribute('href')).toBe(GUIDE_URL);
  });
});
