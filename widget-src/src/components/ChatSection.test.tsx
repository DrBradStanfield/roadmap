// @vitest-environment jsdom
/**
 * US-15 AC2: opening the chat emits the `chat_opened` product event —
 * on EVERY entry path.
 *
 * Bug (product-health W32, 2026-08-10): the only emit site was handleExpand
 * (collapsed→expand click), but both live surfaces mount <ChatSection
 * startExpanded> (HealthTool desktop FAB + site-chat FAB), so chat_opened
 * had never fired once despite 158 chat messages in the same week.
 *
 * First component test in widget-src — mocks the data/hook seams so only
 * ChatSection's own mount/expand behavior is under test.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const trackProductEvent = vi.fn();
const loadConversationsIfNeeded = vi.fn();

vi.mock('../lib/api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
vi.mock('../lib/chat-api', () => ({ getChatGate: () => null }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatMessageBubble', () => ({ ChatMessageBubble: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));
vi.mock('./ChatHeaderTitle', () => ({ ChatHeaderTitle: () => null }));
vi.mock('../hooks/useChatState', () => ({
  THINKING_MESSAGES: ['Thinking…'],
  MAX_CHARS: 2000,
  useChatState: () => ({
    state: {
      conversations: [],
      activeConversationId: null,
      messages: [],
      inputText: '',
      isLoading: false,
      isLocalSender: false,
      error: null,
      thinkingIndex: 0,
      isOffline: false,
    },
    actions: {
      handleInputChange: vi.fn(),
      selectConversation: vi.fn(),
      startNewChat: vi.fn(),
      handleSend: vi.fn(),
      handleDelete: vi.fn(),
      loadConversationsIfNeeded,
    },
    refs: { inputRef: { current: null }, messagesContainerRef: { current: null } },
  }),
}));

import { ChatSection } from './ChatSection';

beforeEach(() => {
  trackProductEvent.mockClear();
  loadConversationsIfNeeded.mockClear();
});

describe('US-15 AC2 — chat_opened fires on every chat entry path', () => {
  it('emits chat_opened when mounted already expanded (the live FAB path)', () => {
    render(<ChatSection isLoggedIn startExpanded />);
    expect(trackProductEvent).toHaveBeenCalledWith('chat_opened');
    // and the existing lazy-load behavior is preserved
    expect(loadConversationsIfNeeded).toHaveBeenCalled();
  });

  it('emits chat_opened on collapsed→expand click (pre-existing path, no regression)', () => {
    const { container } = render(<ChatSection isLoggedIn />);
    expect(trackProductEvent).not.toHaveBeenCalled(); // not on collapsed mount
    fireEvent.click(container.querySelector('.chat-collapsed')!);
    expect(trackProductEvent).toHaveBeenCalledWith('chat_opened');
  });

  it('does NOT emit on a collapsed mount with no interaction', () => {
    render(<ChatSection isLoggedIn />);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });
});
