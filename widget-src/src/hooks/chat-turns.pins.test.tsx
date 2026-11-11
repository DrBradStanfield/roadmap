// @vitest-environment jsdom
/**
 * Chat PR 1 (US-15 AC16/AC17/AC20/AC26/AC45/AC57): golden pins of one web chat turn today,
 * read from the table both clients run (packages/health-core/src/__fixtures__/chat-turns.json;
 * the phone: ios/HealthRoadmapTests/ChatTurnPinsTests.swift). No behaviour change: a later move
 * into a shared reducer keeps every row green, unedited.
 *
 * The real path runs: useChatState → sendMessage (chat-api) → readChatStream over a stubbed
 * fetch whose body the test writes line by line, and ChatPendingReply draws the pending words
 * from the hook's state, shown only while isLoading, as ChatSection and ChatEmbed draw it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import table from '../../../packages/health-core/src/__fixtures__/chat-turns.json';
import type { ChatMessage } from '../lib/chat-api';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'pins',
}));

import { useChatState } from './useChatState';
import { ChatPendingReply } from '../components/ChatPendingReply';

type Json = unknown;
type Piece = string | { repeat: string; times: number };
interface Step { line: Json; pending?: Json; text?: Json; sources?: Json }
interface Turn {
  id: string; question: string; clients?: string[]; steps?: Step[]; end?: string;
  failure?: { web?: { status?: number; body?: Json; reject?: string } };
  after: Record<string, Json>;
}

/** This client's value: a split value's `web`, else the value both clients share. */
const web = (v: Json): Json =>
  v && typeof v === 'object' && !Array.isArray(v) && 'web' in v && 'phone' in v ? (v as { web: Json }).web : v;
const runsOnWeb = (row: { clients?: string[] }) => !row.clients || row.clients.includes('web');
const text = (spec: Piece[]): string => spec.map(p => (typeof p === 'string' ? p : p.repeat.repeat(p.times))).join('');

/** A fetch answer whose NDJSON body the test writes one line at a time. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    write: (line: Json) => { try { controller.enqueue(encoder.encode((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')); } catch { /* the reader let go */ } },
    close: () => { try { controller.close(); } catch { /* the reader let go */ } },
  };
}

/** Lets the stream reader, the send's await chain and a frame's render run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  await new Promise<void>(r => requestAnimationFrame(() => r()));
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0));
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mount(messages: ChatMessage[] = []) {
  const prefetchedData = messages.length ? { conversations: [], messages, activeConversationId: 'c1' } : null;
  const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData }));
  /** The words under the conversation, or null when no reply is pending. */
  const pending = () => {
    const { state } = hook.result.current;
    if (!state.isLoading) return null;
    const { container, unmount } = render(<ChatPendingReply isLocalSender={state.isLocalSender} pending={state.pending} />);
    const words = container.querySelector('.chat-pending-status')?.textContent ?? null;
    unmount();
    return words;
  };
  const send = async (question: string) => {
    act(() => hook.result.current.actions.handleInputChange(question));
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.actions.handleSend(); });
    await act(settle);
    return { sending }; // wrapped: an async function returning the promise would wait for it
  };
  const transcript = () => hook.result.current.state.messages.map(m => ({ role: m.role, text: m.content }));
  return { hook, pending, send, transcript };
}

const answered = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => [
  { id: `u${i}`, role: 'user' as const, content: `Question ${i}`, createdAt: '2026-11-01T00:00:00.000Z' },
  { id: `a${i}`, role: 'assistant' as const, content: `Answer ${i}`, createdAt: '2026-11-01T00:00:00.000Z' },
]).flat();

const done = { type: 'done', success: true, conversationId: 'c1', messageId: null, content: 'An answer.', isFallback: false };

describe('chat turns: golden pins (web)', () => {
  const turns = (table.turns as Turn[]).filter(runsOnWeb);

  it.each(turns.map(t => [t.id, t] as const))('%s', async (_id, row) => {
    const chat = mount();
    let stream: ReturnType<typeof openStream> | undefined;
    const failure = row.failure?.web;
    if (failure?.reject) fetchMock.mockRejectedValue(new TypeError(failure.reject));
    else if (failure) fetchMock.mockResolvedValue(Response.json(failure.body, { status: failure.status }));
    else { stream = openStream(); fetchMock.mockResolvedValue(stream.response); }

    const { sending } = await chat.send(row.question);
    if (stream) {
      expect(chat.pending(), 'after ask').toBe(table.afterAsk.pending);
      expect(chat.hook.result.current.state.pending.text).toBe(table.afterAsk.text);
    }
    for (const [i, step] of (row.steps ?? []).entries()) {
      stream!.write(step.line);
      await act(settle);
      const at = `step ${i + 1}`;
      if ('pending' in step) expect(chat.pending(), at).toBe(web(step.pending));
      if ('text' in step) expect(chat.hook.result.current.state.pending.text, at).toBe(web(step.text));
      if ('sources' in step) expect(chat.hook.result.current.state.pending.sources, at).toEqual(web(step.sources));
    }
    if (row.end === 'cutOff') stream!.close();
    await act(async () => { await settle(); await sending; });

    const { state } = chat.hook.result.current;
    const after = row.after;
    expect(chat.pending(), 'turn over').toBeNull();
    expect(chat.transcript()).toEqual(web(after.transcript));
    expect(state.inputText).toBe(web(after.box));
    expect(state.error).toBe(web(after.error));
    expect(web(after.retry), 'the web has no Try again').toBeNull();
    const answer = state.messages.at(-1);
    const approach = answer?.role === 'assistant' ? state.approachById[answer.id] : undefined;
    if ('sources' in after) expect(approach?.sources ?? []).toEqual(web(after.sources));
    if ('thinking' in after) expect(approach?.thinking ?? '').toBe(web(after.thinking));
  });
});

describe('chat history sent with the next question: golden pins (web)', () => {
  const rows = (table.history.rows as { id: string; clients?: string[]; answered: number; thenFailed?: boolean; count: Json }[]).filter(runsOnWeb);

  it.each(rows.map(r => [r.id, r] as const))('%s', async (_id, row) => {
    const chat = mount(answered(row.answered));
    if (row.thenFailed) {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { sending: failing } = await chat.send('This one fails');
      await act(async () => { await failing; });
      expect(chat.hook.result.current.state.error).toBe('Network error');
    }
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { sending } = await chat.send('The next question');
    stream.write(done);
    await act(async () => { await settle(); await sending; });
    const history = JSON.parse(fetchMock.mock.calls.at(-1)![1].body).history as { role: string; content: string }[];
    expect(history).toHaveLength(web(row.count) as number);
    expect(history.map(h => h.content)).not.toContain('This one fails');
    expect(history.map(h => h.content)).not.toContain('The next question');
  });
});

describe('a long question: golden pins (web)', () => {
  const rows = table.question.rows as { id: string; typed: Piece[]; sentLength: Json; notice: Json }[];

  it.each(rows.map(r => [r.id, r] as const))('%s', async (_id, row) => {
    const chat = mount();
    act(() => chat.hook.result.current.actions.handleInputChange(text(row.typed)));
    expect(chat.hook.result.current.state.error).toBe(web(row.notice));
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    let sending!: Promise<void>;
    act(() => { sending = chat.hook.result.current.actions.handleSend(); });
    await act(settle);
    stream.write(done);
    await act(async () => { await settle(); await sending; });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toHaveLength(web(row.sentLength) as number);
  });
});
