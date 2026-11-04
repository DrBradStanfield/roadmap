// @vitest-environment jsdom
/**
 * US-15 AC26a: Enter sends the question, except while an input method is
 * composing. Japanese, Chinese and Korean typing commits each word with Enter;
 * Chrome and Firefox mark that keydown `isComposing`, and Safari fires it just
 * after the composition ends with keyCode 229. Neither may send the half-typed
 * question. Both chat composers (the bubble's ChatSection and the inline
 * ChatEmbed) run through the real useChatState; chat-api, chat-sync, server-api,
 * observe-visibility and FeedbackForm are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, fireEvent } from '@testing-library/react';

const sendMessage = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Promise(() => {})));

vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: vi.fn(async () => ({ conversations: [] })),
  loadConversation: vi.fn(async () => []),
  sendMessage,
  deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));

import { ChatSection } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';

const surfaces = [
  ['ChatSection', () => <ChatSection isLoggedIn={false} startExpanded />],
  ['ChatEmbed', () => <ChatEmbed isLoggedIn={false} />],
] as const;

beforeEach(() => { sendMessage.mockClear(); });

describe.each(surfaces)('US-15 AC26a: Enter and input-method composition (%s)', (_name, element) => {
  async function typeAndPress(key: Record<string, unknown>) {
    const { container } = render(element());
    const input = container.querySelector('textarea.chat-input')!;
    fireEvent.change(input, { target: { value: 'にほんご' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', ...key }); });
    return input as HTMLTextAreaElement;
  }

  it('control: a plain Enter sends the question', async () => {
    await typeAndPress({});
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe('にほんご');
  });

  it('Enter while composing (isComposing, Chrome and Firefox) does not send', async () => {
    const input = await typeAndPress({ isComposing: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(input.value).toBe('にほんご');
  });

  it('the Enter that ends a composition (keyCode 229, Safari) does not send', async () => {
    const input = await typeAndPress({ keyCode: 229 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(input.value).toBe('にほんご');
  });

  it('Shift+Enter does not send', async () => {
    await typeAndPress({ shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('another key does not send', async () => {
    await typeAndPress({ key: 'a' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
