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
    await waitFor(() => expect(hook.result.current.state.pending.thinking).toBe(THINKING));
    expect(hook.result.current.state.pending.text).toBe('');
    act(() => { send.onDelta!({ type: 'text', text: 'ApoB ' }); send.onDelta!({ type: 'text', text: 'counts' }); });
    await waitFor(() => expect(hook.result.current.state.pending.text).toBe('ApoB counts'));
  });

  it('on done: the final answer replaces the stream, the summary stays with it, and none of it is synced', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'thinking', text: THINKING }); send.onDelta!({ type: 'text', text: 'partial' }); });
    await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'ApoB counts more.' }, error: null }); await sending; });
    const { state } = hook.result.current;
    expect(state.isLoading).toBe(false);
    expect(state.pending.thinking).toBe('');
    expect(state.pending.text).toBe('');
    const answer = state.messages.at(-1)!;
    expect(answer).toMatchObject({ role: 'assistant', content: 'ApoB counts more.' });
    expect(answer).not.toHaveProperty('thinking');
    expect(state.approachById[answer.id]).toEqual({ thinking: THINKING, sources: [] });
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
    expect(state.approachById).toEqual({});
  });

  // US-15 AC20/AC21: progress before the answer, and the articles read.
  it('status and sources deltas show while pending, and the sources stay with the answer', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'status', text: 'Reading your question' }); });
    await waitFor(() => expect(hook.result.current.state.pending.status).toBe('Reading your question'));
    act(() => {
      send.onDelta!({ type: 'status', text: 'Finding relevant articles' });
      send.onDelta!({ type: 'sources', titles: ['ApoB explained', 'Statins'] });
      send.onDelta!({ type: 'status', text: 'Writing the answer' });
    });
    await waitFor(() => expect(hook.result.current.state.pending.status).toBe('Writing the answer'));
    expect(hook.result.current.state.pending.sources).toEqual(['ApoB explained', 'Statins']);
    await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'ApoB counts more.' }, error: null }); await sending; });
    const { state } = hook.result.current;
    expect(state.pending.status).toBe('');
    expect(state.pending.sources).toEqual([]);
    const answer = state.messages.at(-1)!;
    expect(state.approachById[answer.id]).toEqual({ thinking: '', sources: ['ApoB explained', 'Statins'] });
    expect(answer).not.toHaveProperty('sources');
    expect(JSON.stringify(postSync.mock.calls)).not.toContain('ApoB explained');
  });

  it('a fallback keeps no sources either', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'sources', titles: ['ApoB explained'] }); });
    await act(async () => {
      send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'Sorry', isFallback: true }, error: null });
      await sending;
    });
    expect(hook.result.current.state.approachById).toEqual({});
  });

  it('an error clears the stream and restores the pre-send state', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'text', text: 'partial' }); });
    await act(async () => { send.resolve!({ result: null, error: { error: 'Network error' } }); await sending; });
    const { state } = hook.result.current;
    expect(state.pending.text).toBe('');
    expect(state.messages).toEqual([]);
    expect(state.error).toBe('Network error');
  });
});

