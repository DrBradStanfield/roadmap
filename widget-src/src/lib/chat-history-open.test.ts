/**
 * US-15 AC66 (root fix R15, leads A2 and C26b): the chat-history open is one
 * named state. A failed open is tried again on the next turn or read, never on
 * its own; one open is in flight at a time; a result names the attempt it
 * began under; and while a history layer exists, no read goes to the server.
 * Synthetic stores, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistoryStore } from '../storage/chat-history-store';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { getChatHistory, setChatHistoryFactory, transition, type ChatHistoryOpen, type ChatHistoryOpenEvent } from './chat-history-access';
import { deleteConversation, listConversations, loadConversation, sendMessage } from './chat-api';

function fakeStore(title = 'SYNTHETIC_THREAD') {
  return {
    recordExchange: vi.fn(async () => {}),
    eraseMarks: vi.fn((): string[] => []),
    listConversations: vi.fn(() => [{ id: 'c1', title }]),
    getMessages: vi.fn(() => []),
    deleteConversation: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  };
}
const asStore = (s: ReturnType<typeof fakeStore>) => s as unknown as ChatHistoryStore;

/** A factory whose opens settle by hand, in any order. */
function manualFactory() {
  const opens: Array<{ resolve: (s: ChatHistoryStore) => void; reject: (e: Error) => void }> = [];
  const factory = vi.fn(() => new Promise<ChatHistoryStore>((resolve, reject) => { opens.push({ resolve, reject }); }));
  return { factory, opens };
}

const answer = () => new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'synthetic answer' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('US-15 AC66: the chat-history open transition', () => {
  const pending = Promise.resolve(asStore(fakeStore()));
  const store = asStore(fakeStore());
  const closed: ChatHistoryOpen = { phase: 'closed', attempt: 0 };
  const opening: ChatHistoryOpen = { phase: 'opening', attempt: 2, pending, at: 'e1' };
  const open: ChatHistoryOpen = { phase: 'open', attempt: 2, pending, store, readAt: 'e1' };
  const failed: ChatHistoryOpen = { phase: 'failed', attempt: 2 };
  const began: ChatHistoryOpenEvent = { type: 'open-began', pending, at: 'e2' };

  const rows: Array<[string, ChatHistoryOpen, ChatHistoryOpenEvent, ChatHistoryOpen]> = [
    ['closed + open-began opens attempt 1', closed, began, { phase: 'opening', attempt: 1, pending, at: 'e2' }],
    ['failed + open-began opens the next attempt', failed, began, { phase: 'opening', attempt: 3, pending, at: 'e2' }],
    ['opening + open-began keeps the one in flight', opening, began, opening],
    ['open + open-began keeps the open session', open, began, open],
    ['opening + opened of its attempt is open', opening, { type: 'opened', attempt: 2, store }, open],
    ['opening + opened of an older attempt changes nothing', opening, { type: 'opened', attempt: 1, store }, opening],
    ['opening + open-failed of its attempt is failed', opening, { type: 'open-failed', attempt: 2 }, failed],
    ['opening + open-failed of an older attempt changes nothing', opening, { type: 'open-failed', attempt: 1 }, opening],
    ['open + opened of an older attempt changes nothing', open, { type: 'opened', attempt: 1, store: asStore(fakeStore()) }, open],
    ['open + open-failed of an older attempt changes nothing', open, { type: 'open-failed', attempt: 1 }, open],
    ['failed + opened of an older attempt changes nothing', failed, { type: 'opened', attempt: 1, store }, failed],
    ['closed + opened changes nothing', closed, { type: 'opened', attempt: 0, store }, closed],
    ['open + reread of its attempt moves readAt', open, { type: 'reread', attempt: 2, at: 'e3' }, { ...open, readAt: 'e3' }],
    ['open + reread of an older attempt changes nothing', open, { type: 'reread', attempt: 1, at: 'e3' }, open],
    ['opening + reread changes nothing', opening, { type: 'reread', attempt: 2, at: 'e3' }, opening],
    ['open + reset is closed, past every attempt so far', open, { type: 'reset' }, { phase: 'closed', attempt: 3 }],
    ['opening + reset is closed, past every attempt so far', opening, { type: 'reset' }, { phase: 'closed', attempt: 3 }],
    ['failed + reset is closed', failed, { type: 'reset' }, { phase: 'closed', attempt: 3 }],
  ];
  it.each(rows)('%s', (_name, from, event, to) => {
    expect(transition(from, event)).toEqual(to);
  });
});

