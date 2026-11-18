// @vitest-environment jsdom
/**
 * US-15 AC17e: the chat's error line is an alert (role="alert"). It carries a refused turn, a failed send and the paste-cut
 * notice, and it was a plain line, so nothing marked the line for a screen reader when the turn ended in an
 * error after "Thinking…". The real hook and the real chat-api run. fetch is stubbed. Mocked: chat-sync,
 * chat-history-access, observe-visibility, trackProductEvent, Sentry, FeedbackForm, ChatKeyGate and ChatThreadList.
 * ChatSection and ChatEmbed each draw the line, so both are checked. Synthetic questions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null), askChatHistory: () => Promise.resolve({ store: null }) }));
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
import { MAX_CHARS } from '../hooks/useChatState';

const surfaces = [
  ['ChatSection', () => <ChatSection isLoggedIn={false} startExpanded />],
  ['ChatEmbed', () => <ChatEmbed isLoggedIn={false} />],
] as const;

const refused = () => new Response(JSON.stringify({ success: false, error: 'rate_limited' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
const box = () => document.querySelector<HTMLTextAreaElement>('textarea.chat-input')!;
const ask = (question: string) => {
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};
/** The one alert on the page, which must be the error line itself. */
const errorAlert = async () => {
  const alert = await screen.findByRole('alert');
  expect(alert.className).toBe('chat-error');
  return alert.textContent;
};

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.each(surfaces)('US-15 AC17e: the chat error line is an alert (%s)', (_name, element) => {
  it('a refused turn is an alert with the chat limit sentence; before the send there is no alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    render(element());
    expect(screen.queryByRole('alert')).toBeNull();
    ask('a synthetic question');
    expect(await errorAlert()).toBe(CHAT_LIMIT_MESSAGE);
  });

  it('a send that fails on the network is an alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('synthetic network failure'); }));
    render(element());
    ask('a synthetic question');
    expect(await errorAlert()).toBe('Network error');
  });

  it('the paste-cut notice is an alert, and an edit within the limit takes it away', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    render(element());
    fireEvent.change(box(), { target: { value: 'x'.repeat(MAX_CHARS + 1) } });
    expect(await errorAlert()).toBe('Your message was cut at 8,000 characters.');
    fireEvent.change(box(), { target: { value: 'a short synthetic question' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('with the tab channel mocked, the next send takes the alert away and a second refusal draws it again', async () => {
    let answer!: (r: Response) => void;
    const fetchStub = vi.fn<() => Promise<Response>>(async () => refused());
    vi.stubGlobal('fetch', fetchStub);
    render(element());
    ask('a synthetic question');
    expect(await errorAlert()).toBe(CHAT_LIMIT_MESSAGE);
    fetchStub.mockImplementation(() => new Promise<Response>(resolve => { answer = resolve; }));
    ask('a second synthetic question');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(screen.queryByRole('alert')).toBeNull();
    answer(refused());
    expect(await errorAlert()).toBe(CHAT_LIMIT_MESSAGE);
  });
});
