// @vitest-environment jsdom
/**
 * US-15 AC17d (lead C23): another tab's reply draws the dots here only under the chat it was asked in.
 * Before, a tab drew them under whatever chat it showed, so tab A sent, pressed New chat, and tab B
 * mirrored the new chat with the dots for the length of A's reply. Send stays locked in every tab (AC17c).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import type { ChatMessage } from '../lib/chat-api';
import type { SyncMessage } from '../lib/chat-sync';

/** One BroadcastChannel for every hook in a test: each tab hears the others. */
const channel = vi.hoisted(() => ({ handlers: new Map<string, (m: SyncMessage) => void>(), next: 0 }));
const send = vi.hoisted(() => ({ resolve: undefined as undefined | ((r: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  generateInstanceId: () => `tab-${++channel.next}`,
  postInputSync: vi.fn(),
  postSync: vi.fn((m: SyncMessage) => { channel.handlers.forEach((h) => h(m)); }),
  subscribeSync: (h: (m: SyncMessage) => void) => {
    const key = `h${channel.handlers.size}-${Math.random()}`;
    channel.handlers.set(key, h);
    return () => { channel.handlers.delete(key); };
  },
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

import { loadConversation } from '../lib/chat-api';
import { useChatState } from './useChatState';

type Hook = { result: { current: ReturnType<typeof useChatState> } };
const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const threadX = [turn('x1', 'user', 'X question'), turn('x2', 'assistant', 'X answer')];
const conversations = [{ id: 'X', title: 'Thread X' }];
const atX = { conversations, messages: threadX, activeConversationId: 'X' };
const atNew = { conversations, messages: [], activeConversationId: null };

async function sendIn(hook: Hook) {
  act(() => hook.result.current.actions.handleInputChange('And LDL?'));
  await act(async () => { void hook.result.current.actions.handleSend(); });
}
const dots = (hook: Hook) => hook.result.current.state.replying;
const locked = (hook: Hook) => hook.result.current.state.isLoading;
const hear = (payload: Record<string, unknown>) => act(() => channel.handlers.forEach((h) => h({
  instanceId: 'other-bundle-tab', type: 'state', ts: 0,
  payload: { conversations: [], activeConversationId: null, messages: [], isLoading: true, error: null, ...payload },
} as SyncMessage)));

beforeEach(() => { vi.mocked(loadConversation).mockReset(); channel.handlers.clear(); });
afterEach(() => { cleanup(); });

describe('US-15 AC17d: another tab\'s dots only under the chat that asked', () => {
  it('tab A asks in thread X; tab B shows a New chat and has no dots; tab B back on X has them', async () => {
    const tabA = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atX }));
    const tabB = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atX }));
    await sendIn(tabA);
    expect([dots(tabB), locked(tabB)]).toEqual([true, true]); // B shows X, the chat that asked
    act(() => { tabA.result.current.actions.startNewChat(); }); // B mirrors A's New chat
    expect(tabB.result.current.state.activeConversationId).toBeNull();
    expect([dots(tabB), locked(tabB)]).toEqual([false, true]); // the bug: the dots showed here
    vi.mocked(loadConversation).mockResolvedValueOnce(threadX);
    await act(async () => { await tabB.result.current.actions.selectConversation('X'); });
    expect(tabB.result.current.state.activeConversationId).toBe('X');
    expect([dots(tabB), locked(tabB)]).toEqual([true, true]);
  });

  it('tab A asks in a new chat that tab B mirrors: B has the dots; after A\'s New chat, B has none', async () => {
    const tabA = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    const tabB = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atX }));
    await sendIn(tabA); // B follows A to its new chat under a key of its own (new:1; A's is new:0)
    expect(tabB.result.current.state.activeConversationId).toBeNull();
    expect([dots(tabB), locked(tabB)]).toEqual([true, true]);
    act(() => { tabA.result.current.actions.startNewChat(); });
    expect([dots(tabB), locked(tabB)]).toEqual([false, true]);
  });

  it('tab B\'s own New chat, away from the new chat A asked in, has no dots', async () => {
    const tabA = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    const tabB = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await sendIn(tabA);
    act(() => { tabB.result.current.actions.startNewChat(); });
    expect(dots(tabA)).toBe(false); // A mirrored B's New chat: its own reply's chat is not on screen
    expect([dots(tabB), locked(tabB)]).toEqual([false, true]);
  });
});

describe('US-15 AC17d: a busy post with no asked chat (an older bundle) locks Send but draws no dots', () => {
  it('this bundle before C23: `sending` with no `asked`', () => {
    const tab = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    hear({ sending: true });
    expect([dots(tab), locked(tab)]).toEqual([false, true]);
  });

  it('an older bundle still: no `sending`, only `isLoading`', () => {
    const tab = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    hear({});
    expect([dots(tab), locked(tab)]).toEqual([false, true]);
  });

  it('control: the same post naming the chat shown here draws the dots', () => {
    const tab = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atX }));
    hear({ sending: true, activeConversationId: 'X', asked: 'thread:X', shown: 'thread:X' });
    expect([dots(tab), locked(tab)]).toEqual([true, true]);
  });
});
