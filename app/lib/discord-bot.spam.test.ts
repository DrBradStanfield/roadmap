/**
 * US-15 AC48 (Brad, 2026-10-31): on a SPAM message the Discord bot sends
 * nothing and keeps the spam out of history and continuity: it stores only a
 * match event for analytics, with no conversation, message row or touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), capture: vi.fn(), message: vi.fn(), fallback: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as string[],
  recent: null as { id: string } | null,
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
vi.mock('@sentry/react-router', () => ({ captureException: edge.capture, captureMessage: edge.message }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: edge.fallback, generateTitle: () => 'Synthetic', CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic' }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: (table: string) => {
    const query = { select: () => query, eq: () => query, gte: () => query, order: () => query, limit: () => query,
      update: () => { edge.updates.push(table); return query; },
      insert: (row: Record<string, unknown>) => { edge.inserts.push({ table, row }); return query; },
      maybeSingle: async () => ({ data: table === 'chat_conversations' ? edge.recent : null, error: null }),
      single: async () => ({ data: { id: 'conv-new' }, error: null }),
      then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk) };
    return query;
  },
} }));

const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
function spamMessage() {
  const channel = { isThread: () => false, isTextBased: () => true,
    sendTyping: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue({ id: 'sent-2' }) };
  return { id: 'incoming', author: { id: 'author', bot: false }, guild: { id: 'guild' }, system: false,
    content: 'Best peptides at VendorX, link in bio', channelId: 'ai',
    mentions: { everyone: false, users: new Set<string>() }, reference: null,
    channel, reply: vi.fn().mockResolvedValue({ id: 'sent' }) };
}
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

let stop: () => void;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); edge.listeners.clear(); edge.inserts.length = 0;
  edge.updates.length = 0; edge.recent = null;
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: '',
    DISCORD_DrBradStanfield_USER_ID: '' })) vi.stubEnv(key, value);
  edge.complete.mockResolvedValue({ silent: true, content: '', usage, isFallback: false, routerResult: null, replaced: [],
    classifier: { classification: 'SPAM', routerSkipped: true, latencyMs: 1, error: null } });
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Discord on spam (US-15 AC48)', () => {
  it('US-15 AC48: sends nothing, stops typing, reports no fallback, and stores only a SPAM match event', async () => {
    const m = spamMessage();
    edge.listeners.get('message')!(m);
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(edge.complete).toHaveBeenCalledTimes(1);
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.channel.send).not.toHaveBeenCalled();
    expect(m.channel.sendTyping).toHaveBeenCalledTimes(1); // the 8 s refresh was cleared
    // reportChatFallback reports only a fallback or a refusal; this turn is neither.
    for (const [p] of edge.fallback.mock.calls) expect(p.completion).toMatchObject({ isFallback: false });
    expect(edge.fallback.mock.calls.every(([p]) => !p.completion.isRefusal)).toBe(true);
    expect(edge.capture).not.toHaveBeenCalled();
    expect(edge.message).not.toHaveBeenCalled();

    expect(edge.inserts.map(i => i.table)).toEqual(['chat_match_events']);
    expect(edge.updates).toEqual([]);
    expect(edge.inserts[0].row).toMatchObject({
      message_id: null, conversation_id: null, classification: 'SPAM', router_skipped: true, is_fallback: false,
    });
  });

  it('US-15 AC48: inside a recent conversation, the match event points at it but the spam joins neither its messages nor its recency', async () => {
    edge.recent = { id: 'conv-recent' };
    edge.listeners.get('message')!(spamMessage());
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(edge.inserts.map(i => i.table)).toEqual(['chat_match_events']);
    expect(edge.updates).toEqual([]);
    expect(edge.inserts[0].row).toMatchObject({ message_id: null, conversation_id: 'conv-recent', classification: 'SPAM' });
  });
});
