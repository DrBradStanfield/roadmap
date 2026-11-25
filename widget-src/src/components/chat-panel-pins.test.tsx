// @vitest-environment jsdom
/**
 * US-64 (untangle W1-7, pure move): DOM pins for the two web chat surfaces, the
 * inline panel (ChatEmbed) and the pop-up chat (ChatSection), in each main state.
 * Written before the shared message list and composer moved out of both, so the
 * move must leave every snapshot as it is. The hook's state is set by hand here;
 * the real hook's behaviour has its own tests (US-15).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ChatGate, ChatMessage } from '../lib/chat-api';
import type { SubscriptionCardState } from '../hooks/useChatState';

type FakeChat = {
  state: Record<string, unknown>;
  actions: Record<string, () => void>;
  refs: { inputRef: { current: HTMLTextAreaElement | null }; messagesContainerRef: { current: HTMLDivElement | null } };
};
const fake = vi.hoisted(() => ({ chat: null as FakeChat | null, gate: null as ChatGate | null }));

vi.mock('../hooks/useChatState', async (original) => ({
  ...await original<typeof import('../hooks/useChatState')>(),
  useChatState: () => fake.chat!,
}));
vi.mock('../lib/chat-api', async (original) => ({
  ...await original<typeof import('../lib/chat-api')>(),
  getChatGate: () => fake.gate,
}));
vi.mock('../lib/server-api', async (original) => ({
  ...await original<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('../lib/build-flags', async (original) => ({
  ...await original<typeof import('../lib/build-flags')>(),
  SHOPIFY_SURFACE: true,
}));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => <div className="feedback-form-stub" /> }));

import { ChatEmbed } from './ChatEmbed';
import { ChatSection } from './ChatSection';
import { CHAT_LIMIT_MESSAGE } from '../lib/chat-api';

const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const thread = [turn('m1', 'user', 'What is a good LDL?'), turn('m2', 'assistant', 'Under **1.8** mmol/L for most people at high risk.')];
const card: SubscriptionCardState = {
  phase: 'idle',
  card: { token: 'test-token-good', action: 'pause', product: 'Omega-3', every: '30 days', nextDate: '2026-12-01', newDate: null, reason: null, paused: false },
};
const NO_PENDING = { thinking: '', text: '', status: '', sources: [] as string[] };

function chat(over: Record<string, unknown> = {}): FakeChat {
  const noop = () => {};
  return {
    state: {
      conversations: [
        { id: 'c1', title: 'LDL targets', updatedAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-20T10:00:00Z' },
        { id: 'c2', title: 'Vitamin D', updatedAt: '2026-11-19T10:00:00Z', createdAt: '2026-11-19T10:00:00Z' },
      ],
      activeConversationId: 'c1', messages: [], inputText: '', isLoading: false, replying: false,
      isLocalSender: false, load: 'none', wait: null, error: null, pending: NO_PENDING,
      approachById: {}, cardsById: {}, isOffline: false, ...over,
    },
    actions: Object.fromEntries(['confirmSubscription', 'dismissSubscription', 'handleInputChange', 'selectConversation',
      'retryLoad', 'startNewChat', 'handleSend', 'handleDelete', 'loadConversationsIfNeeded'].map(k => [k, noop])),
    refs: { inputRef: { current: null }, messagesContainerRef: { current: null } },
  };
}

const keyGate = (needsKey: boolean): ChatGate => ({ needsKey, saveKey: () => null, clearKey: () => {} });

const states: [string, () => void][] = [
  ['empty', () => { fake.chat = chat(); }],
  ['a thread with an answer', () => { fake.chat = chat({ messages: thread, inputText: 'and HDL?', approachById: { m2: { thinking: 'Weighed the guideline', sources: ['LDL'] } } }); }],
  ['thinking (this tab asked)', () => { fake.chat = chat({ messages: thread.slice(0, 1), isLoading: true, replying: true, isLocalSender: true, pending: { thinking: 'Reading the guideline', text: '', status: 'Searching', sources: ['LDL'] } }); }],
  ['streaming the answer', () => { fake.chat = chat({ messages: thread.slice(0, 1), isLoading: true, replying: true, isLocalSender: true, pending: { thinking: '', text: 'Under 1.8', status: '', sources: [] } }); }],
  ['another tab is replying', () => { fake.chat = chat({ messages: thread.slice(0, 1), isLoading: true, replying: true, isLocalSender: false }); }],
  ['an error', () => { fake.chat = chat({ messages: thread.slice(0, 1), error: 'Something went wrong. Please try again.' }); }],
  ['the rate limit', () => { fake.chat = chat({ messages: thread.slice(0, 1), error: CHAT_LIMIT_MESSAGE }); }],
  ['a subscription change card', () => { fake.chat = chat({ messages: thread, cardsById: { m2: card } }); }],
  ['loading a conversation', () => { fake.chat = chat({ load: 'loading', isLoading: true }); }],
  ['a conversation that failed to load', () => { fake.chat = chat({ load: 'failed', wait: 'other-chat', isLoading: true }); }],
  ['offline', () => { fake.chat = chat({ isOffline: true }); }],
  ['the key gate (Pages)', () => { fake.chat = chat(); fake.gate = keyGate(true); }],
  ['a connected key (Pages)', () => { fake.chat = chat({ messages: thread }); fake.gate = keyGate(false); }],
];

/** React's useId values depend on render order and tree depth, not on what is drawn: name them by first use. */
function dom(fragment: DocumentFragment): DocumentFragment {
  const names = new Map<string, string>();
  for (const el of fragment.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const value = attr.value.replace(/:r[0-9a-z]+:/g, id => {
        if (!names.has(id)) names.set(id, `:id${names.size}:`);
        return names.get(id)!;
      });
      if (value !== attr.value) el.setAttribute(attr.name, value);
    }
  }
  return fragment;
}

