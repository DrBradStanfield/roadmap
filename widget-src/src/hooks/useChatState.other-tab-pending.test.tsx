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
import { sendMessage } from '../lib/chat-api';
import { postSync } from '../lib/chat-sync';
import { Sentry } from '../lib/sentry';
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
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('../components/FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('../components/ChatKeyGate', () => ({ ChatKeyGate: () => null }));

import { useChatState } from './useChatState';
import { REMOTE_PENDING_MS } from './useChatBusy';
import { ChatEmbed } from '../components/ChatEmbed';

const question = { id: 'temp-1', role: 'user' as const, content: 'What about ApoB?', createdAt: 'x' };
/** A state message from another tab. With no `sending`, it is an older bundle's (US-15 AC17c). */
function fromOtherTab(isLoading: boolean, sending?: boolean, instanceId = 'other-tab') {
  act(() => sync.handler!({
    instanceId, type: 'state', ts: 0,
    payload: { conversations: [], activeConversationId: null, messages: [question], isLoading, error: null, ...(sending === undefined ? {} : { sending }) },
  }));
}

async function sendHere(hook: { result: { current: ReturnType<typeof useChatState> } }) {
  act(() => hook.result.current.actions.handleInputChange('And LDL?'));
  await act(async () => { void hook.result.current.actions.handleSend(); });
}
async function replyLandsHere() {
  await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'LDL too.' }, error: null }); });
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendMessage).mockClear(); vi.mocked(postSync).mockClear(); });
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

  it('US-15 AC17a, AC17c: a wait left over from the other tab does not end this tab\'s own later send', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    fromOtherTab(true); // the other tab sent too, then closed before its reply
    await replyLandsHere();
    // AC17c: the other tab's send is still counted until its wait ends.
    expect(hook.result.current.state.isLoading).toBe(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(hook.result.current.state.isLoading).toBe(false);
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

describe('US-15 AC17b: this tab\'s own send ends only with its own reply', () => {
  it('US-15 AC17b: another tab saying its reply ended does not unlock this tab\'s send, so no second send starts', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    expect(sendMessage).toHaveBeenCalledOnce();
    fromOtherTab(false); // the other tab's own send, started at the same moment, ended
    expect(hook.result.current.state.isLoading).toBe(true);
    await sendHere(hook);
    expect(sendMessage).toHaveBeenCalledOnce();
    await replyLandsHere();
    expect(hook.result.current.state.isLoading).toBe(false);
  });

  it('US-15 AC17b: a send that throws before the request frees the chat and puts the question back', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false, guestInputs: () => { throw new Error('synthetic context failure'); } }));
    await sendHere(hook);
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(hook.result.current.state.inputText).toBe('And LDL?');
    expect(hook.result.current.state.error).toBeTruthy();
    expect(hook.result.current.state.messages).toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat context read failed', { tags: { feature: 'chat' } });
  });
});

describe('US-15 AC17c: the chat is busy while any tab\'s send is in flight, each tracked on its own', () => {
  it('US-15 AC17c: this tab\'s reply landing first leaves the chat locked until the other tab\'s reply ends', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    fromOtherTab(true, true); // the other tab sent at the same moment
    await replyLandsHere();
    expect(hook.result.current.state.isLoading).toBe(true);
    expect(hook.result.current.state.isLocalSender).toBe(false);
    await sendHere(hook);
    expect(sendMessage).toHaveBeenCalledOnce();
    fromOtherTab(false, false);
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('US-15 AC17c: a tab that only mirrors a reply in flight (it opened a thread meanwhile) is not counted as sending', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true, false);
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('US-15 AC17c: with two other tabs sending, one ending leaves the chat locked for the other', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true, true, 'tab-a');
    fromOtherTab(true, true, 'tab-b');
    fromOtherTab(false, false, 'tab-a');
    expect(hook.result.current.state.isLoading).toBe(true);
    fromOtherTab(false, false, 'tab-b');
    expect(hook.result.current.state.isLoading).toBe(false);
  });

  it('US-15 AC17c: each tab\'s wait expires on its own clock', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    fromOtherTab(true, true, 'tab-a');
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS - 1000); });
    fromOtherTab(true, true, 'tab-b');
    act(() => { vi.advanceTimersByTime(1000); }); // tab-a's wait ends
    expect(hook.result.current.state.isLoading).toBe(true);
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS); });
    expect(hook.result.current.state.isLoading).toBe(false);
  });

  it('US-15 AC17c: two presses of Send before the re-render send once', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange('And LDL?'));
    const { handleSend } = hook.result.current.actions;
    await act(async () => { void handleSend(); void handleSend(); });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('US-15 AC17c: this tab says whether its own send is in flight, apart from what it shows', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    await replyLandsHere();
    const said = vi.mocked(postSync).mock.calls.map(([m]) => m.type === 'state' ? m.payload.sending : undefined);
    expect(said).toEqual([true, false]);
  });
});
