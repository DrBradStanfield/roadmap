import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// chat-api imports Sentry at module load; api.ts (parseJsonResponse) pulls in
// ./sentry the same way. Mock both so no SDK initializes.
vi.mock('@sentry/react', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('./sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));
vi.mock('./chat-history-access', () => ({
  getChatHistory: () => Promise.resolve(null),
}));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: false }));

import * as Sentry from '@sentry/react';
import { listConversations, sendMessage } from './chat-api';

// US-15 AC3: a transient upstream failure — a 5xx whose body is not our
// handler's JSON (the Shopify proxy / Fly edge answered, not our route) — is
// retried once before chat surfaces an error. Our handler's own JSON errors
// and 429s are never retried. Evidence: Sentry JAVASCRIPT-REMIX-1M (POST 500,
// no content-type, empty body) and JAVASCRIPT-REMIX-22 (GET 503 text/html).

const okList = () =>
  new Response(JSON.stringify({ success: true, conversations: [{ id: 'c1', title: 't', createdAt: 'x', updatedAt: 'y' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const okSend = () =>
  new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'hi' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** The proxy/edge answering instead of our handler: 5xx, empty body, no content-type. */
const emptyServerError = () => new Response(null, { status: 500 });

/** Our handler answering deterministically: JSON body with an error field. */
const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('chat-api transient upstream retry (US-15 AC3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Run an async chat-api call to completion under fake timers. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  const send = () => settle(sendMessage('my message', 'c1', null));

  it('listConversations retries a proxy-shaped 503 (text/html) once and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html>upstream unavailable</html>', { status: 503, headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(okList());

    const result = await settle(listConversations());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.conversations).toHaveLength(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('sendMessage retries a proxy-shaped 500 (no content-type, empty body) once and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyServerError())
      .mockResolvedValueOnce(okSend());

    const { result, error } = await send();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeNull();
    expect(result?.content).toBe('hi');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('sendMessage does NOT retry our handler\'s JSON 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonError(500, 'Failed to process message'));

    const { result, error } = await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe('Failed to process message');
  });

  it('sendMessage does NOT retry a 429', async () => {
    fetchMock.mockResolvedValueOnce(jsonError(429, 'rate_limited'));

    const { result, error } = await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe('rate_limited');
  });

  it('listConversations surfaces the failure when the retry also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyServerError())
      .mockResolvedValueOnce(emptyServerError());

    const result = await settle(listConversations());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
