import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-15 AC62: a reply is saved to the chat-history file only under the mark
// taken as its question was first sent. The guest-thread resend (US-15 AC6a)
// keeps that first mark: a fresh one taken after an erase began would let the
// erased turn be saved.
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
const history = vi.hoisted(() => ({
  mark: 'before-the-erase' as string | null,
  store: { recordExchange: vi.fn(async () => {}) },
}));
vi.mock('./chat-history-access', () => ({
  chatMark: () => history.mark,
  stillMarked: (mark: string | null) => mark !== null && mark === history.mark,
  getChatHistory: () => Promise.resolve(history.store),
}));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { sendMessage } from './chat-api';

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('US-15 AC62: the guest-thread resend keeps the first mark', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    history.mark = 'before-the-erase';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stored = new Map<string, string>([['health_roadmap_guest_session', 'old-tok']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, v); },
      removeItem: (k: string) => { stored.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('an erase that moves the mark during the first request keeps the resent turn out of the history file', async () => {
    fetchMock.mockImplementationOnce(async () => {
      history.mark = 'after-the-erase'; // the erase lands while the first request is out
      return json(404, { success: false, error: 'Conversation not found', sessionToken: 'new-tok', isGuest: true });
    });
    fetchMock.mockResolvedValueOnce(json(200, { success: true, conversationId: 'c2', messageId: 'm2', content: 'Done.', isGuest: true }));
    const { result } = await sendMessage('a question', 'c1');
    await flush();
    expect(result?.conversationId).toBe('c2');
    expect(history.store.recordExchange).not.toHaveBeenCalled();
  });

  it('a mark taken while this page\'s erase runs (null) never saves', async () => {
    history.mark = null;
    fetchMock.mockResolvedValueOnce(json(200, { success: true, conversationId: 'c3', messageId: 'm3', content: 'Done.' }));
    await sendMessage('a question', null);
    await flush();
    expect(history.store.recordExchange).not.toHaveBeenCalled();
  });

  it('control: with no erase, the resent turn is saved', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { success: false, error: 'Conversation not found', sessionToken: 'new-tok', isGuest: true }));
    fetchMock.mockResolvedValueOnce(json(200, { success: true, conversationId: 'c2', messageId: 'm2', content: 'Done.', isGuest: true }));
    await sendMessage('a question', 'c1');
    await flush();
    expect(history.store.recordExchange).toHaveBeenCalledTimes(1);
  });
});
