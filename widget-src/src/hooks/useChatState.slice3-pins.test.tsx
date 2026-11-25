// @vitest-environment jsdom
/**
 * Chat-turn reducer, slice 3 pins: the list read and the thread loads as the
 * caller sees them on main, before slice 3 deletes hasLoadedRef,
 * isLoadingConvsRef and loadGenRef (design §7 slice 3). Every pin cites US-15:
 * - AC7a: the newest opening wins (A, B, A fast shows A; a stale landing changes nothing).
 * - AC6a: a guest's first list read opens the latest thread (Decision Q7).
 * - N2: a failed read says so and offers Try again.
 * - 1311c R2 / 1311d R1: the list is read once, never re-read on a landing, and read again after an erase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, renderHook, cleanup, fireEvent, screen } from '@testing-library/react';
import type { ChatConversation, ChatMessage } from '../lib/chat-api';

const send = vi.hoisted(() => ({ resolve: undefined as undefined | ((r: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  generateInstanceId: () => 'tab', postInputSync: vi.fn(), postSync: vi.fn(), subscribeSync: () => () => {},
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn(() => new Promise((resolve) => { send.resolve = resolve; })),
  listConversations: vi.fn(), loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => 'erase-1' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, on: (v: boolean) => void) => { on(true); return () => {}; } }));
vi.mock('../components/ChatKeyGate', () => ({ ChatKeyGate: () => null }));

import { listConversations, loadConversation } from '../lib/chat-api';
import { useChatState } from './useChatState';
import { tellChats } from './chatStore';
import { ChatEmbed } from '../components/ChatEmbed';

type Hook = { result: { current: ReturnType<typeof useChatState> } };
type Read = ChatMessage[] | 'gone';
const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const threadA = [turn('a1', 'user', 'A question'), turn('a2', 'assistant', 'A answer')];
const threadB = [turn('b1', 'user', 'B question'), turn('b2', 'assistant', 'B answer')];
const conversations: ChatConversation[] = [
  { id: 'A', title: 'Thread A', updatedAt: 'x', createdAt: 'x' },
  { id: 'B', title: 'Thread B', updatedAt: 'x', createdAt: 'x' },
];
const atNew = { conversations, messages: [], activeConversationId: null };

function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Each call to loadConversation answers when the test says so. */
function heldReads() {
  const held: ReturnType<typeof later<Read>>[] = [];
  vi.mocked(loadConversation).mockImplementation(() => { const r = later<Read>(); held.push(r); return r.promise as never; });
  return held;
}
const shown = (hook: Hook) => hook.result.current.state.messages.map((m) => m.content);
const listReads = () => vi.mocked(listConversations).mock.calls.length;
const open = (hook: Hook, id: string) => act(() => { void hook.result.current.actions.selectConversation(id); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.mocked(listConversations).mockReset().mockResolvedValue({ conversations } as never);
  vi.mocked(loadConversation).mockReset();
});
afterEach(() => { cleanup(); });

describe('US-15: the list is read once, on first open', () => {
  it('three opens, one while the first read is out and one after it lands, read the list once', async () => {
    const first = later<{ conversations: ChatConversation[] }>();
    vi.mocked(listConversations).mockReturnValueOnce(first.promise as never);
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    await act(async () => { first.resolve({ conversations }); });
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(1);
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
  });

  it('a prefetched list is never read again', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(0);
    expect(loadConversation).not.toHaveBeenCalled();
    expect(hook.result.current.state.activeConversationId).toBeNull();
  });
});

