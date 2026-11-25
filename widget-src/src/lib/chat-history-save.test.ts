/**
 * US-15 AC76: both transports hand back their reply's save to the chat-history
 * file, and store a reply's "left" marker. 'unsaved' only where a history file
 * exists and the turn is not in it; 'skipped' with no history layer (the
 * production widget). Synthetic store and replies; no network, no provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react', () => sentry);
vi.mock('./sentry', () => ({ Sentry: sentry }));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async (_opts: unknown) => {}),
  eraseMarks: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  listConversations: vi.fn(() => []),
}));
const access = vi.hoisted(() => ({ store: true, layer: true }));
vi.mock('./chat-history-access', () => ({
  getChatHistory: () => Promise.resolve(access.store ? store : null),
  askChatHistory: () => Promise.resolve({ store: access.store ? store : null, askedMarks: [] }),
  hasChatHistoryLayer: () => access.layer,
}));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async () => ({ text: 'synthetic answer', blocks: [] }),
}));

import { sendMessage as sendWebsite } from './chat-api';
import { sendMessage as sendPages } from './byok-chat';

beforeEach(() => {
  access.store = true;
  access.layer = true;
  const keys = new Map([['hr_anthropic_key', 'sk-ant-synthetic']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => keys.get(k) ?? null,
    setItem: (k: string, v: string) => void keys.set(k, v),
    removeItem: (k: string) => void keys.delete(k),
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'synthetic answer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe.each([
  ['website chat (chat-api)', sendWebsite],
  ['Pages chat (byok-chat)', sendPages],
])('US-15 AC76: %s', (_name, send) => {
  it('a saved turn answers saved', async () => {
    expect(await (await send('hello', null, null)).saved).toBe('saved');
    expect(store.recordExchange).toHaveBeenCalledOnce();
  });

  it('a save that fails answers unsaved, and is still reported (AC47)', async () => {
    store.recordExchange.mockRejectedValueOnce(new Error('synthetic refusal'));
    expect(await (await send('hello', null, null)).saved).toBe('unsaved');
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });

  it('a history file that could not be opened answers unsaved', async () => {
    access.store = false;
    expect(await (await send('hello', null, null)).saved).toBe('unsaved');
  });

  it('no history layer answers skipped: nothing to say', async () => {
    access.store = false;
    access.layer = false;
    expect(await (await send('hello', null, null)).saved).toBe('skipped');
  });

  it('a reply the hook marks left is stored with notSaved left; unmarked, with none', async () => {
    const marks: unknown[] = [];
    await (await send('hello', null, null, [], () => {}, true, (r) => { marks.push(r.content); return 'left'; })).saved;
    expect(marks).toEqual(['synthetic answer']);
    expect(store.recordExchange.mock.calls[0][0]).toMatchObject({ notSaved: 'left', assistantText: 'synthetic answer' });
    await (await send('again', 'c1', null)).saved;
    expect(store.recordExchange.mock.calls[1][0]).not.toHaveProperty('notSaved');
  });
});
