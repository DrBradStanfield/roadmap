// @vitest-environment jsdom
/**
 * US-19 AC3a: the failure line is an alert; one status region, empty from the first render, gets the thank-you when
 * a send succeeds; the visible thank-you is a plain line that takes a focus left on the page. jsdom checks roles,
 * text and focus only; no screen reader runs. sendFeedback is mocked. Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const sendFeedback = vi.fn();
vi.mock('../lib/server-api', () => ({ sendFeedback: (...args: unknown[]) => sendFeedback(...args) }));

import { FeedbackForm } from './FeedbackForm';

beforeEach(() => {
  sendFeedback.mockReset();
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const FAILED = 'Failed to send. Please try again.';
const THANKS = 'Thank you for your feedback!';

/** Fills the open form with synthetic values and presses Send with the focus on it. */
async function send() {
  fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'test@example.com' } });
  fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'Synthetic message' } });
  const button = screen.getByRole('button', { name: 'Send' });
  button.focus();
  await act(async () => { fireEvent.click(button); });
}

/** The one status region, which must already be in the feedback section, live and empty but for a nbsp. */
function emptyRegion(): HTMLElement {
  const region = screen.getByRole('status');
  expect(region.closest('.feedback-section')).not.toBeNull();
  expect([region.textContent?.trim(), region.matches(':empty')]).toEqual(['', false]); // a nbsp: a theme may hide p:empty
  expect(region.getAttribute('aria-live') ?? 'polite').toBe('polite'); // role=status alone is polite; never aria-live="off"
  return region;
}

/** Live regions (status, alert, aria-live) whose text holds the thank-you. */
function liveRegionsWithThanks(): Element[] {
  return [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].filter(el => el.textContent?.includes(THANKS));
}

describe('US-19 AC3a: the outcome of a send has an alert or a status role', () => {
  it('a failed send shows its line as an alert, and leaves the status region empty', async () => {
    sendFeedback.mockResolvedValue(false);
    render(<FeedbackForm initialExpanded />);
    const region = emptyRegion();
    expect(screen.queryByRole('alert')).toBeNull();
    await send();
    expect(screen.getByRole('alert').textContent).toBe(FAILED);
    expect(emptyRegion()).toBe(region); // the same element, and the thank-you is not set on failure
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' })); // the focus is not moved
  });

  it('a retry that succeeds replaces the alert and sets the thank-you in the same status region', async () => {
    sendFeedback.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<FeedbackForm initialExpanded />);
    const region = emptyRegion();
    await send();
    expect(screen.getByRole('alert').textContent).toBe(FAILED);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe(THANKS);
  });

  it('the status region is there before the send, and the plain thank-you takes the focus from the page', async () => {
    sendFeedback.mockResolvedValue(true);
    render(<FeedbackForm />);
    const region = emptyRegion(); // the closed form, with its "Send feedback" link
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(emptyRegion()).toBe(region); // opening the form does not remount it
    await send();
    expect(screen.getByRole('status')).toBe(region);
    const thanks = document.activeElement as HTMLElement;
    expect(thanks.className).toBe('feedback-success');
    expect(thanks.textContent).toBe(THANKS);
    expect(thanks.closest('[role], [aria-live], [aria-hidden]')).toBeNull(); // plain, in no live region, and not hidden
    expect(thanks.tabIndex).toBe(-1);
    expect(liveRegionsWithThanks()).toEqual([region]); // one live region holds the text
  });

  it('a person who moved the focus elsewhere while the send ran keeps it there', async () => {
    let answer!: (ok: boolean) => void;
    sendFeedback.mockReturnValue(new Promise<boolean>((resolve) => { answer = resolve; }));
    render(<><button type="button">Elsewhere</button><FeedbackForm initialExpanded /></>);
    const region = emptyRegion();
    await send();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => { answer(true); });
    expect(liveRegionsWithThanks()).toEqual([region]);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('the thank-you takes the focus without scrolling the page', async () => {
    // A person who presses Send and scrolls away leaves the focus on the page; the thank-you must not pull them back.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    sendFeedback.mockResolvedValue(true);
    render(<FeedbackForm initialExpanded />);
    await send();
    const thanks = screen.getByText(THANKS, { selector: '.feedback-success' });
    expect(document.activeElement).toBe(thanks);
    const thanksCalls = focus.mock.contexts.flatMap((el, i) => (el === thanks ? [focus.mock.calls[i]] : []));
    expect(thanksCalls).toEqual([[{ preventScroll: true }]]);
  });

  it('the status region empties when the thank-you closes after 3 s, and stays mounted', async () => {
    vi.useFakeTimers();
    sendFeedback.mockResolvedValue(true);
    render(<FeedbackForm initialExpanded />);
    const region = emptyRegion();
    await send();
    expect(region.textContent).toBe(THANKS);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
    expect(emptyRegion()).toBe(region);
  });
});
