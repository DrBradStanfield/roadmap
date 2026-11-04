// @vitest-environment jsdom
/**
 * US-15 AC46a: "+ New Chat" in the History list closes the list and shows the
 * new, empty chat with its input, as opening a saved thread does. The bubble
 * (ChatSection) left its History list open, so the new chat and its input
 * stayed hidden until the person pressed Back; the chat beside the plan
 * (ChatEmbed) already closed its drawer. The real useChatState and
 * ChatThreadList run; chat-api, chat-sync, server-api, observe-visibility
 * and FeedbackForm are stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import type { ChatMessage } from '../lib/chat-api';

const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });

vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: vi.fn(async () => ({ conversations: [{ id: 'A', title: 'Thread A', updatedAt: 'x', createdAt: 'x' }] })),
  loadConversation: vi.fn(async () => [turn('a1', 'user', 'A question'), turn('a2', 'assistant', 'A answer')]),
  sendMessage: vi.fn(() => new Promise(() => {})),
  deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));

import { ChatSection } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';

afterEach(cleanup);

describe('US-15 AC46a: + New Chat closes the History list (ChatSection, the bubble)', () => {
  async function openHistory() {
    const view = render(<ChatSection isLoggedIn={false} startExpanded />);
    await screen.findByText('A answer'); // the guest's latest thread opens by itself
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await screen.findByText('Thread A');
    return view;
  }

  it('+ New Chat shows the new empty chat and its input, not the list', async () => {
    const { container } = await openHistory();
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    expect(container.querySelector('.chat-thread-list')).toBeNull();
    expect(container.querySelector('textarea.chat-input')).not.toBeNull();
    expect(container.querySelector('.chat-empty')).not.toBeNull();
    expect(container.textContent).not.toContain('A answer');
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy();
  });

  it('control: opening a saved thread also closes the list', async () => {
    const { container } = await openHistory();
    await act(async () => { fireEvent.click(screen.getByText('Thread A')); });
    expect(container.querySelector('.chat-thread-list')).toBeNull();
    expect(container.querySelector('textarea.chat-input')).not.toBeNull();
  });
});

describe('US-15 AC46a: the chat beside the plan (ChatEmbed) does the same', () => {
  it('control: + New Chat closes the drawer and empties the chat', async () => {
    const { container } = render(<ChatEmbed isLoggedIn={false} />);
    await screen.findByText('A answer');
    fireEvent.click(screen.getByLabelText('Show conversations'));
    expect(container.querySelector('.chat-embed-drawer--open')).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    expect(container.querySelector('.chat-embed-drawer--open')).toBeNull();
    expect(container.querySelector('.chat-empty')).not.toBeNull();
  });
});
