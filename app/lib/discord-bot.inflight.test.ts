import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimsState } from './single-use-claims.test-helpers';

// US-15 AC63: on Discord, a message identical to one still being answered gets
// no second model call and no reply; the first answer arrives anyway. Harness
// as in discord-bot.partial-send.test.ts: a mocked discord.js Client, a
// deferred model fake, no network.
const claims = vi.hoisted(() => ({ state: null as null | ClaimsState }));
const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), capture: vi.fn(), captureMessage: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
vi.mock('discord.js', () => ({
  Client: class {
    user = { id: 'bot' };
    once() {}
    on(event: string, callback: (message: unknown) => void) { edge.listeners.set(event, callback); }
    login() { return Promise.resolve(); }
    destroy() {}
  },
  Events: { MessageCreate: 'message', ClientReady: 'ready', Error: 'error' },
  GatewayIntentBits: {}, Partials: {},
}));
vi.mock('@sentry/react-router', () => ({ captureException: edge.capture, captureMessage: edge.captureMessage }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic', sanitizeForRouter: (s: string) => s }));
vi.mock('./supabase-client.server', async (actual) => {
  const helpers = await import('./single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state) };
});
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: (table: string) => {
    const query = { select: () => query, eq: () => query, gte: () => query,
      order: () => query, limit: () => query, update: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      insert: (row: Record<string, unknown>) => { edge.inserts.push({ table, row }); return query; },
      single: async () => ({ data: { id: 'conv-new' }, error: null }) };
    return query;
  },
} }));

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const QUESTION = 'Synthetic question about sleep';

function makeMessage(id: string) {
  const reply = vi.fn().mockImplementation(async (opts: { content: string }) => ({ id: `reply-${id}`, content: opts.content }));
  const send = vi.fn().mockImplementation(async (opts: { content: string }) => ({ id: `send-${id}`, content: opts.content }));
  return { id, author: { id: 'asker', bot: false }, guild: { id: 'guild' }, system: false,
    content: QUESTION, channelId: 'ai',
    mentions: { everyone: false, users: new Set<string>() },
    channel: { isThread: () => false, isTextBased: () => true, send }, reply, send };
}

async function deliver(message: ReturnType<typeof makeMessage>) {
  edge.listeners.get('message')!(message);
  await settle(); await new Promise((r) => setTimeout(r, 0)); await settle();
}

const completion = { content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
  isFallback: false, routerResult: null, classifier: { classification: 'ANSWER', routerSkipped: true } };

let stop: () => void;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); edge.listeners.clear(); edge.inserts = [];
  const { newClaimsState, resetClaimsState } = await import('./single-use-claims.test-helpers');
  resetClaimsState(claims.state ??= newClaimsState());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: 'blocked',
    SHOPIFY_API_SECRET: 'test-secret-good' })) vi.stubEnv(key, value);
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('US-15 AC63 — Discord: an identical message while the first is answering', () => {
  it('gets one model call, no reply to the second message, and one stored turn', async () => {
    let answer!: () => void;
    edge.complete.mockImplementation(() => new Promise((resolve) => { answer = () => resolve(completion); }));
    const first = makeMessage('m1');
    await deliver(first);
    expect(edge.complete).toHaveBeenCalledTimes(1);
    // Past the 3 s per-user cooldown, so only the claim stands in the way.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 4_000);
    const second = makeMessage('m2');
    await deliver(second);
    expect(edge.complete).toHaveBeenCalledTimes(1);
    expect(second.reply).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
    answer();
    await settle(); await new Promise((r) => setTimeout(r, 0)); await settle();
    expect(first.reply).toHaveBeenCalledTimes(1);
    expect(edge.inserts.filter((i) => i.table === 'chat_messages' && i.row.role === 'user')).toHaveLength(1);
    expect(edge.captureMessage).toHaveBeenCalledWith('chat: turn already running',
      expect.objectContaining({ tags: expect.objectContaining({ platform: 'discord' }) }));
    // Released at the end: the claim row is gone.
    await vi.waitFor(() => expect(claims.state!.rows.size).toBe(0));
  });
});
