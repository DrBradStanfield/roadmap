// @vitest-environment jsdom
/**
 * PR 1359 adversary R7, Codex R3 (US-15 AC7a, N2): on the Pages build the chat
 * transport is byok-chat.ts. A thread whose turns cannot be read there (no
 * chat-history store, or a store that throws) is a failed read, never an empty
 * thread a send could go out from. Through the shared hook, with the real
 * byok-chat in chat-api's place, as the Pages build swaps it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';

const history = vi.hoisted(() => ({ store: null as null | { getMessages: (id: string) => unknown[]; listConversations: () => unknown[] } }));
vi.mock('../lib/chat-history-access', () => ({ getChatHistory: () => Promise.resolve(history.store) }));
vi.mock('../lib/chat-api', async () => vi.importActual('../lib/byok-chat'));
vi.mock('../lib/chat-sync', () => ({ generateInstanceId: () => 'tab-byok', postInputSync: vi.fn(), postSync: vi.fn(), subscribeSync: () => () => {} }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { useChatState } from './useChatState';

const atNew = { conversations: [{ id: 'A', title: 'Thread A' }], messages: [], activeConversationId: null };

beforeEach(() => { history.store = null; });
afterEach(() => { cleanup(); });

describe('Pages (byok-chat): a thread that cannot be read is failed, never empty', () => {
  it('no chat-history store: failed, Send locked', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    expect(hook.result.current.state).toMatchObject({ load: 'failed', isLoading: true, activeConversationId: 'A', messages: [] });
  });

  it('a store whose read throws: failed, Send locked', async () => {
    history.store = { getMessages: () => { throw new Error('file unreadable'); }, listConversations: () => [] };
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    expect(hook.result.current.state).toMatchObject({ load: 'failed', isLoading: true, messages: [] });
  });

  it('a store that reads: the thread\'s turns, Send unlocked', async () => {
    const turns = [{ id: 'a1', role: 'user', content: 'A question', createdAt: 'x' }];
    history.store = { getMessages: () => turns, listConversations: () => [] };
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    expect(hook.result.current.state).toMatchObject({ load: 'none', isLoading: false, messages: turns });
  });
});