// US-15 AC38: a run_roadmap round's first call often streams a preamble ("Let
// me run those numbers…") or a premature verdict. The status line between the
// calls clears it, so the answer fills an empty bubble and nothing flashes.
describe('US-15 AC38 — a status line clears the text streamed before it', () => {
  const ROUND = 'Running your numbers through the roadmap';
  const PREAMBLE = 'Let me run those numbers through your roadmap. ';

  it('a run_roadmap round clears the preamble, shows the status, then streams the answer alone', async () => {
    const { hook, sending } = await startSend();
    act(() => {
      send.onDelta!({ type: 'status', text: 'Writing the answer' });
      send.onDelta!({ type: 'text', text: PREAMBLE });
    });
    await waitFor(() => expect(hook.result.current.state.pending.text).toBe(PREAMBLE));
    act(() => { send.onDelta!({ type: 'status', text: ROUND }); });
    await waitFor(() => expect(hook.result.current.state.pending.status).toBe(ROUND));
    expect(hook.result.current.state.pending.text).toBe('');
    act(() => { send.onDelta!({ type: 'text', text: 'Your LDL is above target.' }); });
    await waitFor(() => expect(hook.result.current.state.pending.text).toBe('Your LDL is above target.'));
    await act(async () => { send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'Your LDL is above target.' }, error: null }); await sending; });
    expect(hook.result.current.state.messages.at(-1)!.content).toBe('Your LDL is above target.');
  });

  it('a turn with no tool streams as before: the text accumulates under the last status', async () => {
    const { hook } = await startSend();
    act(() => {
      send.onDelta!({ type: 'status', text: 'Reading your question' });
      send.onDelta!({ type: 'status', text: 'Writing the answer' });
      send.onDelta!({ type: 'text', text: 'ApoB ' });
      send.onDelta!({ type: 'text', text: 'counts' });
    });
    await waitFor(() => expect(hook.result.current.state.pending.text).toBe('ApoB counts'));
    expect(hook.result.current.state.pending.status).toBe('Writing the answer');
  });

  it('the thinking summary and the articles read survive the round', async () => {
    const { hook } = await startSend();
    act(() => {
      send.onDelta!({ type: 'sources', titles: ['LDL explained'] });
      send.onDelta!({ type: 'thinking', text: THINKING });
      send.onDelta!({ type: 'text', text: PREAMBLE });
      send.onDelta!({ type: 'status', text: ROUND });
    });
    await waitFor(() => expect(hook.result.current.state.pending.status).toBe(ROUND));
    expect(hook.result.current.state.pending).toMatchObject({ text: '', thinking: THINKING, sources: ['LDL explained'] });
  });

  it('a failed second call keeps today\'s fallback: the fallback line replaces the cleared stream', async () => {
    const { hook, sending } = await startSend();
    act(() => { send.onDelta!({ type: 'text', text: PREAMBLE }); send.onDelta!({ type: 'status', text: ROUND }); });
    await waitFor(() => expect(hook.result.current.state.pending.status).toBe(ROUND));
    await act(async () => {
      send.resolve!({ result: { conversationId: 'c1', messageId: null, content: 'Sorry, try again.', isFallback: true }, error: null });
      await sending;
    });
    const { state } = hook.result.current;
    expect(state.pending.text).toBe('');
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Sorry, try again.', isFallback: true });
    expect(state.approachById).toEqual({});
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

// US-15 AC26 (2026-10-04): a pasted lab report or prompt template is kept whole
// up to 8,000 characters; it was cut silently at 500.
describe('US-15 AC26 — the input holds 8,000 characters', () => {
  const pasted = (n: number) => 'x'.repeat(n);

  it('US-15 AC26: the cap is 8,000', () => {
    expect(hookModule.MAX_CHARS).toBe(8000);
  });

  it('US-15 AC26: a 3,000-character paste is not truncated', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange(pasted(3000)));
    expect(hook.result.current.state.inputText).toHaveLength(3000);
  });

  it('US-15 AC26: an 8,001-character paste keeps the first 8,000', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange(pasted(8001)));
    expect(hook.result.current.state.inputText).toHaveLength(8000);
  });

  it('US-15 AC26: an 8,000-character message is sent whole', async () => {
    const { sendMessage } = await import('../lib/chat-api');
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange(pasted(8000)));
    act(() => { void hook.result.current.actions.handleSend(); });
    expect((sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0]).toBe(pasted(8000));
  });
});

