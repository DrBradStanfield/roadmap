// @vitest-environment jsdom
/**
 * US-19 AC2a (owner ruling, deletion-first): the feedback form has no hidden `website` field,
 * and a send posts the email and the message only (main posted `website: ''` too). The real sendFeedback runs; fetch stands in
 * for /api/feedback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { FeedbackForm } from './FeedbackForm';

const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  posts.length = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ success: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('US-19 AC2a: no hidden website field', () => {
  it('the open form holds only the email and message boxes, and nothing hidden from screen readers', () => {
    const { container } = render(<FeedbackForm initialExpanded />);
    expect(container.querySelector('input[name="website"]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    const fields = [...container.querySelectorAll('input, textarea')].map((el) => el.getAttribute('placeholder'));
    expect(fields).toEqual(['your@email.com', 'Your feedback...']);
  });

  it('a send posts the email and the message only, with no website key', async () => {
    const utils = render(<FeedbackForm initialExpanded />);
    fireEvent.change(utils.getByPlaceholderText('your@email.com'), { target: { value: 'reader@example.test' } });
    fireEvent.change(utils.getByPlaceholderText('Your feedback...'), { target: { value: 'Synthetic message' } });
    await act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
    expect(posts).toEqual([{
      url: '/apps/health-tool-1/api/feedback',
      body: { email: 'reader@example.test', message: 'Synthetic message' },
    }]);
    expect(Object.keys(posts[0].body)).not.toContain('website');
    expect(utils.getByText('Thank you for your feedback!', { selector: '.feedback-success' })).toBeTruthy();
  });
});
