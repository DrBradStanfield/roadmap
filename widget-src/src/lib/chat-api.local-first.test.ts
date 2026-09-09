import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-15 AC7 / AC3 on the local-first widget: the flag is always sent, the
// conversation's earlier turns travel with the request, the server is never
// asked to delete what it never stored, and an identical resend is answered
// from the client's own last reply.
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async () => {}),
  deleteConversation: vi.fn(async () => {}),
  getMessages: vi.fn(() => []),
  listConversations: vi.fn(() => []),
}));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { deleteConversation, sendMessage } from './chat-api';

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

  it('deletes in the user\'s own file only — the server holds nothing to delete', async () => {
    expect(await deleteConversation('c1')).toBe(true);
    expect(store.deleteConversation).toHaveBeenCalledWith('c1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