describe('US-15 AC26 — a cut paste is announced', () => {
  const NOTICE = 'Your message was cut at 8,000 characters.';

  it('US-15 AC26: a paste over 8,000 shows the notice; the next normal edit clears it', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange('x'.repeat(8001)));
    expect(hook.result.current.state.error).toBe(NOTICE);
    act(() => hook.result.current.actions.handleInputChange('x'.repeat(7999)));
    expect(hook.result.current.state.error).toBeNull();
  });

  it('US-15 AC26: sending clears the notice', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange('x'.repeat(9000)));
    act(() => { void hook.result.current.actions.handleSend(); });
    expect(hook.result.current.state.error).toBeNull();
  });

  it('US-15 AC26: a paste within the cap shows no notice', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange('x'.repeat(8000)));
    expect(hook.result.current.state.error).toBeNull();
  });

  it('US-15 AC26: an emoji straddling 7999/8000 is dropped, not split', () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    act(() => hook.result.current.actions.handleInputChange('x'.repeat(7999) + '😀'));
    expect(hook.result.current.state.inputText).toBe('x'.repeat(7999));
  });
});

// US-15 AC6a: when the server answers in a different conversation than the one
// the message was sent in (chat-api restarted a thread it no longer
// recognizes), the hook follows it: the new thread is active and listed, and
// it shows that thread's exchange, not the old thread's turns. The old thread
// is no longer reachable, so it leaves the list (opening it would 404).
describe('US-15 AC6a — the reply came back in a new conversation', () => {
  it('US-15 AC6a: the new conversation becomes active, replaces the old one in the list and shows only its own turns', async () => {
    const old = { id: 'c1', title: 'Old thread', updatedAt: 'x', createdAt: 'x' };
    const oldTurn = { id: 'o1', role: 'user' as const, content: 'Earlier question', createdAt: 'x' };
    const hook = renderHook(() => useChatState({
      isLoggedIn: false,
      prefetchedData: { conversations: [old], messages: [oldTurn], activeConversationId: 'c1' },
    }));
    act(() => hook.result.current.actions.handleInputChange('What about ApoB?'));
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.actions.handleSend(); });
    await act(async () => { send.resolve!({ result: { conversationId: 'c2', messageId: 'm2', content: 'ApoB counts.' }, error: null }); await sending; });
    const { state } = hook.result.current;
    expect(state.activeConversationId).toBe('c2');
    expect(state.conversations.map(c => c.id)).toEqual(['c2']);
    expect(state.conversations[0].title).toBe('What about ApoB?');
    expect(state.messages.map(m => m.content)).toEqual(['What about ApoB?', 'ApoB counts.']);
    expect(postSync.mock.calls.at(-1)![0].payload).toMatchObject({ activeConversationId: 'c2' });
  });

  it('US-15 AC6a: opening a thread the server no longer recognizes drops it from the list', async () => {
    const { loadConversation } = await import('../lib/chat-api');
    vi.mocked(loadConversation).mockResolvedValueOnce(null);
    const gone = { id: 'c1', title: 'Old thread', updatedAt: 'x', createdAt: 'x' };
    const kept = { id: 'c3', title: 'Other', updatedAt: 'x', createdAt: 'x' };
    const hook = renderHook(() => useChatState({
      isLoggedIn: false,
      prefetchedData: { conversations: [gone, kept], messages: [], activeConversationId: null },
    }));
    await act(async () => { await hook.result.current.actions.selectConversation('c1'); });
    const { state } = hook.result.current;
    expect(state.conversations.map(c => c.id)).toEqual(['c3']);
    expect(state.activeConversationId).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it('US-15 AC6a: a guest\'s latest thread that 404s on first load is dropped, not left open', async () => {
    const { listConversations, loadConversation } = await import('../lib/chat-api');
    vi.mocked(listConversations).mockResolvedValueOnce({ conversations: [{ id: 'c1', title: 'Old', updatedAt: 'x', createdAt: 'x' }] });
    vi.mocked(loadConversation).mockResolvedValueOnce(null);
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await act(async () => { await hook.result.current.actions.loadConversationsIfNeeded(); });
    expect(hook.result.current.state.conversations).toEqual([]);
    expect(hook.result.current.state.activeConversationId).toBeNull();
  });
});
