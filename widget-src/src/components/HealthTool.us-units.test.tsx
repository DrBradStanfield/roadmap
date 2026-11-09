// @vitest-environment jsdom
/**
 * US-05: on a first visit, with no saved unit preference, the widget detects
 * the unit system: US English in a US time zone shows US units. Issue #935:
 * since PR 932 pins tests to en-GB, only the chat context exercised this end
 * to end. This renders the real HealthTool on an empty record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, type RenderResult } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore } from '../lib/roadmap-data';

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

/** The browser's language and time zone, as detectUnitSystem reads them. */
function visitorIn(language: string, timeZone: string): void {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);
}

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** What the first-visit form shows: the page's unit pill, and the weight
 *  field's unit (an empty record shows only height and weight). */
async function unitsShown(view: RenderResult): Promise<{ pill: string | null; weight: string | null }> {
  return waitFor(() => {
    const pill = view.container.querySelector('.basic-info-units [data-unit-control="all"]');
    const weight = view.container.querySelector('label[for="weightKg"] button');
    expect(pill && weight).toBeTruthy();
    return { pill: pill!.getAttribute('aria-label'), weight: weight!.textContent };
  });
}

describe('US-05: a first visit with no saved preference shows the detected units (#935)', () => {
  it('US English in a US time zone shows US units: lbs and mg/dL', async () => {
    visitorIn('en-US', 'America/New_York');
    const view = render(<HealthTool />);
    expect(await unitsShown(view)).toEqual({ pill: 'Switch units. Current: US', weight: 'lbs' });
    expect(view.container.querySelector('.basic-info-units')!.textContent).toContain('mg/dL');
  });

  it('control: US English outside the US shows metric units: kg and mmol/L', async () => {
    visitorIn('en-US', 'Pacific/Auckland');
    const view = render(<HealthTool />);
    expect(await unitsShown(view)).toEqual({ pill: 'Switch units. Current: Metric', weight: 'kg' });
    expect(view.container.querySelector('.basic-info-units')!.textContent).toContain('mmol/L');
  });
});
