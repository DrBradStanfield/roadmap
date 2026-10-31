// @vitest-environment jsdom
/**
 * US-15 AC45: a turn the server refuses with 429 `rate_limited` (the IP's or
 * the machine's daily turn cap, or the guest-session limit) is shown to the
 * shopper as a sentence, never as the code. The real hook and the real
 * chat-api run; only fetch is stubbed. ChatSection and ChatEmbed share the
 * error line, so both are checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('../lib/server-api', async (original) => ({
  ...await original<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));

import { ChatSection } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';
import { CHAT_LIMIT_MESSAGE } from '../lib/chat-api';

const surfaces = [
  ['ChatSection', () => <ChatSection isLoggedIn={false} startExpanded />],
  ['ChatEmbed', () => <ChatEmbed isLoggedIn={false} />],
] as const;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'rate_limited' }), {
    status: 429, headers: { 'Content-Type': 'application/json' },
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe.each(surfaces)('US-15 AC45: a refused turn reads as a sentence — %s', (_name, element) => {
  it('a 429 rate_limited shows the chat limit sentence, not the code', async () => {
    const { container } = render(element());
    fireEvent.change(container.querySelector('textarea.chat-input')!, { target: { value: 'what is a good LDL' } });
    fireEvent.click(container.querySelector('.chat-send-btn')!);
    await waitFor(() => expect(container.querySelector('.chat-error')).not.toBeNull());
    const shown = container.querySelector('.chat-error')!.textContent;
    expect(shown).toBe('Chat limit reached. Please try again later.');
    expect(shown).toBe(CHAT_LIMIT_MESSAGE);
    expect(container.textContent).not.toContain('rate_limited');
  });
});
