import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-15 AC7 / AC3 on the local-first widget: the flag is always sent, the
// conversation's earlier turns travel with the request, the server is never
// asked to delete what it never stored, and an identical resend is answered
// from the client's own last reply.
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async () => {}),
  eraseMarks: vi.fn(() => []),
  deleteConversation: vi.fn(async () => {}),
  getMessages: vi.fn(() => []),
  listConversations: vi.fn(() => []),
}));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store), askChatHistory: () => Promise.resolve({ store, askedMarks: [] }) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import * as Sentry from '@sentry/react';
import { deleteConversation, loadConversation, sendMessage } from './chat-api';

const ok = () =>
  new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'fresh answer' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('chat-api on the local-first widget (US-15 AC7)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const sentBody = () => JSON.parse((fetchMock.mock.calls[0] as any)[1].body);

  it('always sends localFirst and the conversation history from its own file', async () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'first', createdAt: 't1' },
      { id: 'm2', role: 'assistant' as const, content: 'reply', createdAt: 't2' },
    ];
    await sendMessage('next', 'c1', { unitSystem: 'si' }, history);
    const body = sentBody();
    expect(body.localFirst).toBe(true);
    expect(body.history).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }]);
    expect(body.guestInputs).toEqual({ unitSystem: 'si' });
  });

  it('US-09 AC2c: an answer whose history save the device refuses still reaches the page, and the refusal is not reported (A15)', async () => {
    const { WritesStoppedError } = await import('./error-diagnostics');
    store.recordExchange.mockRejectedValueOnce(new WritesStoppedError());
    const { result, error } = await sendMessage('SYNTHETIC_REFUSED_QUESTION', null, null);
    expect(error).toBeNull();
    expect(result?.content).toBe('fresh answer');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.recordExchange).toHaveBeenCalledOnce();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('sends an empty history for a new conversation', async () => {
    await sendMessage('first', null, null);
    expect(sentBody().history).toEqual([]);
    expect(sentBody().localFirst).toBe(true);
  });

  const now = () => new Date().toISOString();

  it('re-serves its own last reply on a byte-identical resend, without a request', async () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'same question', createdAt: now() },
      { id: 'm2', role: 'assistant' as const, content: 'the earlier answer', createdAt: now() },
    ];
    const { result, error } = await sendMessage('same question', 'c1', null, history);
    expect(error).toBeNull();
    expect(result).toEqual({ conversationId: 'c1', messageId: null, content: 'the earlier answer' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.recordExchange).not.toHaveBeenCalled();
  });

  it('does not re-serve when the last turn differs or has no reply yet', async () => {
    await sendMessage('same question', 'c1', null, [{ id: 'm1', role: 'user', content: 'other', createdAt: now() }, { id: 'm2', role: 'assistant', content: 'x', createdAt: now() }]);
    await sendMessage('same question', 'c1', null, [{ id: 'm1', role: 'user', content: 'same question', createdAt: now() }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never re-serves a fallback reply (US-15 AC3)', async () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'q', createdAt: now() },
      { id: 'm2', role: 'assistant' as const, content: 'Sorry, try again', createdAt: now(), isFallback: true },
    ];
    await sendMessage('q', 'c1', null, history);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-serve a reply older than the 60 s window', async () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'q', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'm2', role: 'assistant' as const, content: 'old answer', createdAt: '2026-09-01T00:00:05Z' },
    ];
    await sendMessage('q', 'c1', null, history);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the server\'s fallback flag on the result so the next resend is not deduped', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'Sorry', isFallback: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { result } = await sendMessage('q', 'c1', null, []);
    expect(result?.isFallback).toBe(true);
  });

  it('treats the server\'s refusal line like a fallback: never re-served (US-15 AC14)', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: "I can't help with that request.", isRefusal: true, isFallback: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { result } = await sendMessage('q', 'c1', null, []);
    expect(result?.content).toBe("I can't help with that request.");
    expect(result?.isFallback).toBe(true);
  });

  // Codex R1 / adversary R10: the flag must survive a reload from the cloud file.
  it('records a fallback or refusal turn as isFallback in the cloud history; an answer carries no flag', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'Sorry', isFallback: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await sendMessage('q', 'c1', null, []);
    await sendMessage('q2', 'c1', null, []);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.recordExchange).toHaveBeenCalledWith(expect.objectContaining({ assistantText: 'Sorry', isFallback: true }));
    store.recordExchange.mockClear();
    fetchMock.mockImplementation(async () => ok());
    await sendMessage('q3', 'c1', null, []);
    await new Promise((r) => setTimeout(r, 0));
    expect((store.recordExchange.mock.calls[0] as unknown[])[0]).not.toHaveProperty('isFallback');
  });

  it('deletes in the user\'s own file only — the server holds nothing to delete', async () => {
    expect(await deleteConversation('c1')).toBe(true);
    expect(store.deleteConversation).toHaveBeenCalledWith('c1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // N1, N2 (Fable 2026-11-12): a thread read from the user's own file that throws is failed, never an empty thread.
  it('US-15 AC7a, N2: the cloud store\'s getMessages throwing synchronously is a failed read', async () => {
    store.getMessages.mockImplementationOnce(() => { throw new Error('file unreadable'); });
    expect(await loadConversation('c1')).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Codex R1 (privacy): the cloud store's StorageError can quote chat text in its message or cause.
  it('a store error\'s message and cause reach neither the console nor Sentry', async () => {
    const MARKER = 'SYNTHETIC_CHAT_MARKER';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.getMessages.mockImplementationOnce(() => { throw Object.assign(new Error(`bad file: ${MARKER}`), { cause: new Error(MARKER) }); });
    expect(await loadConversation('c1')).toBe('failed');
    const text = (v: unknown, depth = 0): string => depth > 4 || v == null ? '' : v instanceof Error
      ? `${v.message} ${v.stack ?? ''} ${text((v as { cause?: unknown }).cause, depth + 1)}`
      : typeof v === 'object' ? Object.values(v).map((x) => text(x, depth + 1)).join(' ') : String(v);
    const said = [warn, error, vi.mocked(Sentry.captureException), vi.mocked(Sentry.captureMessage)].flatMap((m) => m.mock.calls).map((c) => text(c)).join(' ');
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { feature: 'chat', kind: 'store' } });
    expect(said).not.toContain(MARKER);
    warn.mockRestore(); error.mockRestore();
  });
});
