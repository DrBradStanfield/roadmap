// @vitest-environment jsdom
/**
 * US-19 AC3a: the feedback form says how a send ended. The failure line is an alert (role="alert"), and the
 * thank-you is a status message (role="status") that takes the focus when the form it replaces leaves the focus
 * on the page itself, so a screen reader hears either outcome. sendFeedback is mocked. Synthetic values.
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
afterEach(() => cleanup());

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

describe('US-19 AC3a: the outcome of a send is announced', () => {
  it('a failed send shows its line as an alert, and the open form had none before', async () => {
    sendFeedback.mockResolvedValue(false);
    render(<FeedbackForm initialExpanded />);
    expect(screen.queryByRole('alert')).toBeNull();
    await send();
    expect(screen.getByRole('alert').textContent).toBe(FAILED);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' })); // the focus is not moved
  });

  it('a retry that succeeds replaces the alert with the thank-you', async () => {
    sendFeedback.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<FeedbackForm initialExpanded />);
    await send();
    expect(screen.getByRole('alert').textContent).toBe(FAILED);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(THANKS);
  });

  it('a sent message shows the thank-you as a status message, and the focus moves to it from the page', async () => {
    sendFeedback.mockResolvedValue(true);
    render(<FeedbackForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(screen.queryByRole('status')).toBeNull();
    await send();
    const thanks = screen.getByRole('status');
    expect(thanks.textContent).toBe(THANKS);
    expect(document.activeElement).toBe(thanks);
    expect(thanks.tabIndex).toBe(-1); // focusable from script, never a tab stop
  });

  it('a person who moved the focus elsewhere while the send ran keeps it there', async () => {
    let answer!: (ok: boolean) => void;
    sendFeedback.mockReturnValue(new Promise<boolean>((resolve) => { answer = resolve; }));
    render(<><button type="button">Elsewhere</button><FeedbackForm initialExpanded /></>);
    await send();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => { answer(true); });
    expect(screen.getByRole('status').textContent).toBe(THANKS);
    expect(document.activeElement).toBe(elsewhere);
  });
});