describe('US-15 AC6a (Decision Q7): a guest\'s first list read opens the latest thread', () => {
  it('a guest sees the latest thread\'s turns once its read lands', async () => {
    vi.mocked(loadConversation).mockResolvedValueOnce(threadA);
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['A']);
    expect(hook.result.current.state).toMatchObject({ activeConversationId: 'A', load: 'none', isLoading: false });
    expect(shown(hook)).toEqual(['A question', 'A answer']);
  });

  it('a signed-in customer\'s list opens nothing', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(loadConversation).not.toHaveBeenCalled();
    expect(hook.result.current.state.activeConversationId).toBeNull();
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
  });

  it('a guest who opened B before the list landed keeps B: the latest thread is not opened over it', async () => {
    const list = later<{ conversations: ChatConversation[] }>();
    vi.mocked(listConversations).mockReturnValueOnce(list.promise as never);
    vi.mocked(loadConversation).mockResolvedValueOnce(threadB);
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    await act(async () => { await hook.result.current.actions.selectConversation('B'); });
    await act(async () => { list.resolve({ conversations }); });
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['B']);
    expect(hook.result.current.state.activeConversationId).toBe('B');
    expect(shown(hook)).toEqual(['B question', 'B answer']);
  });
});

describe('US-15 AC7a: the newest opening wins (1311d R2)', () => {
  it('A, B, A opened fast: A shows with its newest turns, whatever order the reads land in', async () => {
    const held = heldReads();
    const hook = renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    open(hook, 'A'); open(hook, 'B'); open(hook, 'A');
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['A', 'B', 'A']);
    await act(async () => { held[2].resolve(threadA); });
    await act(async () => { held[0].resolve([turn('old', 'user', 'A as it was')]); held[1].resolve(threadB); });
    await settle();
    expect(hook.result.current.state).toMatchObject({ activeConversationId: 'A', load: 'none', isLoading: false });
    expect(shown(hook)).toEqual(['A question', 'A answer']);
  });

  it('A, B, A opened fast, the first A read landing last: still the last A read\'s turns', async () => {
    const held = heldReads();
    const hook = renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    open(hook, 'A'); open(hook, 'B'); open(hook, 'A');
    await act(async () => { held[1].resolve(threadB); });
    expect(hook.result.current.state).toMatchObject({ activeConversationId: 'A', load: 'loading', messages: [] });
    await act(async () => { held[2].resolve(threadA); });
    await act(async () => { held[0].resolve([turn('old', 'user', 'A as it was')]); });
    expect(shown(hook)).toEqual(['A question', 'A answer']);
  });

  it('a thread\'s read landing after New chat changes nothing: the new chat stays empty and unlocked', async () => {
    const held = heldReads();
    const hook = renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    open(hook, 'B');
    act(() => hook.result.current.actions.startNewChat());
    await act(async () => { held[0].resolve(threadB); });
    expect(hook.result.current.state).toMatchObject({ activeConversationId: null, messages: [], load: 'none', isLoading: false });
  });

  it('a thread\'s read that lands with turns in the same tick as New chat changes nothing: the new chat stays empty', async () => {
    // The read resolves before New chat's dispatch stops it, so readThread returns the turns
    // and a load-landed for an opening the store has left reaches the reducer (chat-turn.ts loadLanded).
    const held = heldReads();
    const hook = renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    open(hook, 'B');
    await act(async () => { held[0].resolve(threadB); hook.result.current.actions.startNewChat(); });
    await settle();
    expect(hook.result.current.state).toMatchObject({ activeConversationId: null, messages: [], load: 'none', isLoading: false });
  });

  it('a left thread\'s failed read changes nothing: B shows, with no failure line', async () => {
    const held = heldReads();
    const hook = renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    open(hook, 'A'); open(hook, 'B');
    await act(async () => { held[1].resolve(threadB); });
    await act(async () => { held[0].reject(new Error('network down')); });
    expect(hook.result.current.state).toMatchObject({ activeConversationId: 'B', load: 'none', isLoading: false });
    expect(shown(hook)).toEqual(['B question', 'B answer']);
  });
});

