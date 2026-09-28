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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const trackProductEvent = vi.fn();
const loadConversationsIfNeeded = vi.fn();

vi.mock('../lib/server-api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
vi.mock('../lib/chat-api', () => ({ getChatGate: () => null }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatMessageBubble', () => ({ ChatMessageBubble: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));
vi.mock('../hooks/useChatState', () => ({
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
      streamingThinking: '',
      streamingText: '',
      thinkingById: {},
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
import { DEFAULT_ASSISTANT_NAME, setAssistantName, setChatSurface } from '../lib/assistant-config';

beforeEach(() => {
  setChatSurface('doctor');
  setAssistantName(DEFAULT_ASSISTANT_NAME);
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

// US-15 AC12: the brand store (microvitamin.com) has no plan and no roadmap
// page, so its chat names products; the doctor store keeps the plan wording.
describe('US-15 AC12 — chat copy follows the store surface', () => {
  it('doctor surface (default) keeps the plan wording', () => {
    const { container } = render(<ChatSection isLoggedIn startExpanded />);
    const expanded = container.textContent;
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Health by Dr Brad Chat');
    expect(expanded).toContain('Discuss your health');
    expect(expanded).toContain('Answers cite your plan & the guidelines above');
    expect(expanded).toContain('Ask about your personalized suggestions based on your health data, clinical research, and the preventative care algorithm.');
    expect(render(<ChatSection isLoggedIn />).container.textContent).toContain('Ask about your health suggestions');
  });

  it('brand surface names products, not a plan', () => {
    setChatSurface('brand');
    setAssistantName('MicroVitamin');
    const { container } = render(<ChatSection isLoggedIn startExpanded />);
    const expanded = container.textContent;
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('MicroVitamin chat');
    expect(expanded).toContain('Ask MicroVitamin');
    expect(expanded).toContain('Products, ingredients, and the research behind them');
    expect(expanded).toContain("Ask what's in a product, how to take it, or what the evidence says about an ingredient. For orders and subscriptions, sign in to your account.");
    expect(expanded).not.toMatch(/\bplan\b|Discuss your health/);
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe('Ask a follow-up…');
    expect(render(<ChatSection isLoggedIn />).container.textContent).toContain('Ask about our products');
  });
});
