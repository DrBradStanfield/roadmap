// @vitest-environment jsdom
/**
 * PINS US-15 AC3's client re-serve across tabs (AC17c carries the mirror). A turn
 * mirrored from another tab is this chat's last turn, so the identical question
 * sent here within 60 s is re-served from it: no request, the box empties, no
 * error, and the pair is shown but not saved to History. Not a bug repro: this
 * is the intended behaviour. The real sendMessage runs; only fetch is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import type { SyncMessage } from '../lib/chat-sync';

const sync = vi.hoisted(() => ({ handler: undefined as undefined | ((m: SyncMessage) => void) }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'tab-2',
  subscribeSync: (h: (m: SyncMessage) => void) => { sync.handler = h; return () => { sync.handler = undefined; }; },
}));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async () => {}), eraseMarks: vi.fn(() => []), deleteConversation: vi.fn(async () => {}),
  getMessages: vi.fn(() => []), listConversations: vi.fn(() => []),
}));
vi.mock('../lib/chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store), askChatHistory: () => Promise.resolve({ store, askedMarks: [] }) }));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
// The real request path (PROXY_PATH, parseJsonResponse), so a send that is not re-served reaches fetch.
vi.mock('../lib/server-api', async (real) => ({ ...(await real<typeof import('../lib/server-api')>()), trackProductEvent: vi.fn() }));

import { useChatState } from './useChatState';

const Q = 'What does LDL cholesterol measure?';
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: 'm9', content: 'fresh' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Tab 1's turn lands and its post-state reaches this tab; this tab then sends `question`. */
async function sendAfterMirror(question: string) {
  const hook = renderHook(() => useChatState({ isLoggedIn: false }));
  const landed = new Date().toISOString();
  // Tab 1's post-state at its landing: its thread, its turn, its send ended.
  act(() => sync.handler!({ instanceId: 'tab-1', type: 'state', ts: 0, payload: {
    conversations: [{ id: 'c1', title: Q }], activeConversationId: 'c1', loaded: true, sending: false, isLoading: false, error: null,
    messages: [{ id: 'u1', role: 'user', content: Q, createdAt: landed }, { id: 'a1', role: 'assistant', content: 'tab 1 answer', createdAt: landed }],
  } }));
  expect(hook.result.current.state.isLoading).toBe(false);
  act(() => hook.result.current.actions.handleInputChange(question));
  await act(async () => { await hook.result.current.actions.handleSend(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return hook.result.current.state;
}

describe('US-15 AC3 pin: re-serve of a turn mirrored from another tab', () => {
  it('the same question within 60 s is re-served here: no request, box empty, no error, not saved to History', async () => {
    const state = await sendAfterMirror(Q);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inputText).toBe('');
    expect(state.error).toBeNull();
    expect(state.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      `user:${Q}`, 'assistant:tab 1 answer', `user:${Q}`, 'assistant:tab 1 answer',
    ]);
    // Shown, not saved: the History write rides only on a real reply (chat-api.ts recordExchange).
    expect(store.recordExchange).not.toHaveBeenCalled();
  });

  it('control: a different question goes to the server and is saved, so the pin above is not vacuous', async () => {
    const state = await sendAfterMirror('What does HbA1c measure?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.messages.at(-1)?.content).toBe('fresh');
    expect(store.recordExchange).toHaveBeenCalledTimes(1);
  });
});
