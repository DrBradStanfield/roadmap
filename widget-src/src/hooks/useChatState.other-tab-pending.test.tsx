// @vitest-environment jsdom
/**
 * US-15 AC17a: another tab's reply in flight locks this tab's chat (the
 * pulsing dots, the input and Send disabled, AC17) only until that tab says
 * the reply ended, or for REMOTE_PENDING_MS at most. A sending tab closed
 * mid-reply never says it ended, and before this the lock lasted until reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, renderHook, cleanup } from '@testing-library/react';
import type { SyncMessage } from '../lib/chat-sync';

const sync = vi.hoisted(() => ({ handler: undefined as undefined | ((m: SyncMessage) => void) }));
const send = vi.hoisted(() => ({ resolve: undefined as undefined | ((r: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'this-tab',
  subscribeSync: (h: (m: SyncMessage) => void) => { sync.handler = h; return () => { sync.handler = undefined; }; },
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn(() => new Promise((resolve) => { send.resolve = resolve; })),
  listConversations: vi.fn(async () => ({ conversations: [] })),
  loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('../components/FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('../components/ChatKeyGate', () => ({ ChatKeyGate: () => null }));

import { useChatState, REMOTE_PENDING_MS } from './useChatState';
import { ChatEmbed } from '../components/ChatEmbed';

const question = { id: 'temp-1', role: 'user' as const, content: 'What about ApoB?', createdAt: 'x' };
function fromOtherTab(isLoading: boolean) {
  act(() => sync.handler!({
    instanceId: 'other-tab', type: 'state', ts: 0,
    payload: { conversations: [], activeConversationId: null, messages: [question], isLoading, error: null },
  }));
}

async function sendHere(hook: { result: { current: ReturnType<typeof useChatState> } }) {
  act(() => hook.result.current.actions.handleInputChange('And LDL?'));
  await act(async () => { void hook.result.current.actions.handleSend(); });
}
async function replyLandsHere() {
  await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'LDL too.' }, error: null }); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('US-15 AC17a — another tab\'s pending reply expires', () => {
  it('US-15 AC17a: is a few minutes, longer than a slow reply', () => {
    expect(REMOTE_PENDING_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(REMOTE_PENDING_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('US-15 AC17a: with no word from the sending tab, the wait ends after REMOTE_PENDING_MS', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true);
    expect(hook.result.current.state.isLoading).toBe(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS - 1); });
    expect(hook.result.current.state.isLoading).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(hook.result.current.state.messages).toEqual([question]);
  });

  it('US-15 AC17a: a later word from the sending tab starts the wait again', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS - 1000); });
    fromOtherTab(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS - 1000); });
    expect(hook.result.current.state.isLoading).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(hook.result.current.state.isLoading).toBe(false);
  });

  it('US-15 AC17a control: the reply ending in the other tab ends the wait at once, and no timer fires later', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true);
    fromOtherTab(false);
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('US-15 AC17a: a chat closed while waiting leaves no timer behind', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true);
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('US-15 AC17a: on the page, the dots go and the input works again', () => {
    const view = render(<ChatEmbed isLoggedIn />);
    fromOtherTab(true);
    const input = view.container.querySelector('textarea')!;
    expect(input.disabled).toBe(true);
    expect(view.container.querySelector('.chat-thinking-dots')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(input.disabled).toBe(false);
    expect(view.container.querySelector('.chat-thinking-dots')).toBeNull();
  });

  it('US-15 AC17a: a wait left over from the other tab does not end this tab\'s own later send', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    fromOtherTab(true); // the other tab sent too, then closed before its reply
    await replyLandsHere();
    expect(hook.result.current.state.isLoading).toBe(false);
    act(() => { vi.advanceTimersByTime(60_000); });
    await sendHere(hook);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(hook.result.current.state.isLoading).toBe(true);
    expect(hook.result.current.state.isLocalSender).toBe(true);
  });

  it('US-15 AC17a: the other tab sending during this tab\'s own send does not end it after REMOTE_PENDING_MS', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    fromOtherTab(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(hook.result.current.state.isLoading).toBe(true);
    await replyLandsHere();
    expect(hook.result.current.state.isLoading).toBe(false);
  });

  it('US-15 AC17a: after this tab\'s own reply lands, the other tab\'s wait still ends after REMOTE_PENDING_MS', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    await replyLandsHere();
    fromOtherTab(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(hook.result.current.state.isLoading).toBe(false);
  });
});
