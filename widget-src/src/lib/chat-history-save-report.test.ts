/**
 * US-15 AC47: a chat turn the user's chat-history file failed to save is
 * reported to Sentry, from the website chat and from the Pages chat, with a
 * fixed message and no chat text. The answer still reaches the user.
 * Synthetic store and replies; no network, no provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react', () => sentry);
vi.mock('./sentry', () => ({ Sentry: sentry }));
const store = vi.hoisted(() => ({
  recordExchange: vi.fn(async () => {}),
  eraseMarks: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  listConversations: vi.fn(() => []),
}));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store), askChatHistory: () => Promise.resolve({ store, askedMarks: [] }) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async () => ({ text: 'synthetic answer', blocks: [] }),
}));

import { StorageError } from '@roadmap/health-core/adapter';
import { ChatSession } from '@roadmap/health-core/chat-session';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import type { RecordHost } from '@roadmap/health-core/record-host';
import { sendMessage as sendWebsite } from './chat-api';
import { sendMessage as sendPages } from './byok-chat';

const SECRET = 'my LDL is 4.2';

/** Let the fire-and-forget save settle. */
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
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
])('US-15 AC47: %s', (_name, send) => {
  it('reports a failed history save with a fixed message and tags, and still answers', async () => {
    store.recordExchange.mockRejectedValueOnce(new Error(`cloud refused the file: ${SECRET}`));
    const { result, error } = await send(SECRET, null, null);
    await settle();
    expect(error).toBeNull();
    expect(result?.content).toBe('synthetic answer');
    expect(store.recordExchange).toHaveBeenCalledOnce();
    expect(sentry.captureException).toHaveBeenCalledOnce();
    const [reported, context] = sentry.captureException.mock.calls[0] as unknown as [Error, { tags: Record<string, string> }];
    expect(reported.message).toBe('Chat-history save failed');
    expect(JSON.stringify([reported.message, context])).not.toContain('4.2');
    expect(context.tags).toEqual({ area: 'chat-history', op: 'save' });
  });

  it('a dropped connection reads as the quiet network message', async () => {
    store.recordExchange.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await send('hello', null, null);
    await settle();
    expect((sentry.captureException.mock.calls[0] as unknown as [Error])[0].message).toBe('Network request did not answer');
  });

  it('US-09 AC2c: a page that may not write this device makes no chat write, so nothing is reported, and the answer still shows', async () => {
    const device = { readSync: vi.fn(() => ({ body: null, version: null })), writeSync: vi.fn(() => ({ version: '1' })) };
    const host = {
      store: new MemoryAdapter(), deviceId: () => 'laptop', clock: { now: () => Date.parse('2026-11-13T10:00:00.000Z') },
      timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
      clearOffFileData: () => {}, tier: 'device', sync: device, clearNamedFiles: () => {}, eraseFence: () => null,
      deviceFilesOpen: () => false,
    } as unknown as RecordHost;
    const session = await ChatSession.open(host);
    store.recordExchange.mockImplementationOnce((...args: unknown[]) => session.recordExchange(args[0] as Parameters<ChatSession['recordExchange']>[0]));
    const { result, error } = await send('hello', null, null);
    await settle();
    expect(error).toBeNull();
    expect(result?.content).toBe('synthetic answer');
    expect(store.recordExchange).toHaveBeenCalledOnce();
    expect(device.readSync).not.toHaveBeenCalled();
    expect(device.writeSync).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('a real device failure (storage full) is still reported once', async () => {
    store.recordExchange.mockRejectedValueOnce(new StorageError('Synthetic storage full'));
    await send('hello', null, null);
    await settle();
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect((sentry.captureException.mock.calls[0] as unknown as [Error])[0].message).toBe('Chat-history save failed');
  });

  it('reports nothing when the save succeeds', async () => {
    await send('hello', null, null);
    await settle();
    expect(store.recordExchange).toHaveBeenCalledOnce();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
