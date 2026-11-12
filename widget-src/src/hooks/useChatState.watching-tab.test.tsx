// @vitest-environment jsdom
/**
 * US-15 AC7a: a tab that did not send (tab C) and opens another thread while
 * tab A's reply is in flight tells the other tabs what it last heard: still in
 * flight, or over. Review 2026-11-02 (review2 probe): C's broadcast read the
 * in-flight state only after React re-rendered, so a load landing just after
 * A's "reply ended" message said "in flight" and locked every tab.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import type { SyncMessage } from '../lib/chat-sync';

const sync = vi.hoisted(() => ({ handler: undefined as undefined | ((m: SyncMessage) => void) }));
const postSync = vi.hoisted(() => vi.fn());
vi.mock('../lib/chat-sync', () => ({
  postSync, postInputSync: vi.fn(), generateInstanceId: () => 'tab-c',
  subscribeSync: (h: (m: SyncMessage) => void) => { sync.handler = h; return () => { sync.handler = undefined; }; },
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn(() => new Promise(() => {})),
  listConversations: vi.fn(async () => ({ conversations: [] })),
  loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));

import { useChatState } from './useChatState';
import { REMOTE_PENDING_MS } from './useChatBusy';

const conversations = [
  { id: 'A', title: 'A', updatedAt: 'x', createdAt: 'x' },
  { id: 'B', title: 'B', updatedAt: 'x', createdAt: 'x' },
];
const threadA = [{ id: 'a1', role: 'user' as const, content: 'A question', createdAt: 'x' }];
const threadB = [{ id: 'b1', role: 'user' as const, content: 'B question', createdAt: 'x' }];
const remote = (isLoading: boolean) => ({
  instanceId: 'tab-a', type: 'state' as const, ts: 0,
  payload: { conversations, activeConversationId: 'A', messages: threadA, isLoading, error: null },
});

/** Tab C, showing A, hears that tab A's reply is in flight, then starts opening B (its load is held). */
async function tabCOpensBWhileAIsInFlight() {
  const api = await import('../lib/chat-api');
  let finishB!: (m: typeof threadB) => void;
  vi.mocked(api.loadConversation).mockImplementationOnce(() => new Promise(r => { finishB = r; }));
  const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: { conversations, messages: threadA, activeConversationId: 'A' } }));
  act(() => sync.handler!(remote(true)));
  let openingB!: Promise<void>;
  act(() => { openingB = hook.result.current.actions.selectConversation('B'); });
  return { hook, finishB, openingB };
}

afterEach(() => { cleanup(); postSync.mockClear(); vi.useRealTimers(); });

describe('US-15 AC7a — a tab that did not send opens another thread', () => {
  // Flipped in slice 2 (N4, Fable 2026-11-12): a tab says only whether its own request is open. Saying
  // another tab's send, or its own thread load, as busy locked Send in every tab that heard it.
  it('US-15 AC7a, N4: tab C opening B while tab A\'s reply is in flight says only that C has no request open', async () => {
    const { finishB, openingB } = await tabCOpensBWhileAIsInFlight();
    await act(async () => { finishB(threadB); await openingB; });
    expect(postSync.mock.calls.at(-1)![0].payload).toMatchObject({ activeConversationId: 'B', isLoading: false, sending: false });
  });

  // Tab A's "reply ended" says A is shown, and every tab follows the latest state, so it
  // switches C back to A before C's load of B lands. That load is then stale: C drops it and
  // broadcasts nothing, so no tab hears "in flight". This pinned an older order: the mirrored
  // switch reached the ref the load checks only after the next render, so the load of B
  // still landed and C broadcast B over a screen whose chat was A (US-67 AC2, one writer).
  it('US-15 AC7a: tab C\'s load of B landing just after tab A said the reply ended: C follows A, and broadcasts no stale "in flight"', async () => {
    const { hook, finishB, openingB } = await tabCOpensBWhileAIsInFlight();
    await act(async () => {
      sync.handler!(remote(false));
      finishB(threadB);
      await openingB;
    });
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(hook.result.current.state.activeConversationId).toBe('A');
    expect(hook.result.current.state.messages).toEqual(threadA);
    expect(postSync.mock.calls.filter(([m]) => m.type === 'state' && m.payload.isLoading)).toEqual([]);
  });

  it('US-15 AC7a: tab C\'s load of B landing just after the in-flight wait expired (AC17a) tells other tabs it is over', async () => {
    vi.useFakeTimers();
    const api = await import('../lib/chat-api');
    let finishB!: (m: typeof threadB) => void;
    vi.mocked(api.loadConversation).mockImplementationOnce(() => new Promise(r => { finishB = r; }));
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: { conversations, messages: threadA, activeConversationId: 'A' } }));
    act(() => sync.handler!(remote(true)));
    // B opens 10 s before the wait expires, so its load lands inside its own 20 s limit (N1).
    act(() => { vi.advanceTimersByTime(REMOTE_PENDING_MS - 10_000); });
    let openingB!: Promise<void>;
    act(() => { openingB = hook.result.current.actions.selectConversation('B'); });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      finishB(threadB);
      await openingB;
    });
    expect(hook.result.current.state.isLoading).toBe(false);
    expect(postSync.mock.calls.at(-1)![0].payload).toMatchObject({ activeConversationId: 'B', isLoading: false });
  });
});
