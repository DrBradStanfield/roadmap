// @vitest-environment jsdom
/**
 * US-19 AC3 (A7): the feedback form's mode is one named state. A send that
 * ends after the form was closed shows no thank-you, and the thank-you's
 * 3 s close never fires once the form is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const sendFeedback = vi.fn();
vi.mock('../lib/server-api', () => ({ sendFeedback: (...args: unknown[]) => sendFeedback(...args) }));

import { FeedbackForm, feedbackTransition, type FeedbackEvent, type FeedbackMode } from './FeedbackForm';

beforeEach(() => {
  sendFeedback.mockReset();
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const deferred = () => {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
};
const fill = (utils: ReturnType<typeof render>) => {
  fireEvent.change(utils.getByPlaceholderText('your@email.com'), { target: { value: 'a@b.co' } });
  fireEvent.change(utils.getByPlaceholderText('Your feedback...'), { target: { value: 'Nice tool' } });
};
const THANKS = 'Thank you for your feedback!';

describe('US-19 AC3: a send that ends after the form closed changes nothing', () => {
  it('the transition table: each state x event names the state that follows', () => {
    const id = Symbol('this'), other = Symbol('other');
    const states: Record<string, FeedbackMode> = {
      closed: { kind: 'closed' }, open: { kind: 'open' }, sending: { kind: 'sending', sendId: id },
      failed: { kind: 'failed' }, sent: { kind: 'sent' },
    };
    const events: Record<string, FeedbackEvent> = {
      expand: { type: 'expand' }, close: { type: 'close' }, send: { type: 'send', sendId: id },
      sendFailed: { type: 'sendFailed', sendId: id }, sendOk: { type: 'sendOk', sendId: id },
      otherFailed: { type: 'sendFailed', sendId: other }, otherOk: { type: 'sendOk', sendId: other }, thanked: { type: 'thanked' },
    };
    // Rows are states, columns are events, in the orders above ('other*': another send's answer).
    const next: Record<string, string[]> = {
      closed: ['open', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed'],
      open: ['open', 'closed', 'sending', 'open', 'open', 'open', 'open', 'open'],
      sending: ['sending', 'closed', 'sending', 'failed', 'sent', 'sending', 'sending', 'sending'],
      failed: ['failed', 'closed', 'sending', 'failed', 'failed', 'failed', 'failed', 'failed'],
      sent: ['sent', 'sent', 'sent', 'sent', 'sent', 'sent', 'sent', 'closed'],
    };
    for (const [s, state] of Object.entries(states)) {
      Object.entries(events).forEach(([e, event], i) => expect([s, e, feedbackTransition(state, event)]).toEqual([s, e, states[next[s][i]]]));
    }
  });

  it('a send that succeeds after Cancel shows no thank-you and keeps the form closed', async () => {
    const answer = deferred();
    sendFeedback.mockReturnValue(answer.promise);
    const onClose = vi.fn();
    const utils = render(<FeedbackForm onClose={onClose} />);
    fireEvent.click(utils.getByRole('button', { name: 'Send feedback' }));
    fill(utils);
    fireEvent.click(utils.getByRole('button', { name: 'Send' }));
    expect(utils.getByRole('button', { name: 'Sending...' })).toBeTruthy();
    fireEvent.click(utils.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { answer.resolve(true); await answer.promise; });
    expect(utils.queryByText(THANKS)).toBeNull();
    expect(utils.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a cancelled send that ends later leaves a reopened draft, and its newer send, alone', async () => {
    const first = deferred();
    const second = deferred();
    sendFeedback.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const utils = render(<FeedbackForm />);
    fireEvent.click(utils.getByRole('button', { name: 'Send feedback' }));
    fill(utils);
    fireEvent.click(utils.getByRole('button', { name: 'Send' }));
    fireEvent.click(utils.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(utils.getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(utils.getByPlaceholderText('Your feedback...'), { target: { value: 'Second thought' } });
    fireEvent.click(utils.getByRole('button', { name: 'Send' }));
    await act(async () => { first.resolve(true); await first.promise; });
    expect(utils.queryByText(THANKS)).toBeNull();
    expect((utils.getByPlaceholderText('Your feedback...') as HTMLTextAreaElement).value).toBe('Second thought');
    expect(utils.getByRole('button', { name: 'Sending...' })).toBeTruthy();
    await act(async () => { second.resolve(false); await second.promise; });
    expect(utils.getByText('Failed to send. Please try again.')).toBeTruthy();
    expect((utils.getByPlaceholderText('Your feedback...') as HTMLTextAreaElement).value).toBe('Second thought');
  });

  it('the thank-you closes the form after 3 s and calls onClose once', async () => {
    vi.useFakeTimers();
    sendFeedback.mockResolvedValue(true);
    const onClose = vi.fn();
    const utils = render(<FeedbackForm initialExpanded onClose={onClose} />);
    fill(utils);
    await act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
    expect(utils.getByText(THANKS)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2999); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(utils.queryByText(THANKS)).toBeNull();
    expect(utils.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
  });

  it('a form unmounted during its thank-you never calls onClose later', async () => {
    vi.useFakeTimers();
    sendFeedback.mockResolvedValue(true);
    const onClose = vi.fn();
    const utils = render(<FeedbackForm initialExpanded onClose={onClose} />);
    fill(utils);
    await act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
    expect(utils.getByText(THANKS)).toBeTruthy();
    utils.unmount();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a failed send says so and lets the person send again', async () => {
    sendFeedback.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const utils = render(<FeedbackForm initialExpanded />);
    fill(utils);
    await act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
    expect(utils.getByText('Failed to send. Please try again.')).toBeTruthy();
    await act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
    expect(utils.getByText(THANKS)).toBeTruthy();
    expect(sendFeedback).toHaveBeenCalledTimes(2);
  });
});
