// @vitest-environment jsdom
/**
 * US-07 AC3, P7 (Brad 2026-11-10): the PDF email box pulses first. While the
 * cards are hidden (the onboarding, `cardsShown` false) the glow learns nothing.
 * While the box pulses (the gate box at formStage 4) no card glows; once the
 * email is given the cards new to the person glow, then fade. Without the box
 * (Pages), the cards glow when they first show.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import type { HealthInputs, HealthResults } from '@roadmap/health-core/types';

const mocks = vi.hoisted(() => ({
  sendGuestReport: vi.fn(),
  getReportHtml: vi.fn(),
  markReportEmailCaptured: vi.fn(),
  shopify: { value: true },
}));
vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: mocks.getReportHtml, sendGuestReport: mocks.sendGuestReport,
  getReportEmailCaptured: () => false, markReportEmailCaptured: mocks.markReportEmailCaptured,
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ get SHOPIFY_SURFACE() { return mocks.shopify.value; } }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => false }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { PlanHost } from '../testing/plan-host';

// Synthetic: a new visitor opens on no plan; the stages build one while the
// cards are hidden (the onboarding); the whole form shows it at stage 4.
const INPUTS: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1970, birthMonth: 1, weightKg: 80, ldlC: 4.9 };
const FULL = calculateHealthResults(INPUTS)!;
const EMPTY: HealthResults = { ...FULL, suggestions: [] };

const host = (results: HealthResults, box: boolean, cardsShown: boolean) => (
  <div className="health-tool"><PlanHost results={results} isValid showEmailCapture={box} formStage={cardsShown ? 4 : 3} cardsShown={cardsShown}/></div>
);
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const glowing = (c: HTMLElement) => c.querySelectorAll('.suggestion-highlight:not(.suggestion-fade-out)').length;
const fading = (c: HTMLElement) => c.querySelectorAll('.suggestion-fade-out').length;
const lit = (c: HTMLElement) => c.querySelector('.suggestion-highlight, .suggestion-fade-out');
/** Each suggestion that can glow (a card, or a grouped card's section) and is not glowing. */
const unlit = (c: HTMLElement) => Array.from(c.querySelectorAll('.suggestion-card, .suggestion-subsection'))
  .filter(el => !(el.classList.contains('suggestion-card') && el.querySelector('.suggestion-subsection')))
  .filter(el => !el.classList.contains('suggestion-highlight')).length;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.shopify.value = true;
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockClear().mockResolvedValue({ success: true });
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print: vi.fn() }) as unknown as Window);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Mount on no plan, settle, then the plan arrives while the cards are hidden and sits there. */
function onboarding(box: boolean) {
  const view = render(host(EMPTY, box, false));
  tick(3100); // settled, on an empty plan
  view.rerender(host(FULL, box, false));
  tick(10_000); // longer than any glow: a glow the hidden cards ran would be over
  return view;
}

it('US-07 AC3: hidden cards teach the glow nothing; while the email box pulses no card glows; once the email is given every card glows, then fades', async () => {
  expect(FULL.suggestions.length).toBeGreaterThan(0);
  const view = onboarding(true);
  view.rerender(host(FULL, true, true)); // the whole form opens
  expect(view.container.querySelector('.email-capture.field-attention')).not.toBeNull();
  expect(lit(view.container)).toBeNull();
  tick(10_000);
  expect(lit(view.container)).toBeNull();

  const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'a@example.com' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('#guestEmail')).toBeNull(); // captured: the box is gone
  expect(glowing(view.container)).toBeGreaterThan(0);
  expect(unlit(view.container)).toBe(0); // every card is new to this visitor
  tick(3000);
  expect(glowing(view.container)).toBe(0);
  expect(fading(view.container)).toBeGreaterThan(0);
  tick(500);
  expect(lit(view.container)).toBeNull();
});

it('US-07 AC3: a known minor\'s settled plan, the birth year corrected to an adult\'s: the gate pulses, nothing glows; once the email is given, the suggestions new since the minor\'s plan glow', async () => {
  const MINOR = calculateHealthResults({ ...INPUTS, birthYear: new Date().getFullYear() - 12 })!;
  expect(MINOR.knownMinor).toBe(true);
  const minorIds = new Set(MINOR.suggestions.map(s => s.id));
  const fresh = FULL.suggestions.filter(s => !minorIds.has(s.id));
  expect(fresh.length).toBeGreaterThan(0);
  const view = render(host(MINOR, true, true));
  tick(3100); // settled on the minor's plan; a minor sees no email box
  expect(view.container.querySelector('#guestEmail')).toBeNull();
  view.rerender(host(FULL, true, true)); // the adult plan and the pulsing gate in one commit
  expect(view.container.querySelector('.email-capture.field-attention')).not.toBeNull();
  expect(lit(view.container)).toBeNull();
  tick(10_000);
  expect(lit(view.container)).toBeNull();

  const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'a@example.com' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
  expect(glowing(view.container)).toBeGreaterThan(0);
});

it('US-07 AC3: on Pages (no email box) every card glows when the cards first show', () => {
  mocks.shopify.value = false;
  const view = onboarding(false);
  expect(view.container.querySelector('.email-capture')).toBeNull();
  view.rerender(host(FULL, false, true));
  expect(glowing(view.container)).toBeGreaterThan(0);
  expect(unlit(view.container)).toBe(0);
});