beforeEach(() => { fake.gate = null; document.body.innerHTML = ''; });

describe('US-64 W1-7 pins: ChatEmbed DOM in each state', () => {
  it.each(states)('%s', (_name, set) => {
    set();
    const { asFragment } = render(<ChatEmbed isLoggedIn guestInputs={() => null} />);
    expect(dom(asFragment())).toMatchSnapshot();
  });
  it('muted (before the onboarding is done)', () => {
    fake.chat = chat();
    expect(dom(render(<ChatEmbed isLoggedIn={false} muted />).asFragment())).toMatchSnapshot();
  });
  it('history open', () => {
    fake.chat = chat({ messages: thread });
    const { asFragment, getByLabelText } = render(<ChatEmbed isLoggedIn />);
    fireEvent.click(getByLabelText('Show conversations'));
    expect(dom(asFragment())).toMatchSnapshot();
  });
});

describe.each([
  ['ChatEmbed', () => <ChatEmbed isLoggedIn />],
  ['ChatSection', () => <ChatSection isLoggedIn startExpanded />],
] as const)('US-64 W1-7 pins: %s wires the shared controls to the hook', (_name, element) => {
  it('typing, Send, Enter, the card, Try again, New Chat and Disconnect reach their actions', () => {
    const clearKey = vi.fn();
    fake.chat = chat({ messages: thread, cardsById: { m2: card }, inputText: 'and HDL?', load: 'failed' });
    fake.gate = { needsKey: false, saveKey: () => null, clearKey };
    const a = Object.fromEntries(Object.keys(fake.chat.actions).map(k => [k, vi.fn()]));
    fake.chat.actions = a;
    const { container, getByText, getByLabelText } = render(element());
    const box = container.querySelector('textarea.chat-input')!;
    fireEvent.change(box, { target: { value: 'and HDL? ok' } });
    expect(a.handleInputChange).toHaveBeenCalledWith('and HDL? ok');
    fireEvent.click(getByLabelText('Send'));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(a.handleSend).toHaveBeenCalledTimes(2);
    fireEvent.click(getByText('Confirm'));
    expect(a.confirmSubscription).toHaveBeenCalledWith('m2');
    fireEvent.click(getByText('Not now'));
    expect(a.dismissSubscription).toHaveBeenCalledWith('m2');
    fireEvent.click(getByText('Try again'));
    expect(a.retryLoad).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.chat-load-actions')!.lastElementChild!);
    expect(a.startNewChat).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText('Disconnect AI key'));
    expect(clearKey).toHaveBeenCalledTimes(1);
  });
});

describe('US-64 W1-7 pins: ChatSection DOM in each state', () => {
  it.each(states)('%s', (_name, set) => {
    set();
    const { asFragment } = render(<ChatSection isLoggedIn startExpanded />);
    expect(dom(asFragment())).toMatchSnapshot();
  });
  it('inline and muted', () => {
    fake.chat = chat();
    expect(dom(render(<ChatSection isLoggedIn={false} startExpanded inline muted />).asFragment())).toMatchSnapshot();
  });
  it('collapsed (guest, with feedback open)', () => {
    fake.chat = chat();
    const { asFragment, getByText } = render(<ChatSection isLoggedIn={false} />);
    fireEvent.click(getByText('Send feedback'));
    expect(dom(asFragment())).toMatchSnapshot();
  });
  it('history open', () => {
    fake.chat = chat({ messages: thread });
    const { asFragment, getByText } = render(<ChatSection isLoggedIn startExpanded />);
    fireEvent.click(getByText('History'));
    expect(dom(asFragment())).toMatchSnapshot();
  });
});
