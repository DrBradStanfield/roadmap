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
  askChatHistory: () => Promise.resolve({ store: null }),
}));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: false }));

import * as Sentry from '@sentry/react';
import { deleteConversation, listConversations, loadConversation, sendMessage } from './chat-api';
import { setChatArticle } from './assistant-config';

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
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('Chat listConversations failed', expect.anything());
  });

  it('sendMessage retries a proxy-shaped 500 (no content-type, empty body) once and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyServerError())
      .mockResolvedValueOnce(okSend());

    const { result, error } = await send();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeNull();
    expect(result?.content).toBe('hi');
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith('Chat sendMessage failed', expect.anything());
  });

  it('sendMessage does NOT retry a thread-first message (no conversationId — server dedup cannot absorb it)', async () => {
    fetchMock.mockResolvedValueOnce(emptyServerError());

    const { result, error } = await settle(sendMessage('my message', null, null));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe('Failed to send message');
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
    expect(error?.error).toBe('Chat limit reached. Please try again later.');
  });

  it('US-15 AC63: a busy 409 shows the server words, is not retried and raises no Sentry event; a JSON 500 still does', async () => {
    const busy = 'Still answering this question. Try sending it again in a moment.';
    fetchMock.mockResolvedValueOnce(jsonError(409, busy));
    vi.mocked(Sentry.captureMessage).mockClear();

    const { result, error } = await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe(busy);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonError(500, 'Failed to process message'));
    await send();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat sendMessage failed', expect.objectContaining({ level: 'error' }));
  });

  it('listConversations surfaces the failure when the retry also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyServerError())
      .mockResolvedValueOnce(emptyServerError());

    const result = await settle(listConversations());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat listConversations failed', expect.anything());
  });
});

// US-15 AC6a: a guest's identity is its session token plus its IP, so a new IP
// is a new guest who does not own the stored thread, and every send in it
// answers 404. The guest's 404 carries the session the server just gave it;
// the client keeps that session and sends the message once in a fresh
// conversation, so it is neither lost nor sent twice. A customer's 404 is shown.
describe('chat-api: a thread the server no longer recognizes (US-15 AC6a)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);
  const guestNotFound = (sessionToken: string) =>
    new Response(JSON.stringify({ success: false, error: 'Conversation not found', sessionToken, isGuest: true }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stored = new Map<string, string>([['health_roadmap_guest_session', 'old-tok']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, v); },
      removeItem: (k: string) => { stored.delete(k); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('US-15 AC6a: a guest 404 for the stored thread resends the message once, in a new conversation, on the session it handed back', async () => {
    fetchMock
      .mockResolvedValueOnce(guestNotFound('new-tok'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, conversationId: 'c2', messageId: 'm2', content: 'hi', sessionToken: 'new-tok', isGuest: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

    const { result, error } = await sendMessage('my message', 'c1', null);

    expect(error).toBeNull();
    expect(result?.conversationId).toBe('c2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0)).toMatchObject({ message: 'my message', conversationId: 'c1', sessionToken: 'old-tok' });
    expect(bodyOf(1)).toMatchObject({ message: 'my message', sessionToken: 'new-tok' });
    expect(bodyOf(1)).not.toHaveProperty('conversationId');
    expect(localStorage.getItem('health_roadmap_guest_session')).toBe('new-tok');
  });

  it('US-15 AC6a: a signed-in customer\'s 404 is shown, not forked into a new thread', async () => {
    fetchMock.mockResolvedValueOnce(jsonError(404, 'Conversation not found'));

    const { result, error } = await sendMessage('my message', 'c1', null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe('Conversation not found');
  });

  it('US-15 AC6a: a 404 on a message that named no thread is an error, not a resend', async () => {
    fetchMock.mockResolvedValueOnce(guestNotFound('new-tok'));

    const { result, error } = await sendMessage('my message', null, null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(error?.error).toBe('Conversation not found');
  });

  it('US-15 AC6a: a 404 in the new conversation too surfaces the error after two requests', async () => {
    fetchMock
      .mockResolvedValueOnce(guestNotFound('new-tok'))
      .mockResolvedValueOnce(guestNotFound('new-tok'));

    const { result, error } = await sendMessage('my message', 'c1', null);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
    expect(error?.error).toBe('Conversation not found');
  });

  it('US-15 AC6a: the resend carries the handed-back token even when storage refuses the write', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'old-tok',
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    });
    fetchMock
      .mockResolvedValueOnce(guestNotFound('new-tok'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, conversationId: 'c2', messageId: 'm2', content: 'hi', sessionToken: 'new-tok', isGuest: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

    const { result } = await sendMessage('my message', 'c1', null);

    expect(result?.conversationId).toBe('c2');
    expect(bodyOf(1)).toMatchObject({ message: 'my message', sessionToken: 'new-tok' });
  });

  it('US-15 AC6a: loading a guest thread that 404s keeps the handed-back session and reports the thread gone', async () => {
    fetchMock.mockResolvedValueOnce(guestNotFound('new-tok'));

    expect(await loadConversation('c1')).toBe('gone');
    expect(localStorage.getItem('health_roadmap_guest_session')).toBe('new-tok');
  });

  // N2 (Fable 2026-11-12): a load that failed is never an empty thread, or a send goes out without its history.
  // R6, Fable (a): a signed-in customer's not-found on load is gone like a guest's; any other error answer is failed.
  it('US-15 AC6a: a customer\'s 404 on load reports the thread gone; another error answer is a failed read', async () => {
    fetchMock.mockResolvedValueOnce(jsonError(404, 'Conversation not found'));
    expect(await loadConversation('c1')).toBe('gone');
    expect(localStorage.getItem('health_roadmap_guest_session')).toBe('old-tok'); // a customer's answer hands back no session
    fetchMock.mockResolvedValueOnce(jsonError(500, 'Failed to load'));
    expect(await loadConversation('c1')).toBe('failed');
    fetchMock.mockResolvedValueOnce(jsonError(403, 'Forbidden'));
    expect(await loadConversation('c1')).toBe('failed');
  });

  // Codex R1 (privacy): a thrown error, a malformed body or a cause can quote chat text; none reaches the console or Sentry.
  describe('a failed read or list reports no error text (Codex R1)', () => {
    const MARKER = 'SYNTHETIC_CHAT_MARKER';
    const said = () => {
      const text = (v: unknown, depth = 0): string => depth > 4 || v == null ? '' : v instanceof Error
        ? `${v.message} ${v.stack ?? ''} ${text((v as { cause?: unknown }).cause, depth + 1)}`
        : typeof v === 'object' ? Object.values(v).map((x) => text(x, depth + 1)).join(' ') : String(v);
      return [warn, error, vi.mocked(Sentry.captureException), vi.mocked(Sentry.captureMessage)].flatMap((m) => m.mock.calls).map((c) => text(c)).join(' ');
    };
    let warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); error = vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); error.mockRestore(); });
    const planted = () => Object.assign(new Error(`read failed: ${MARKER}`), { cause: new Error(`cause: ${MARKER}`) });
    const malformed = () => new Response(`{"messages":[{"content":"${MARKER}"`, { status: 200, headers: { 'Content-Type': 'application/json' } });

    it('loadConversation: a thrown fetch, then a malformed body', async () => {
      fetchMock.mockRejectedValueOnce(planted()).mockResolvedValueOnce(malformed());
      expect(await loadConversation('c1')).toBe('failed');
      expect(await loadConversation('c1')).toBe('failed');
      expect(Sentry.captureException).toHaveBeenCalledTimes(2);
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { feature: 'chat', kind: 'fetch' } });
      expect(said()).not.toContain(MARKER);
    });

    it('listConversations: a thrown fetch, then a malformed body', async () => {
      fetchMock.mockRejectedValueOnce(planted()).mockResolvedValueOnce(malformed());
      expect(await listConversations()).toBeNull();
      expect(await listConversations()).toBeNull();
      expect(Sentry.captureException).toHaveBeenCalledTimes(2);
      expect(said()).not.toContain(MARKER);
    });
  });

  it('US-15 AC7a, N2: an answer with success false, or a throw, is a failed read', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await loadConversation('c1')).toBe('failed');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await loadConversation('c1')).toBe('failed');
  });

  it('US-15 AC7a, N1: the read carries the caller\'s signal, and an aborted read is failed', async () => {
    const abort = new AbortController();
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const read = loadConversation('c1', abort.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()); // the request is out, and hangs
    abort.abort();
    expect(await read).toBe('failed');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: abort.signal });
  });

  it('US-15 AC6a: deleting a guest thread that 404s keeps the handed-back session and counts as gone', async () => {
    fetchMock.mockResolvedValueOnce(guestNotFound('new-tok'));

    expect(await deleteConversation('c1')).toBe(true);
    expect(localStorage.getItem('health_roadmap_guest_session')).toBe('new-tok');
  });
});