describe('US-15 AC66: a failed chat-history open is tried again on the next turn or read', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    setChatHistoryFactory(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('a failed open, then a later turn saves to the history file', async () => {
    const store = fakeStore();
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic cloud blip'))
      .mockResolvedValue(asStore(store));
    setChatHistoryFactory(factory);

    const first = await sendMessage('SYNTHETIC_Q1', null, null);
    expect(first.error).toBeNull();
    const second = await sendMessage('SYNTHETIC_Q2', 'c1', null);
    expect(second.error).toBeNull();

    await vi.waitFor(() => expect(store.recordExchange).toHaveBeenCalledTimes(1));
    expect(store.recordExchange).toHaveBeenCalledWith(expect.objectContaining({ userText: 'SYNTHETIC_Q2' }));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('a failed open, then the next list read opens again and shows the conversations', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic cloud blip'))
      .mockResolvedValue(asStore(fakeStore()));
    setChatHistoryFactory(factory);

    await expect(listConversations()).resolves.toBeNull();
    await expect(listConversations()).resolves.toEqual({ conversations: [{ id: 'c1', title: 'SYNTHETIC_THREAD' }], isGuest: false });
  });

  it('a failed open is not tried again by itself: only the next caller opens', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('synthetic cloud blip'));
    setChatHistoryFactory(factory);

    await expect(getChatHistory()).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(getChatHistory()).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('at most one open is in flight: callers during an open share it', async () => {
    const { factory, opens } = manualFactory();
    setChatHistoryFactory(factory);
    const a = getChatHistory();
    const b = getChatHistory();
    const c = listConversations();
    expect(factory).toHaveBeenCalledTimes(1);
    const store = asStore(fakeStore());
    opens[0].resolve(store);
    await expect(a).resolves.toBe(store);
    await expect(b).resolves.toBe(store);
    await expect(c).resolves.toMatchObject({ isGuest: false });
  });

  it('a late result of attempt 1, after attempt 2 opened, changes nothing', async () => {
    const { factory, opens } = manualFactory();
    setChatHistoryFactory(factory);
    const first = getChatHistory(); // attempt 1, still in flight
    // The data layer registers again (a new init) while attempt 1 is out.
    setChatHistoryFactory(factory);
    const second = getChatHistory(); // attempt 2
    const newer = asStore(fakeStore('SYNTHETIC_NEWER'));
    opens[1].resolve(newer);
    await expect(second).resolves.toBe(newer);

    opens[0].resolve(asStore(fakeStore('SYNTHETIC_OLDER')));
    await first;
    await expect(getChatHistory()).resolves.toBe(newer);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('a late failure of attempt 1, after attempt 2 opened, changes nothing', async () => {
    const { factory, opens } = manualFactory();
    setChatHistoryFactory(factory);
    const first = getChatHistory();
    setChatHistoryFactory(factory);
    const second = getChatHistory();
    const newer = asStore(fakeStore());
    opens[1].resolve(newer);
    await second;

    opens[0].reject(new Error('synthetic late failure'));
    await first;
    await expect(getChatHistory()).resolves.toBe(newer);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('US-15 AC66: while a history layer exists, no read goes to the server path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    setChatHistoryFactory(vi.fn().mockRejectedValue(new Error('synthetic cloud down')));
  });
  afterEach(() => {
    setChatHistoryFactory(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('the History list answers as a failed read, with no server request', async () => {
    await expect(listConversations()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a thread read answers failed, with no server request', async () => {
    await expect(loadConversation('c1')).resolves.toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a delete answers failed, with no server request', async () => {
    await expect(deleteConversation('c1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: with no history layer registered, the list reads the server', async () => {
    setChatHistoryFactory(null);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, conversations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(listConversations()).resolves.toMatchObject({ conversations: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
