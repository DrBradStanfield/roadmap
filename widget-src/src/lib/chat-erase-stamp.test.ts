/**
 * US-11 AC11 on the web: both chat transports hand the chat history the
 * record's erase identity captured when the question was asked, so a new
 * conversation records it. A reply whose identity moved meanwhile is not
 * saved at all (AC2h), so a saved stamp is always the ask-time one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ onSend: () => {} }));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async () => {}),
  eraseMarks: vi.fn(() => []),
  getMessages: vi.fn(() => []),
}));
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./chat-history-access', () => ({ hasChatHistoryLayer: () => true, getChatHistory: () => Promise.resolve(store), askChatHistory: () => Promise.resolve({ store, askedMarks: [] }) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class extends Error {},
  callAnthropicDirectRaw: async () => { state.onSend(); return { text: 'Synthetic answer', blocks: [] }; },
}));

import { recordEraseIn, setChatEraseReader } from './chat-erase';
import { sendMessage as sendServer } from './chat-api';
import { sendMessage as sendByok } from './byok-chat';

const FIRST = JSON.stringify([1, '2026-11-01T00:00:00.000Z']);
const SECOND = JSON.stringify([2, '2026-11-10T00:00:00.000Z']);
let identity = FIRST;

const transports: Array<[string, () => Promise<unknown>]> = [
  ['server chat', () => sendServer('Synthetic question', null)],
  ['own-key chat', () => sendByok('Synthetic question', null, null)],
];

describe('US-11 AC11: the chat transports stamp a new conversation with the ask-time erase', () => {
  beforeEach(() => {
    identity = FIRST;
    state.onSend = () => {};
    setChatEraseReader(() => identity);
    vi.stubGlobal('fetch', vi.fn(async () => {
      state.onSend();
      return new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'Synthetic answer' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const keys = new Map([['hr_anthropic_key', 'test-key-placeholder']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => keys.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setChatEraseReader(() => ''); });

  it.each(transports)('%s: the identity the question was asked under', async (_name, send) => {
    await send();
    await vi.waitFor(() => expect(store.recordExchange).toHaveBeenCalledWith(expect.objectContaining({ askedUnder: FIRST })));
  });

  it.each(transports)('%s: an identity that moves before the reply saves nothing, so no reply-time stamp is ever written', async (_name, send) => {
    state.onSend = () => { identity = SECOND; };
    await send();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.recordExchange).not.toHaveBeenCalled();
  });

  it('no record read gives no stamp', () => {
    expect(recordEraseIn('0:')).toBeUndefined();
    expect(recordEraseIn(`3:${FIRST}`)).toBe(FIRST);
  });
});
