// @vitest-environment jsdom
/**
 * US-15 AC16/AC17: the sending instance shows a live "Thinking…" panel with
 * the model's summary and the answer filling in; once the answer lands, the
 * summary folds into a "Show how I approached this" toggle above it. Other
 * tabs keep the pulsing dots. ChatSection and ChatEmbed share the pending
 * reply, so both are checked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ChatMessage } from '../lib/chat-api';
import { trackProductEvent } from '../lib/server-api';

vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/chat-api', () => ({ getChatGate: () => null }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));

const THINKING = 'Checking the ApoB guideline entry against the stated LDL.';
const hook = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../hooks/useChatState', () => ({
  MAX_CHARS: 500,
  useChatState: () => ({
    state: hook.state,
    actions: {
      handleInputChange: vi.fn(), selectConversation: vi.fn(), startNewChat: vi.fn(),
      handleSend: vi.fn(), handleDelete: vi.fn(), loadConversationsIfNeeded: vi.fn(),
    },
    refs: { inputRef: { current: null }, messagesContainerRef: { current: null } },
  }),
}));

import { ChatSection } from './ChatSection';
import { ChatEmbed } from './ChatEmbed';

const question: ChatMessage = { id: 'u1', role: 'user', content: 'What about ApoB?', createdAt: 't' };
const answer: ChatMessage = { id: 'a1', role: 'assistant', content: 'ApoB **counts** more.', createdAt: 't' };

function setState(patch: Record<string, unknown>) {
  hook.state = {
    conversations: [], activeConversationId: null, messages: [question], inputText: '',
    isLoading: false, isLocalSender: false, error: null, isOffline: false,
    streamingThinking: '', streamingText: '', thinkingById: {},
    ...patch,
  };
}

const surfaces = [
  ['ChatSection', () => render(<ChatSection isLoggedIn startExpanded />)],
  ['ChatEmbed', () => render(<ChatEmbed isLoggedIn />)],
] as const;

beforeEach(() => setState({}));

describe.each(surfaces)('US-15 AC16/AC17 — %s', (_name, mount) => {
  // The "draft notes" label promises notes, so it waits for the first one: a
  // path that never streams (BYOK, a buffering proxy) shows "Thinking…" only.
  it('before any delta: a plain Thinking… panel, a polite status line, and no canned lines', () => {
    setState({ isLoading: true, isLocalSender: true });
    const { container } = mount();
    const panel = container.querySelector('.chat-thinking-panel')!;
    expect(panel.textContent).toBe('Thinking…');
    expect(container.textContent).not.toContain('draft notes');
    expect(container.querySelector('.chat-thinking-text')).toBeNull();
    // Adversary R9: the live region is a short static line, never the growing panel.
    expect(container.querySelector('[aria-live]')!.textContent).toBe('Thinking…');
    expect(panel.closest('[aria-live]')).toBeNull();
    expect(panel.querySelector('[aria-live]')).toBeNull();
  });

  it('once a thinking delta arrives, the panel is labelled as draft notes', () => {
    setState({ isLoading: true, isLocalSender: true, streamingThinking: THINKING });
    const panel = mount().container.querySelector('.chat-thinking-panel')!;
    expect(panel.querySelector('.chat-thinking-label')!.textContent).toBe('Thinking (draft notes, not the answer)');
    expect(panel.textContent).toContain(THINKING);
  });

  it('once text streams, the status line says Answering…', () => {
    setState({ isLoading: true, isLocalSender: true, streamingThinking: THINKING, streamingText: 'ApoB' });
    const live = mount().container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe('Answering…');
  });

  it('streams the summary, then the answer through the markdown renderer', () => {
    setState({ isLoading: true, isLocalSender: true, streamingThinking: THINKING, streamingText: 'ApoB **counts**' });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-panel')!.textContent).toContain(THINKING);
    const bubbles = container.querySelectorAll('.chat-message--assistant .chat-message-content');
    expect(bubbles[bubbles.length - 1].innerHTML).toContain('<strong>counts</strong>');
  });

  it('once text arrives with no summary, the empty panel goes', () => {
    setState({ isLoading: true, isLocalSender: true, streamingText: 'ApoB' });
    expect(mount().container.querySelector('.chat-thinking-panel')).toBeNull();
  });

  it('another tab shows the pulsing dots only', () => {
    setState({ isLoading: true, isLocalSender: false, streamingThinking: THINKING });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-dots')).not.toBeNull();
    expect(container.querySelector('.chat-thinking-panel')).toBeNull();
    expect(container.textContent).not.toContain(THINKING);
  });

  it('after done: a collapsed "Show how I approached this" toggle above the answer', () => {
    setState({ messages: [question, answer], thinkingById: { a1: THINKING } });
    const { container } = mount();
    const toggle = container.querySelector('details.chat-thinking-toggle') as HTMLDetailsElement;
    expect(toggle.open).toBe(false);
    expect(toggle.querySelector('summary')!.textContent).toBe('Show how I approached this');
    const bubble = toggle.closest('.chat-message--assistant')!;
    expect(bubble.compareDocumentPosition(bubble.querySelector('.chat-message-content')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(bubble.querySelector('.chat-message-content')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle.querySelector('summary')!);
    expect(toggle.textContent).toContain(THINKING);
    expect(container.querySelector('.chat-thinking-panel')).toBeNull();
  });

  // Adversary R13: the usage signal, once per answer however often it is reopened.
  it('opening the toggle fires chat_thinking_opened once per answer', () => {
    vi.mocked(trackProductEvent).mockClear();
    setState({ messages: [question, answer], thinkingById: { a1: THINKING } });
    const toggle = mount().container.querySelector('details.chat-thinking-toggle') as HTMLDetailsElement;
    expect(trackProductEvent).not.toHaveBeenCalledWith('chat_thinking_opened');
    for (const open of [true, false, true]) {
      toggle.open = open;
      fireEvent(toggle, new Event('toggle'));
    }
    expect(vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'chat_thinking_opened')).toEqual([['chat_thinking_opened']]);
  });

  it('an answer without a summary has no toggle', () => {
    setState({ messages: [question, answer] });
    expect(mount().container.querySelector('.chat-thinking-toggle')).toBeNull();
  });
});
