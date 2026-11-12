/**
 * US-11 AC2h: a chat reply is saved to chat history only if no erase began
 * after its question was asked. Through the real save path: the page's data
 * layer on an in-memory cloud, its chat-history session, and both chat
 * transports (the website chat and the Pages chat). Only the replies are
 * synthetic: no network, no provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { deleteUserData, flushRoadmapStore, initRoadmapStore } from './roadmap-data';
import { getChatHistory } from './chat-history-access';

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('./server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server-api')>()),
  trackProductEvent: vi.fn(),
}));

/** The reply each transport is waiting on: resolved by the test. */
const reply = vi.hoisted(() => ({ release: () => {}, gate: Promise.resolve(), fail: null as Error | null }));
function holdReply(): void {
  reply.gate = new Promise<void>((resolve) => { reply.release = resolve; });
}
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async () => {
    await reply.gate;
    if (reply.fail) throw reply.fail;
    return { text: 'synthetic answer', blocks: [] };
  },
}));

import { sendMessage as sendWebsite } from './chat-api';
import { sendMessage as sendPages } from './byok-chat';
import * as Sentry from '@sentry/react';

const CHAT_FILE = 'chat-history.json';
const QUESTION = 'zz-erase-marker question';

/** Let the fire-and-forget save and its cloud write settle. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let cloud: MemoryCloud;
let chatWrites: string[];

beforeEach(async () => {
  holdReply();
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  // The page's cloud, remembered as connect.ts does: the erase is this tab's to make (US-11 AC6).
  const keys = new Map([['hr_anthropic_key', 'sk-ant-synthetic'], ['health_roadmap_backend', 'memory']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => keys.get(k) ?? null,
    setItem: (k: string, v: string) => void keys.set(k, v),
    removeItem: (k: string) => void keys.delete(k),
    key: (i: number) => [...keys.keys()][i] ?? null,
    get length() { return keys.size; },
    clear: () => keys.clear(),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).includes('/api/chat')) throw new Error('only the chat goes over HTTP');
    await reply.gate;
    if (reply.fail) throw reply.fail;
    return new Response(
      JSON.stringify({ success: true, conversationId: 'server-c1', messageId: null, content: 'synthetic answer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }));
  chatWrites = [];
  const write = MemoryAdapter.prototype.write;
  vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(function (this: MemoryAdapter, fileName, body, ...rest) {
    if (fileName === CHAT_FILE) chatWrites.push(JSON.stringify(body));
    return write.call(this, fileName, body, ...rest);
  });
  cloud = new MemoryCloud();
  await initRoadmapStore(new MemoryAdapter(cloud));
});

afterEach(async () => {
  reply.fail = null;
  reply.release();
  await flushRoadmapStore().catch(() => {});
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Every place the question could be kept: this page's history, the cloud uploads, this device's storage, and a reload. */
async function questionKept() {
  const page = (await getChatHistory())!.listConversations();
  const device = Object.keys(localStorage).length === 0 ? '' : JSON.stringify(
    Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)),
  );
  await initRoadmapStore(new MemoryAdapter(cloud)); // a fresh page
  const reloaded = (await getChatHistory())!.listConversations();
  return {
    page: page.filter((c) => c.title.includes(QUESTION)).length,
    uploaded: chatWrites.filter((w) => w.includes(QUESTION)).length,
    device: device.includes(QUESTION),
    reloaded: reloaded.filter((c) => c.title.includes(QUESTION)).length,
  };
}
const NOTHING = { page: 0, uploaded: 0, device: false, reloaded: 0 };