describe('US-15 N2: a failed read says so and offers Try again', () => {
  it('"Couldn\'t open this conversation." with Try again, which reads the same thread once more', async () => {
    vi.mocked(loadConversation).mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(threadB);
    render(<ChatEmbed isLoggedIn />);
    await screen.findByText('Thread B');
    fireEvent.click(screen.getByLabelText('Show conversations'));
    await act(async () => { fireEvent.click(screen.getByText('Thread B')); });
    expect(await screen.findByText('Couldn\'t open this conversation.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(await screen.findByText('B answer')).toBeTruthy();
    expect(screen.queryByText('Couldn\'t open this conversation.')).toBeNull();
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['B', 'B']);
    expect(listReads()).toBe(1);
  });
});

describe('US-15: no landing reads the list again', () => {
  it('a thread\'s turns, a not-found thread and a reply landing leave the list read once', async () => {
    vi.mocked(loadConversation).mockResolvedValueOnce(threadA).mockResolvedValueOnce('gone');
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    await act(async () => { await hook.result.current.actions.selectConversation('B'); });
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A']); // B was not found
    act(() => hook.result.current.actions.handleInputChange('And LDL?'));
    act(() => { void hook.result.current.actions.handleSend(); });
    await act(async () => { send.resolve!({ result: { conversationId: 'N', messageId: 'm', content: 'LDL too.' }, error: null }); });
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['N', 'A']);
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(1);
  });
});

describe('US-15 AC64a (C26): a failed list read is read again on the next open', () => {
  it('a list read that lands null keeps the old list (here none); the next open reads again and shows the titles', async () => {
    vi.mocked(listConversations).mockResolvedValueOnce(null as never);
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(hook.result.current.state.conversations).toEqual([]);
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(2);
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(2); // read once it lands: never again on an open
  });

  it('an open while the failed read\'s retry is still out reads nothing more', async () => {
    const retry = later<{ conversations: ChatConversation[] }>();
    vi.mocked(listConversations).mockResolvedValueOnce(null as never).mockReturnValueOnce(retry.promise as never);
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(2);
    await act(async () => { retry.resolve({ conversations }); });
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
  });

  it('an erase shown after a failed read still reads again', async () => {
    vi.mocked(listConversations).mockResolvedValueOnce(null as never);
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    expect(listReads()).toBe(2);
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
  });
});

describe('US-15 (1311c R2): an erase the page shows reads the list again', () => {
  it('after an erase-shown the list is read again, its titles replace the old ones, and a guest\'s latest thread is not opened', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    vi.mocked(listConversations).mockResolvedValueOnce({ conversations: [{ id: 'C', title: 'After', updatedAt: 'x', createdAt: 'x' }] } as never);
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    expect(listReads()).toBe(1);
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['C']);
    expect(loadConversation).not.toHaveBeenCalled();
    expect(hook.result.current.state.activeConversationId).toBeNull();
  });

  it('a list read begun before the erase never brings its titles back', async () => {
    const before = later<{ conversations: ChatConversation[] }>();
    const after = later<{ conversations: ChatConversation[] }>();
    vi.mocked(listConversations).mockReturnValueOnce(before.promise as never).mockReturnValueOnce(after.promise as never);
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    act(() => { void hook.result.current.actions.loadConversationsIfNeeded(); });
    act(() => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    expect(listReads()).toBe(2);
    await act(async () => { before.resolve({ conversations }); });
    expect(hook.result.current.state.conversations).toEqual([]);
    await act(async () => { after.resolve({ conversations: [conversations[1]] }); });
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['B']);
  });

  it('an erase before Chat ever opened reads nothing; the first open then reads the list once', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: true }));
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    expect(listReads()).toBe(0);
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(listReads()).toBe(1);
    expect(hook.result.current.state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
  });

  it('the erase already shown reads nothing again; a new one reads once', async () => {
    renderHook(() => useChatState({ isLoggedIn: true, prefetchedData: atNew }));
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-1', by: 'own' }); });
    expect(listReads()).toBe(0);
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    await act(async () => { tellChats({ type: 'erase-shown', erase: 'erase-2', by: 'own' }); });
    expect(listReads()).toBe(1);
  });
});
