// @vitest-environment jsdom
/**
 * US-74 usage signal through the real transport (review R9): server-api's
 * trackProductEvent with its tab throttle and its Shopify gate, reading the
 * POSTs the server would get. `waist_widget_viewed` goes once per page view,
 * a second view in the same tab included; `waist_widget_saved` once per page
 * view, only once a waist and a usable height are kept, so a ratio exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { WaistToHeightWidget } from './WaistToHeight';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
/** The event names POSTed, in order. */
const posted = () => fetchMock.mock.calls
  .map((call) => (call as unknown as [string, RequestInit])[1]?.body)
  .filter((body): body is string => typeof body === 'string')
  .map((body) => JSON.parse(body) as { eventName: string; metadata?: unknown });
const named = (name: string) => posted().filter((e) => e.eventName === name);
const type = (label: RegExp, value: string) => fireEvent.input(screen.getByLabelText(label, { selector: 'input' }), { target: { value } }); // the label holds the unit pill too
/** Saves end with no word on the page (Brad 2026-11-18): wait for the store instead. */
const settled = async () => { await act(() => new Promise((r) => setTimeout(r, 100))); await act(() => data.flushRoadmapStore()); };
const enter = () => fireEvent.keyDown(screen.getByLabelText(/^Height/, { selector: 'input' }), { key: 'Enter' });

beforeEach(async () => {
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
  localStorage.setItem('health_roadmap_unit_system', 'si');
  await data.initRoadmapStore(new MemoryAdapter(new MemoryCloud()));
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await data.flushRoadmapStore();
  vi.unstubAllGlobals();
});

describe('US-74 usage signal, real transport (review R9)', () => {
  it('a second page view in the same tab is counted too', () => {
    render(<WaistToHeightWidget />);
    cleanup();
    render(<WaistToHeightWidget />);
    expect(named('waist_widget_viewed')).toEqual([{ eventName: 'waist_widget_viewed', visitorId: expect.any(String) }]
      .concat([{ eventName: 'waist_widget_viewed', visitorId: expect.any(String) }]));
  });

  it('a waist kept with no height is no ratio, so not counted; once the height is kept, it is, once', async () => {
    render(<WaistToHeightWidget />);
    type(/^Waist/, '90');
    fireEvent.focusIn(document.body);
    await settled();
    expect(named('waist_widget_saved')).toEqual([]);
    type(/^Height/, '178');
    enter();
    await settled();
    type(/^Waist/, '91');
    enter();
    await settled();
    expect(named('waist_widget_saved')).toEqual([{ eventName: 'waist_widget_saved', visitorId: expect.any(String) }]);
  });
});