describe.each([
  ['website chat (chat-api)', sendWebsite],
  ['Pages chat (byok-chat)', sendPages],
])('US-11 AC2h: %s saves a reply only under the erase it began under', (_name, send) => {
  it('a reply that lands after an erase begun while it was asked is not saved', async () => {
    const sent = send(QUESTION, null, null);
    await settle();
    const erase = await deleteUserData();
    expect(erase.success).toBe(true);
    reply.release();
    expect((await sent).result?.content).toBe('synthetic answer');
    await settle();
    expect(await questionKept()).toEqual(NOTHING);
  });

  it('a reply that lands while the erase is still running is not saved', async () => {
    await getChatHistory(); // the chat panel has listed the conversations
    const sent = send(QUESTION, null, null);
    await settle();
    // The reply lands while the erase reads the chat file, before the record moves.
    const read = MemoryAdapter.prototype.read;
    let landed = false;
    vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementation(async function (this: MemoryAdapter, fileName, signal) {
      if (fileName === CHAT_FILE && !landed) {
        landed = true;
        reply.release();
        await sent;
        await settle();
      }
      return read.call(this, fileName, signal);
    });
    expect((await deleteUserData()).success).toBe(true);
    expect(landed).toBe(true);
    await settle();
    expect(await questionKept()).toEqual(NOTHING);
  });

  it('a reply whose save is pending when an erase begins is not kept', async () => {
    // Hold the chat-history write that carries the question until the erase has begun.
    let releaseWrite = () => {};
    const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writeReached = () => {};
    const reached = new Promise<void>((resolve) => { writeReached = resolve; });
    const write = vi.mocked(MemoryAdapter.prototype.write).getMockImplementation()!;
    vi.mocked(MemoryAdapter.prototype.write).mockImplementation(async function (this: MemoryAdapter, fileName, body, ...rest) {
      if (fileName === CHAT_FILE && JSON.stringify(body).includes(QUESTION)) {
        writeReached();
        await writeHeld;
      }
      return write.call(this, fileName, body, ...rest);
    });
    const sent = send(QUESTION, null, null);
    reply.release();
    expect((await sent).error).toBeNull();
    await reached; // the reply landed with no erase yet, and its save is under way
    const erase = deleteUserData();
    await settle();
    releaseWrite();
    expect((await erase).success).toBe(true);
    await settle();
    const page = (await getChatHistory())!.listConversations();
    expect(page.filter((c) => c.title.includes(QUESTION))).toHaveLength(0);
    expect(chatWrites.at(-1)).not.toContain(QUESTION);
    await initRoadmapStore(new MemoryAdapter(cloud)); // a fresh page
    const reloaded = (await getChatHistory())!.listConversations();
    expect(reloaded.filter((c) => c.title.includes(QUESTION))).toHaveLength(0);
  });

  it('a reply with no erase in between is saved', async () => {
    const sent = send(QUESTION, null, null);
    reply.release();
    expect((await sent).error).toBeNull();
    await settle();
    const kept = await questionKept();
    expect(kept.page).toBe(1);
    expect(kept.uploaded).toBeGreaterThan(0);
    expect(kept.reloaded).toBe(1);
  });
});

describe.each([
  ['website chat (chat-api)', sendWebsite],
  ['Pages chat (byok-chat)', sendPages],
])('US-15 AC47: %s reports a failed send without its text', (_name, send) => {
  it('neither the error nor its cause reaches the console or Sentry', async () => {
    const MARKER = 'zz-send-marker';
    reply.fail = Object.assign(new Error(`send failed for ${MARKER}`), { cause: new Error(`cause ${MARKER}`) });
    reply.release();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { result, error } = await send('a question', null, null);
    expect(result).toBeNull();
    expect(error?.error).toMatch(/Network error/);
    const captured = vi.mocked(Sentry.captureException).mock.calls;
    expect(captured).toHaveLength(1);
    const [reported, context] = captured[0] as unknown as [Error, { tags: Record<string, string> }];
    expect(reported.message).toBe('Chat send failed');
    expect('cause' in reported).toBe(false);
    expect(context.tags).toEqual({ feature: 'chat', kind: 'send' });
    const printed = spies.flatMap((s) => s.mock.calls);
    expect(printed).toEqual([['Chat send failed']]);
    const all = [...printed, ...captured, ...vi.mocked(Sentry.captureMessage).mock.calls];
    const seen = all.flat().map((x) => (x instanceof Error ? `${x.message} ${String((x as { cause?: unknown }).cause)}` : JSON.stringify(x))).join(' ');
    expect(seen).not.toContain(MARKER);
  });
});
