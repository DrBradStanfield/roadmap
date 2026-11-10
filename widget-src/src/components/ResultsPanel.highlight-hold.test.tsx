// @vitest-environment jsdom
/**
 * US-07 AC3, P7 (Brad 2026-11-10): the PDF email box pulses first. While it
 * pulses (the gate box at formStage 4) no card glows; once the email is given
 * the cards new since it began pulsing glow, then fade. Without the box (Pages),
 * the first suggestions after an empty plan glow.
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

// Synthetic: a plan with no suggestions yet, then one with them.
const INPUTS: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1970, birthMonth: 1, weightKg: 80, ldlC: 4.9 };
const FULL = calculateHealthResults(INPUTS)!;
const EMPTY: HealthResults = { ...FULL, suggestions: [] };

const host = (results: HealthResults, box: boolean) => (
  <div className="health-tool"><PlanHost results={results} isValid showEmailCapture={box} formStage={4}/></div>
);
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const glowing = (c: HTMLElement) => c.querySelectorAll('.suggestion-highlight:not(.suggestion-fade-out)').length;
const fading = (c: HTMLElement) => c.querySelectorAll('.suggestion-fade-out').length;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.shopify.value = true;
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockResolvedValue({ success: true });
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print: vi.fn() }) as unknown as Window);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('US-07 AC3: no card glows while the email box pulses; once the email is given the new cards glow, then fade', async () => {
  expect(FULL.suggestions.length).toBeGreaterThan(0);
  const view = render(host(EMPTY, true));
  tick(3100); // settled, on an empty plan
  expect(view.container.querySelector('.email-capture.field-attention')).not.toBeNull();
  view.rerender(host(FULL, true));
  expect(view.container.querySelector('.suggestion-card')).not.toBeNull();
  expect(view.container.querySelector('.suggestion-highlight, .suggestion-fade-out')).toBeNull();
  tick(10_000);
  expect(view.container.querySelector('.suggestion-highlight, .suggestion-fade-out')).toBeNull();

  const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'a@example.com' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('#guestEmail')).toBeNull(); // captured: the box is gone
  expect(glowing(view.container)).toBeGreaterThan(0);
  tick(3000);
  expect(glowing(view.container)).toBe(0);
  expect(fading(view.container)).toBeGreaterThan(0);
  tick(500);
  expect(view.container.querySelector('.suggestion-highlight, .suggestion-fade-out')).toBeNull();
});

it('US-07 AC3: on Pages (no email box) the first suggestions after an empty plan glow', () => {
  mocks.shopify.value = false;
  const view = render(host(EMPTY, false));
  tick(3100);
  expect(view.container.querySelector('.email-capture')).toBeNull();
  view.rerender(host(FULL, false));
  expect(glowing(view.container)).toBeGreaterThan(0);
});
