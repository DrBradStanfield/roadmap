/**
 * US-63 AC12: the health bot stays silent in an excluded channel's threads,
 * not only in the channel itself. `DISCORD_EXCLUDED_CHANNEL_IDS` was checked
 * against `message.channelId`, which for a message in a thread is the thread's
 * own id, so an @mention in a thread under an excluded channel (the US-63 agent
 * channel, say) was answered.
 *
 * Drives the real message handler with only the Discord client and the
 * provider mocked, as discord-bot.queue.test.ts does.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(),
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
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: vi.fn(), generateTitle: vi.fn(), CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic' }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: () => {
    const query = { select: () => query, eq: () => query, gte: () => query,
      order: () => query, limit: () => query, maybeSingle: async () => ({ data: null, error: null }),
      insert: () => query, single: async () => ({ data: null, error: null }) };
    return query;
  },
} }));

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** A message mentioning the bot. In a thread, `channelId` is the thread's id and
 *  `parentId` the channel it hangs off; a plain channel's `parentId` is its category. */
function mention(id: string, where: { channelId: string; parentId: string | null; thread: boolean }) {
  return { id, author: { id, bot: false }, guild: { id: 'guild' }, system: false,
    content: 'Synthetic question', channelId: where.channelId,
    mentions: { everyone: false, users: new Set(['bot']) },
    channel: { isThread: () => where.thread, isTextBased: () => false, parentId: where.parentId,
      messages: { fetch: async () => new Map() } },
    reply: vi.fn().mockResolvedValue({ id: `reply-${id}` }),
  };
}
const send = (m: ReturnType<typeof mention>) => edge.listeners.get('message')!(m);

let stop: () => void;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); edge.listeners.clear();
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: 'agents, blocked' })) vi.stubEnv(key, value);
  edge.complete.mockResolvedValue({ content: 'Synthetic answer', usage: {}, isFallback: false, routerResult: null,
    classifier: { classification: 'SKIP', routerSkipped: true } });
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('an @mention in a thread under an excluded channel gets no answer', async () => {
  const inThread = mention('u1', { channelId: 'thread-1', parentId: 'agents', thread: true });
  const inOtherThread = mention('u2', { channelId: 'thread-2', parentId: 'blocked', thread: true });
  send(inThread); send(inOtherThread); await settle();
  expect(edge.complete).not.toHaveBeenCalled();
  expect(inThread.reply).not.toHaveBeenCalled();
  expect(inOtherThread.reply).not.toHaveBeenCalled();
});

it('control: an @mention in the excluded channel itself gets no answer, as before', async () => {
  const inChannel = mention('u1', { channelId: 'agents', parentId: 'category-1', thread: false });
  send(inChannel); await settle();
  expect(edge.complete).not.toHaveBeenCalled();
});

it('control: an @mention in a thread under any other channel is answered', async () => {
  const inThread = mention('u1', { channelId: 'thread-3', parentId: 'general', thread: true });
  send(inThread); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(1);
  expect(inThread.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Synthetic answer') }));
});

it('control: a plain channel whose category id is listed is not excluded by it', async () => {
  // A text channel's parentId is its category: only a thread's parent counts.
  vi.stubEnv('DISCORD_EXCLUDED_CHANNEL_IDS', 'category-9');
  vi.resetModules(); edge.listeners.clear(); stop();
  stop = (await import('./discord-bot.server')).stopDiscordBot;
  const inChannel = mention('u1', { channelId: 'general', parentId: 'category-9', thread: false });
  send(inChannel); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(1);
});