// US-50 AC14: the site chat sends the blog post it is open on, so the server
// keeps that post beside its topic master. Nothing is sent off a blog post.
describe('chat-api: the open blog post (US-50 AC14)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: 'm1', content: 'hi' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  afterEach(() => {
    setChatArticle(null);
    vi.unstubAllGlobals();
  });

  it('sends articleHandle only when set', async () => {
    await sendMessage('my message', 'c1', null);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('articleHandle');
    setChatArticle('some-post');
    await sendMessage('my message', 'c1', null);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).articleHandle).toBe('some-post');
  });
});

// US-15 AC47b: a failed delete reports fixed words only. The
// error and its cause chain reach neither the console nor Sentry.
describe.each([
  ['delete', 'Chat delete failed', () => deleteConversation('c1')],
] as const)('US-15 AC47b: a failed %s reports fixed words only', (kind, words, call) => {
  const MARKER = 'zz-thread-marker';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('neither the error nor its cause reaches the console or Sentry', async () => {
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    const failure = Object.assign(new Error(`failed for ${MARKER}`), { cause: new Error(`cause ${MARKER}`) });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

    await call();

    const captured = vi.mocked(Sentry.captureException).mock.calls;
    expect(captured).toHaveLength(1);
    const [reported, context] = captured[0] as unknown as [Error, { tags: Record<string, string> }];
    expect(reported.message).toBe(words);
    expect('cause' in reported).toBe(false);
    expect(context.tags).toEqual({ feature: 'chat', kind });
    const printed = spies.flatMap((s) => s.mock.calls);
    expect(printed).toEqual([[words]]);
    const text = (x: unknown): string => {
      if (x instanceof Error) return `${x.message} ${text((x as { cause?: unknown }).cause)}`;
      return x === undefined ? '' : JSON.stringify(x) ?? String(x);
    };
    const all = [...printed, ...captured, ...vi.mocked(Sentry.captureMessage).mock.calls];
    expect(all.flat().map(text).join(' ')).not.toContain(MARKER);
  });

  it('a dropped connection reads as a network request that did not answer', async () => {
    vi.mocked(Sentry.captureException).mockClear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await call();

    const captured = vi.mocked(Sentry.captureException).mock.calls;
    expect(captured).toHaveLength(1);
    const [reported, context] = captured[0] as unknown as [Error, { tags: Record<string, string> }];
    expect(reported.message).toBe('Network request did not answer');
    expect(context.tags).toEqual({ feature: 'chat', kind });
  });
});
