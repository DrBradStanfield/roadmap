/**
 * US-11 AC2h across devices: a reply that starts a conversation is not saved
 * when another device erased after its question was asked, even before this
 * page has read that device's erase in the record. Two pages on one in-memory
 * cloud: page B is this module graph, device A a second one loaded fresh.
 * Through both chat transports; only the replies are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { flushRoadmapStore, initRoadmapStore } from './roadmap-data';
import { getChatHistory } from './chat-history-access';

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('./server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server-api')>()),
  trackProductEvent: vi.fn(),
}));

const reply = vi.hoisted(() => ({ release: () => {}, gate: Promise.resolve() }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async () => {
    await reply.gate;
    return { text: 'synthetic answer', blocks: [] };
  },
}));

import { sendMessage as sendWebsite } from './chat-api';
import { sendMessage as sendPages } from './byok-chat';

const CHAT_FILE = 'chat-history.json';
const QUESTION = 'zz-erase-marker question';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let cloud: MemoryCloud;

beforeEach(async () => {
  reply.gate = new Promise<void>((resolve) => { reply.release = resolve; });
  // No live refresh: page B never reads device A's erase in the record.
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  const keys = new Map([['hr_anthropic_key', 'sk-ant-synthetic']]);
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
    return new Response(
      JSON.stringify({ success: true, conversationId: 'server-c1', messageId: null, content: 'synthetic answer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }));
  cloud = new MemoryCloud();
  await initRoadmapStore(new MemoryAdapter(cloud));
});

afterEach(async () => {
  reply.release();
  await flushRoadmapStore().catch(() => {});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Device A: a second page's data layer on the same cloud, loaded fresh. */
async function deviceA() {
  vi.resetModules();
  const data = await import('./roadmap-data');
  const access = await import('./chat-history-access');
  const { MemoryAdapter: Adapter } = await import('@roadmap/health-core/memory-adapter');
  const { RoadmapStore: Store } = await import('../storage/roadmap-store');
  vi.spyOn(Store.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  await data.initRoadmapStore(new Adapter(cloud));
  return { deleteUserData: data.deleteUserData, list: async () => (await access.getChatHistory())!.listConversations() };
}

const liveInCloud = () => {
  const file = JSON.parse(cloud.files.get(CHAT_FILE)?.json ?? '{"conversations":[]}') as { conversations: Array<{ deleted?: boolean }> };
  return file.conversations.filter((c) => !c.deleted);
};

describe.each([
  ['website chat (chat-api)', sendWebsite],
  ['Pages chat (byok-chat)', sendPages],
])('US-11 AC2h: %s, another device erases while a first question is asked', (_name, send) => {
  it('the reply is not saved, listed or uploaded on either device', async () => {
    const sent = send(QUESTION, null, null);
    await settle(); // B's chat history is open; the question is on its way
    const a = await deviceA();
    expect((await a.deleteUserData()).success).toBe(true);
    reply.release();
    expect((await sent).result?.content).toBe('synthetic answer');
    await settle();

    expect((await getChatHistory())!.listConversations()).toEqual([]);
    expect(liveInCloud()).toEqual([]);
    expect(cloud.files.get(CHAT_FILE)!.json).not.toContain(QUESTION);
    expect(await (await deviceA()).list()).toEqual([]); // device A, reloaded
    await initRoadmapStore(new MemoryAdapter(cloud)); // page B, reloaded
    expect((await getChatHistory())!.listConversations()).toEqual([]);
  });

  it('with no erase, the reply is saved', async () => {
    const sent = send(QUESTION, null, null);
    reply.release();
    expect((await sent).error).toBeNull();
    await settle();
    expect(liveInCloud()).toHaveLength(1);
    expect(await (await deviceA()).list()).toHaveLength(1);
  });
});

describe.each([
  ['website chat (chat-api)', sendWebsite],
  ['Pages chat (byok-chat)', sendPages],
])('US-11 AC2h: %s, a page whose chat history is already open', (_name, send) => {
  it('takes the erase marks at once when the question is asked', async () => {
    const store = (await getChatHistory())!;
    store.listConversations();
    const marks = vi.spyOn(store, 'eraseMarks');
    const sent = send(QUESTION, null, null);
    expect(marks).toHaveBeenCalledTimes(1); // before the send yields
    reply.release();
    await sent;
  });

  it('a follow-up in a thread this page does not hold is not saved after another device erases', async () => {
    (await getChatHistory())!.listConversations();
    const sent = send(QUESTION, 'server-c1', null);
    await settle();
    const a = await deviceA();
    expect((await a.deleteUserData()).success).toBe(true);
    reply.release();
    expect((await sent).result?.content).toBe('synthetic answer');
    await settle();
    expect(liveInCloud()).toEqual([]);
    expect(cloud.files.get(CHAT_FILE)!.json).not.toContain(QUESTION);
    expect((await getChatHistory())!.listConversations()).toEqual([]);
  });

  it('with no erase, that follow-up is saved', async () => {
    (await getChatHistory())!.listConversations();
    const sent = send(QUESTION, 'server-c1', null);
    reply.release();
    expect((await sent).error).toBeNull();
    await settle();
    expect(liveInCloud()).toHaveLength(1);
  });
});

describe('US-11 AC2h: website chat, a guest whose thread is gone', () => {
  it('the retry in a new thread is saved only under the marks taken at the first ask', async () => {
    const store = (await getChatHistory())!;
    store.listConversations();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (calls++ === 0) {
        // Another device erases, and this page reads its mark, before the retry.
        expect((await (await deviceA()).deleteUserData()).success).toBe(true);
        await store.reload();
        return new Response(JSON.stringify({ success: false, error: 'Conversation not found', isGuest: true, sessionToken: 'test-token-guest' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, conversationId: 'server-c2', messageId: null, content: 'synthetic answer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    expect((await sendWebsite(QUESTION, 'server-c1', null)).result?.content).toBe('synthetic answer');
    expect(calls).toBe(2);
    await settle();
    expect(liveInCloud()).toEqual([]);
    expect(cloud.files.get(CHAT_FILE)!.json).not.toContain(QUESTION);
  });
});
