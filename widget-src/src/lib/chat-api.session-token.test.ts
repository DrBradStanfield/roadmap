/**
 * US-15 AC6b: the guest session a chat reply hands back is kept only when it
 * is a non-empty string. Anything else leaves the stored session as it was,
 * is not sent back on the next request, and is not returned to the UI.
 * Synthetic replies; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: false }));

import { listConversations, loadConversation, sendMessage } from './chat-api';

const KEY = 'health_roadmap_guest_session';
let stored: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sentToken = (call: number): unknown => {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit | undefined];
  if (init?.body) return JSON.parse(String(init.body)).sessionToken;
  return new URL(url, 'https://shop.example').searchParams.get('sessionToken') ?? undefined;
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  stored = new Map([[KEY, 'old-tok']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const MALFORMED: Array<[string, unknown]> = [['a number', 42], ['an object', { id: 'x' }], ['an empty string', '']];

describe('US-15 AC6b: a guest session token that is not a string is not kept', () => {
  it.each(MALFORMED)('sendMessage: %s', async (_name, token) => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, conversationId: 'c1', messageId: 'm1', content: 'hi', sessionToken: token, isGuest: true }))
      .mockResolvedValueOnce(json(200, { success: true, conversationId: 'c1', messageId: 'm2', content: 'hi again' }));
    const { result } = await sendMessage('hello', null, null);
    expect(stored.get(KEY)).toBe('old-tok');
    expect(result?.sessionToken).toBeUndefined();
    await sendMessage('next', 'c1', null);
    expect(sentToken(1)).toBe('old-tok');
  });

  it.each(MALFORMED)('listConversations: %s', async (_name, token) => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true, conversations: [], sessionToken: token, isGuest: true }));
    const result = await listConversations();
    expect(stored.get(KEY)).toBe('old-tok');
    expect(result?.sessionToken).toBeUndefined();
  });

  it.each(MALFORMED)('a guest 404: %s', async (_name, token) => {
    fetchMock.mockResolvedValueOnce(json(404, { success: false, error: 'Conversation not found', sessionToken: token, isGuest: true }));
    expect(await loadConversation('c1')).toBeNull();
    expect(stored.get(KEY)).toBe('old-tok');
  });

  it('a string token is still kept and sent back (control)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, conversations: [], sessionToken: 'new-tok', isGuest: true }))
      .mockResolvedValueOnce(json(200, { success: true, conversations: [] }));
    expect((await listConversations())?.sessionToken).toBe('new-tok');
    expect(stored.get(KEY)).toBe('new-tok');
    await listConversations();
    expect(sentToken(1)).toBe('new-tok');
  });
});
