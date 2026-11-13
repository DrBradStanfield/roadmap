// @vitest-environment jsdom
/**
 * US-07 AC3, P7 (Brad 2026-11-10: "sure, glow. But we want to make sure that the
 * PDF save text field glows first"), walked as a new visitor lives it. The plan's
 * cards show only once the whole form opens (stage 4, US-62 AC25); while they are
 * hidden the glow learns nothing. On Shopify the email box pulses first: no card
 * glows until the email is given, then the cards glow and fade. On Pages (no box)
 * the cards glow as they first appear.
 *
 * The whole widget renders over a real RoadmapStore on localStorage. Only the
 * network is stubbed: the events POST and the email capture answer success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

const flags = vi.hoisted(() => ({ shopify: true }));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, get SHOPIFY_SURFACE() { return flags.shopify; } }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(), trackProductEvent: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
import { HealthTool } from './HealthTool';
import { trackLiveRefresh, stopLiveRefresh, useHealthToolLifecycle, wait } from '../testing/health-tool-harness';

let captures = 0;

// Fake timers that move with the clock: wait(ms) jumps the 3 s settle and the
// 3.5 s glow at once, with the same durations, so the rules stay pinned.
useHealthToolLifecycle({ fakeTimers: true });
beforeEach(async () => {
  flags.shopify = true;
  captures = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/measurements')) { captures++; return new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }); }
    if (String(url).endsWith('/api/events')) return new Response('{"success":true}');
    throw new Error('Synthetic test: no network');
  }));
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print: vi.fn(), focus: vi.fn() }) as unknown as Window);
  trackLiveRefresh();
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(() => { stopLiveRefresh(); });

const q = (view: RenderResult, sel: string) => view.container.querySelector(sel);
const cards = (view: RenderResult) => view.container.querySelectorAll('.suggestion-card').length;
const glowing = (view: RenderResult) => view.container.querySelectorAll('.suggestion-highlight:not(.suggestion-fade-out)').length;
const lit = (view: RenderResult) => view.container.querySelectorAll('.suggestion-highlight').length;
/** Each suggestion on screen that can glow (a card, a grouped card's section, a row's line) and is not glowing. */
const unlit = (view: RenderResult) => Array.from(view.container.querySelectorAll('.suggestion-card, .suggestion-subsection, .mh-row-suggestion'))
  .filter((el) => !(el.classList.contains('suggestion-card') && el.querySelector('.suggestion-subsection')))
  .filter((el) => !el.classList.contains('suggestion-highlight')).length;
function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input');
  act(() => { (input as HTMLElement).focus(); });
  fireEvent.change(input, { target: { value } });
  act(() => { (input as HTMLElement).blur(); });
}

/** A new visitor, past the 3 s settle, answers height, weight, sex and birth date. */
async function newVisitorWalk(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(q(view, '#heightCm')).toBeTruthy());
  await wait(3100); // the settle: a loaded plan (none here) is the baseline
  type(q(view, '#heightCm'), '178');
  type(q(view, '#weightKg'), '80');
  await waitFor(() => expect(view.queryByRole('radio', { name: 'Male' })).toBeTruthy());
  fireEvent.click(view.getByRole('radio', { name: 'Male' }));
  await waitFor(() => expect(q(view, '#birthMonth')).toBeTruthy());
  await wait(4000); // a person's pause: the stages' plans sit there, hidden, past any glow's 3.5 s
  expect(cards(view)).toBe(0);
  fireEvent.change(q(view, '#birthMonth')!, { target: { value: '5' } });
  type(q(view, '#birthYear'), '1975');
  await waitFor(() => expect(cards(view)).toBeGreaterThan(0));
  return view;
}

describe('US-07 AC3 (P7): a new visitor\'s first cards glow', () => {
  it('Shopify: no card glows while the email box pulses; once the email is given the cards glow, then fade', async () => {
    const view = await newVisitorWalk();
    expect(q(view, '.email-capture.field-attention')).not.toBeNull();
    expect(lit(view)).toBe(0);
    await wait(4000);
    expect(lit(view)).toBe(0);

    const email = q(view, '#guestEmail') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'reader@example.com' } });
    fireEvent.keyDown(email, { key: 'Enter' });
    await waitFor(() => expect(q(view, '#guestEmail')).toBeNull()); // captured: the box is gone
    expect(captures).toBe(1);
    await waitFor(() => expect(glowing(view)).toBeGreaterThan(0));
    expect(unlit(view)).toBe(0); // every suggestion is new to this visitor
    await wait(5000);
    expect(lit(view)).toBe(0); // glow, fade, still
  }, 20_000);

  it('Pages (no email box): the cards glow as they first appear', async () => {
    flags.shopify = false;
    const view = await newVisitorWalk();
    expect(q(view, '.email-capture')).toBeNull();
    await waitFor(() => expect(glowing(view)).toBeGreaterThan(0));
    expect(unlit(view)).toBe(0); // every suggestion is new to this visitor
    await wait(5000);
    expect(lit(view)).toBe(0);
  }, 20_000);

  it('Pages: a returning visitor whose record opens the whole form at mount sees no glow', async () => {
    flags.shopify = false;
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5 }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    const view = render(<HealthTool />);
    await waitFor(() => expect(cards(view)).toBeGreaterThan(0));
    for (let i = 0; i < 5; i++) { expect(lit(view)).toBe(0); await wait(1000); }
    expect(lit(view)).toBe(0);
  }, 20_000);
});
