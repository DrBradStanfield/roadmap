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
// Stable refs, as the real hook's useRef gives: a fresh ref per render would rerun every ref-keyed effect.
const hook = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  refs: { inputRef: { current: null }, messagesContainerRef: { current: null as HTMLElement | null } },
}));
vi.mock('../hooks/useChatState', async (original) => ({
  MAX_CHARS: (await original<typeof import('../hooks/useChatState')>()).MAX_CHARS,
  useChatState: () => ({
    state: hook.state,
    actions: {
      handleInputChange: vi.fn(), selectConversation: vi.fn(), startNewChat: vi.fn(),
      handleSend: vi.fn(), handleDelete: vi.fn(), loadConversationsIfNeeded: vi.fn(),
    },
    refs: hook.refs,
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
    pending: { thinking: '', text: '', status: '', sources: [] }, approachById: {},
    ...patch,
  };
}
/** The pending reply so far: `setState({ ...streaming({ thinking }) })`. */
const streaming = (p: Record<string, unknown>) => ({ pending: { thinking: '', text: '', status: '', sources: [], ...p } });

const surfaces = [
  ['ChatSection', () => <ChatSection isLoggedIn startExpanded />],
  ['ChatEmbed', () => <ChatEmbed isLoggedIn />],
] as const;

beforeEach(() => setState({}));

describe.each(surfaces)('US-15 AC16/AC17 — %s', (_name, element) => {
  const mount = () => render(element());
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
    setState({ isLoading: true, isLocalSender: true, ...streaming({ thinking: THINKING }) });
    const panel = mount().container.querySelector('.chat-thinking-panel')!;
    expect(panel.querySelector('.chat-thinking-label')!.textContent).toBe('Thinking (draft notes, not the answer)');
    expect(panel.textContent).toContain(THINKING);
  });

  it('once text streams, the status line says Answering…', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ thinking: THINKING, text: 'ApoB' }) });
    const live = mount().container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe('Answering…');
  });

  it('streams the summary, then the answer through the markdown renderer', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ thinking: THINKING, text: 'ApoB **counts**' }) });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-panel')!.textContent).toContain(THINKING);
    const bubbles = container.querySelectorAll('.chat-message--assistant .chat-message-content');
    expect(bubbles[bubbles.length - 1].innerHTML).toContain('<strong>counts</strong>');
  });

  it('once text arrives with no summary, the empty panel goes', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ text: 'ApoB' }) });
    expect(mount().container.querySelector('.chat-thinking-panel')).toBeNull();
  });

  it('another tab shows the pulsing dots only', () => {
    setState({ isLoading: true, isLocalSender: false, ...streaming({ thinking: THINKING }) });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-dots')).not.toBeNull();
    expect(container.querySelector('.chat-thinking-panel')).toBeNull();
    expect(container.textContent).not.toContain(THINKING);
  });

  it('after done: a collapsed "Show how I approached this" toggle above the answer', () => {
    setState({ messages: [question, answer], approachById: { a1: { thinking: THINKING, sources: [] } } });
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
    setState({ messages: [question, answer], approachById: { a1: { thinking: THINKING, sources: [] } } });
    const toggle = mount().container.querySelector('details.chat-thinking-toggle') as HTMLDetailsElement;
    expect(trackProductEvent).not.toHaveBeenCalledWith('chat_thinking_opened');
    for (const open of [true, false, true]) {
      toggle.open = open;
      fireEvent(toggle, new Event('toggle'));
    }
    expect(vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'chat_thinking_opened')).toEqual([['chat_thinking_opened']]);
  });

  // US-15 AC20/AC21: the server's progress lines fill the wait before the first delta.
  it('a status line labels the panel and the live region until thinking or text arrives', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ status: 'Finding relevant articles' }) });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-label')!.textContent).toBe('Finding relevant articles…');
    expect(container.querySelector('[aria-live]')!.textContent).toBe('Finding relevant articles…');
  });

  it('thinking replaces the status label; text turns the live region to Answering…', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ status: 'Writing the answer', thinking: THINKING }) });
    const first = mount();
    expect(first.container.querySelector('.chat-thinking-label')!.textContent).toBe('Thinking (draft notes, not the answer)');
    first.unmount();
    setState({ isLoading: true, isLocalSender: true, ...streaming({ status: 'Writing the answer', text: 'ApoB' }) });
    expect(mount().container.querySelector('[aria-live]')!.textContent).toBe('Answering…');
  });

  it('the articles read show under the label while pending, outside the live region', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ status: 'Writing the answer', sources: ['ApoB explained', 'Statins'] }) });
    const { container } = mount();
    const sources = container.querySelector('.chat-thinking-panel .chat-sources')!;
    expect(sources.textContent).toBe('Reading: ApoB explained · Statins');
    expect(sources.closest('[aria-live]')).toBeNull();
  });

  // US-15 AC21, Codex R3: with no summary the panel goes when text starts, and the line must not go with it.
  it('sources, then text, no thinking: the articles read stay above the streaming answer', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ status: 'Writing the answer', sources: ['ApoB explained', 'Statins'], text: 'ApoB' }) });
    const { container } = mount();
    expect(container.querySelector('.chat-thinking-panel')).toBeNull();
    const lines = container.querySelectorAll('.chat-sources');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('Reading: ApoB explained · Statins');
    expect(lines[0].closest('[aria-live]')).toBeNull();
    const bubble = container.querySelector('.chat-message--assistant .chat-message-content')!;
    expect(lines[0].compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Adversary R6: the "Reading:" line grows the panel with no thinking or text change; it must scroll too.
  it('a sources-only pending update scrolls a near-bottom panel to the new bottom', () => {
    const messages = [question];
    setState({ isLoading: true, isLocalSender: true, messages });
    const { rerender } = mount();
    const el = hook.refs.messagesContainerRef.current!;
    let top = 100, height = 500;
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    height = 560;
    setState({ isLoading: true, isLocalSender: true, messages, ...streaming({ sources: ['ApoB explained'] }) });
    rerender(element());
    expect(top).toBe(560);
  });

  it('sources and thinking while text streams: the line shows once, in the panel', () => {
    setState({ isLoading: true, isLocalSender: true, ...streaming({ sources: ['ApoB explained'], thinking: THINKING, text: 'ApoB' }) });
    const lines = mount().container.querySelectorAll('.chat-sources');
    expect(lines).toHaveLength(1);
    expect(lines[0].closest('.chat-thinking-panel')).not.toBeNull();
  });

  it('after done: the toggle opens for sources alone, listing them above any summary', () => {
    setState({ messages: [question, answer], approachById: { a1: { thinking: '', sources: ['ApoB explained'] } } });
    const first = mount();
    const toggle = first.container.querySelector('details.chat-thinking-toggle')!;
    expect(toggle.querySelector('.chat-sources')!.textContent).toBe('Articles read: ApoB explained');
    expect(toggle.querySelector('.chat-thinking-summary')).toBeNull();
    first.unmount();
    setState({ messages: [question, answer], approachById: { a1: { thinking: THINKING, sources: ['ApoB explained'] } } });
    const both = mount().container.querySelector('details.chat-thinking-toggle')!;
    expect(both.querySelector('.chat-sources')!.compareDocumentPosition(both.querySelector('.chat-thinking-summary')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an answer without a summary has no toggle', () => {
    setState({ messages: [question, answer] });
    expect(mount().container.querySelector('.chat-thinking-toggle')).toBeNull();
  });
});
