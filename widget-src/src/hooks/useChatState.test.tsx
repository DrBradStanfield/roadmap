// @vitest-environment jsdom
/**
 * US-15 AC16/AC17: while an answer streams, the sending instance holds the
 * live thinking summary and answer text; when it lands, the summary stays with
 * that answer for the session only, and nothing of it is synced or saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import type { ChatDelta, SendMessageResult, ChatError } from '../lib/chat-api';

const send = vi.hoisted(() => ({
  onDelta: undefined as undefined | ((d: ChatDelta) => void),
  resolve: undefined as undefined | ((r: { result: SendMessageResult | null; error: ChatError | null }) => void),
}));
vi.mock('../lib/chat-api', () => ({
  sendMessage: vi.fn((_m: string, _c: unknown, _g: unknown, _h: unknown, onDelta: (d: ChatDelta) => void) => {
    send.onDelta = onDelta;
    return new Promise((resolve) => { send.resolve = resolve; });
  }),
  listConversations: vi.fn(), loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
const postSync = vi.hoisted(() => vi.fn());
vi.mock('../lib/chat-sync', () => ({
  postSync, postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));

import * as hookModule from './useChatState';
const { useChatState } = hookModule;

const THINKING = 'Checking the ApoB entry';

async function startSend() {
  const hook = renderHook(() => useChatState({ isLoggedIn: false }));
  act(() => hook.result.current.actions.handleInputChange('What about ApoB?'));
  let sending!: Promise<void>;
  act(() => { sending = hook.result.current.actions.handleSend(); });
  return { hook, sending };
}

beforeEach(() => { postSync.mockClear(); });

describe('US-15 AC16/AC17 — streaming state in useChatState', () => {
  it('the canned thinking lines are gone', () => {
    expect(hookModule).not.toHaveProperty('THINKING_MESSAGES');
  });

  it('shows the thinking summary, then the answer, as deltas arrive', async () => {
    const { hook } = await startSend();
    expect(hook.result.current.state.isLoading).toBe(true);
    expect(hook.result.current.state.isLocalSender).toBe(true);
    act(() => { send.onDelta!({ type: 'thinking', text: 'Checking ' }); send.onDelta!({ type: 'thinking', text: 'the ApoB entry' }); });
    await waitFor(() => expect(hook.result.current.state.streamingThinking).toBe(THINKING));
    expect(hook.result.current.state.streamingText).toBe('');
    act(() => { send.onDelta!({ type: 'text', text: 'ApoB ' }); send.onDelta!({ type: 'text', text: 'counts' }); });
    await waitFor(() => expect(hook.result.current.state.streamingText).toBe('ApoB counts'));
  });

  it('on done: the final answer replaces the stream, the summary stays with it, and none of it is synced', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'thinking', text: THINKING }); send.onDelta!({ type: 'text', text: 'partial' }); });
    await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'ApoB counts more.' }, error: null }); await sending; });
    const { state } = hook.result.current;
    expect(state.isLoading).toBe(false);
    expect(state.streamingThinking).toBe('');
    expect(state.streamingText).toBe('');
    const answer = state.messages.at(-1)!;
    expect(answer).toMatchObject({ role: 'assistant', content: 'ApoB counts more.' });
    expect(answer).not.toHaveProperty('thinking');
    expect(state.thinkingById[answer.id]).toBe(THINKING);
    expect(JSON.stringify(postSync.mock.calls)).not.toContain(THINKING);
  });

  it('a fallback or refusal answer keeps no summary', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'thinking', text: THINKING }); });
    await act(async () => {
      send.resolve!({ result: { conversationId: 'c1', messageId: null, content: "I can't help with that request.", isFallback: true }, error: null });
      await sending;
    });
    const { state } = hook.result.current;
    expect(state.messages.at(-1)!.content).toBe("I can't help with that request.");
    expect(state.thinkingById).toEqual({});
  });

  it('an error clears the stream and restores the pre-send state', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'text', text: 'partial' }); });
    await act(async () => { send.resolve!({ result: null, error: { error: 'Network error' } }); await sending; });
    const { state } = hook.result.current;
    expect(state.streamingText).toBe('');
    expect(state.messages).toEqual([]);
    expect(state.error).toBe('Network error');
  });
});

describe('US-15 AC19 — only the chat that applies edits asks for the tools', () => {
  async function sendWith(onProposeEdit?: () => void) {
    const { sendMessage } = await import('../lib/chat-api');
    const hook = renderHook(() => useChatState({ isLoggedIn: false, onProposeEdit }));
    act(() => hook.result.current.actions.handleInputChange('LDL 3.8 today'));
    act(() => { void hook.result.current.actions.handleSend(); });
    return (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![5];
  }

  it('with onProposeEdit (the widget\'s own chat): canApplyEdits is true', async () => {
    expect(await sendWith(() => {})).toBe(true);
  });

  it('without it (the blog bubble, the chatbot embed): false', async () => {
    expect(await sendWith()).toBe(false);
  });
});
