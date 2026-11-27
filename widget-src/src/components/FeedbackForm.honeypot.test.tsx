// @vitest-environment jsdom
/**
 * US-19 AC2a: the feedback form sends what its hidden `website` field holds, so the server's
 * honeypot (AC2, `website` max 0) can refuse a form a bot filled in. The real sendFeedback runs;
 * fetch stands in for /api/feedback and answers as the route does.
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
    const body = JSON.parse(String(init?.body));
    posts.push({ url: String(url), body });
    const ok = body.website === '';
    return Response.json(ok ? { success: true } : { success: false, error: 'Invalid input' }, { status: ok ? 200 : 400 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderFilled(website?: string) {
  const utils = render(<FeedbackForm initialExpanded />);
  fireEvent.change(utils.getByPlaceholderText('your@email.com'), { target: { value: 'reader@example.test' } });
  fireEvent.change(utils.getByPlaceholderText('Your feedback...'), { target: { value: 'Synthetic message' } });
  const trap = utils.container.querySelector<HTMLInputElement>('input[name="website"]')!;
  if (website !== undefined) fireEvent.change(trap, { target: { value: website } });
  const send = () => act(async () => { fireEvent.click(utils.getByRole('button', { name: 'Send' })); });
  return { ...utils, send };
}

describe('US-19 AC2a: the hidden website field travels with the feedback', () => {
  it('a filled trap is posted as it is; the refusal shows the usual failure line and keeps the draft', async () => {
    const utils = renderFilled('http://filled.example');
    await utils.send();
    expect(posts).toEqual([{
      url: '/apps/health-tool-1/api/feedback',
      body: { email: 'reader@example.test', message: 'Synthetic message', website: 'http://filled.example' },
    }]);
    expect(utils.getByText('Failed to send. Please try again.')).toBeTruthy();
    expect(utils.queryByText('Thank you for your feedback!')).toBeNull();
    expect((utils.getByPlaceholderText('your@email.com') as HTMLInputElement).value).toBe('reader@example.test');
    expect((utils.getByPlaceholderText('Your feedback...') as HTMLTextAreaElement).value).toBe('Synthetic message');
    // While the field still holds a value, a second try is refused the same way.
    await utils.send();
    expect(posts.map((p) => p.body.website)).toEqual(['http://filled.example', 'http://filled.example']);
    expect(utils.getByText('Failed to send. Please try again.')).toBeTruthy();
  });

  it('a trap holding only a space is posted untrimmed and refused', async () => {
    const utils = renderFilled(' ');
    await utils.send();
    expect(posts.map((p) => p.body.website)).toEqual([' ']);
    expect(utils.getByText('Failed to send. Please try again.')).toBeTruthy();
  });

  it('the trap stays out of a person\'s way: no tab stop, no autocomplete, in a box hidden from screen readers', () => {
    const trap = render(<FeedbackForm initialExpanded />).container.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect([trap.type, trap.tabIndex, trap.getAttribute('autocomplete')]).toEqual(['text', -1, 'off']);
    expect(trap.parentElement!.getAttribute('aria-hidden')).toBe('true');
  });

  it('an empty trap posts website as an empty string and the person is thanked', async () => {
    const utils = renderFilled();
    await utils.send();
    expect(posts.map((p) => p.body)).toEqual([{ email: 'reader@example.test', message: 'Synthetic message', website: '' }]);
    expect(utils.getByText('Thank you for your feedback!')).toBeTruthy();
  });
});
