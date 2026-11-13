// @vitest-environment jsdom
/**
 * US-62 AC13: height and weight show the BMI tile, then the sex question. Split
 * from HealthTool.onboarding.test.tsx (test audit W03) when that file moved to the
 * harness's fake timers: this test must stay on real ones.
 *
 * The whole widget renders over a real RoadmapStore on localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { localDay } from '@roadmap/health-core/merge';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { initRoadmapStore } from '../lib/roadmap-data';
import { openAboutYou, trackLiveRefresh, stopLiveRefresh, recordOnDisk, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => <div className="floating-chat-panel"/> }));
import { HealthTool } from './HealthTool';

const localToday = () => localDay(new Date());
const WHY_SEX = 'Used to calculate ideal body weight, kidney function, and screening programs.';

// Real timers: no fakeTimers here.
useHealthToolLifecycle();
beforeEach(async () => {
  // Wide desktop, as in the onboarding file: the chat column shows.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/api/events')) return new Response('{"success":true}');
    throw new Error('Synthetic test: no network');
  }));
  trackLiveRefresh();
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(() => { stopLiveRefresh(); });

const activeWeights = async () => (await recordOnDisk()).measurements
  .filter((m) => m.metricType === 'weight' && m.status === 'active').map((m) => [m.value, m.recordedAt.slice(0, 10)]);
const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
const tiles = (view: RenderResult) => Array.from(view.container.querySelectorAll('.stat-card:not(.stat-card--awaiting) .stat-label')).map((l) => l.textContent);
const sexQuestion = (view: RenderResult) => view.queryByRole('radiogroup', { name: 'Sex' });
const fullForm = (view: RenderResult) => !!q(view, '.bt-timeline-title');
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
}
const leave = (input: Element | null) => act(() => { (input as HTMLElement).blur(); });

describe('US-62 AC13: each step reveals the next (real timers)', () => {
  // Real-timer pin (test audit W01): keep this test off fake timers; it is the one place the 500 ms field save must fire on its own.
  it('height and weight show the BMI tile with no sex, then ask sex with its why-text', async () => {
    const view = render(<HealthTool />);
    await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    openAboutYou(view.container);
    // Height and weight typed, the weight field left: its save runs 500 ms later.
    type(q(view, '#heightCm'), '178');
    leave(q(view, '#heightCm'));
    type(q(view, '#weightKg'), '80');
    leave(q(view, '#weightKg'));
    await waitFor(async () => expect(await activeWeights()).toEqual([[80, localToday()]]), { timeout: 2000 });
    await waitFor(() => expect(tiles(view)).toContain('BMI'));
    expect(tiles(view)).not.toContain('Ideal Body Weight');
    expect(tiles(view)).not.toContain('Protein Target');
    expect(sexQuestion(view)).toBeTruthy();
    expect(view.getByText(WHY_SEX)).toBeTruthy();
    expect(q(view, '#birthMonth')).toBeNull();
    expect(fullForm(view)).toBe(false);
    // Brad 2026-11-02: once a sex is chosen its why-line goes (About you's Sex row keeps it).
    fireEvent.click(view.getByRole('radio', { name: 'Female' }));
    expect(view.queryByText(WHY_SEX)).toBeNull();
  });
});
