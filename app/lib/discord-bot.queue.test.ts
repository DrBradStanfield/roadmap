import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), sleep: vi.fn(), capture: vi.fn(),
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
vi.mock('@sentry/react-router', () => ({ captureException: edge.capture, captureMessage: vi.fn() }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: vi.fn(), generateTitle: vi.fn(), CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic' }));
vi.mock('./cron-helpers.server', () => ({ sleep: edge.sleep }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: () => {
    const query = { select: () => query, eq: () => query, gte: () => query,
      order: () => query, limit: () => query, maybeSingle: async () => ({ data: null, error: null }),
      insert: () => query, single: async () => ({ data: null, error: null }) };
    return query;
  },
} }));

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function message(id: string, channelId = 'ai', mentioned = false) {
  return { id, author: { id, bot: false }, guild: { id: 'guild' }, system: false,
    content: 'Synthetic question', channelId,
    mentions: { everyone: false, users: new Set(mentioned ? ['bot'] : []) },
    channel: { isThread: () => false, isTextBased: () => false },
    reply: vi.fn().mockResolvedValue({ id: `reply-${id}` }),
  };
}
let stop: () => void;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); edge.listeners.clear();
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: 'blocked' })) vi.stubEnv(key, value);
  edge.sleep.mockImplementation((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

// US-15: supported Discord message event, with only Discord/provider edges mocked.
it('bounds aggregate waiting at ten behind three active calls, then recovers after success and error', async () => {
  const held: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  let active = 0, peak = 0;
  edge.complete.mockImplementation(() => {
    active++; peak = Math.max(peak, active);
    return new Promise((resolve, reject) => held.push({ resolve, reject })).finally(() => active--);
  });
  const send = (m: ReturnType<typeof message>) => edge.listeners.get('message')!(m);
  const arrivals = Array.from({ length: 14 }, (_, i) => message(`user-${i}`));
  arrivals.forEach(send); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(3);
  expect(arrivals[13].reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Busy helping') }));
  expect(arrivals.slice(0, 13).every(m => m.reply.mock.calls.length === 0)).toBe(true);
  // Rejection does not reserve a waiting slot, even when sending the refusal fails.
  const refused = message('refused'); refused.reply.mockRejectedValue(new Error('synthetic send failure'));
  send(refused); await settle();
  const result = { content: 'Synthetic answer', usage: {}, isFallback: false, routerResult: null,
    classifier: { classification: 'SKIP', routerSkipped: true } };
  held[0].reject(new Error('synthetic provider failure'));
  held[1].resolve(result); held[2].resolve(result); await settle();
  await vi.advanceTimersByTimeAsync(200); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(6);
  const replacement = message('replacement'); send(replacement); await settle();
  expect(replacement.reply).not.toHaveBeenCalled();
  for (let round = 0; round < 6; round++) {
    held.splice(0).forEach(call => call.resolve(result)); await settle();
    await vi.advanceTimersByTimeAsync(200); await settle();
  }
  expect(edge.complete).toHaveBeenCalledTimes(14);
  expect(peak).toBe(3);
  expect(replacement.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Synthetic answer') }));
  const fresh = message('fresh'); send(fresh); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(15);
  held.splice(0).forEach(call => call.resolve(result)); await settle();
});

it('preserves excluded-channel, mention eligibility, cooldown and hourly limits', async () => {
  edge.complete.mockRejectedValue(new Error('synthetic provider failure'));
  const send = (m: ReturnType<typeof message>) => edge.listeners.get('message')!(m);
  send(message('blocked-user', 'blocked', true)); send(message('unmentioned', 'other'));
  await settle(); expect(edge.complete).not.toHaveBeenCalled();
  send(message('limited', 'other', true)); await settle();
  send(message('limited')); await settle(); expect(edge.complete).toHaveBeenCalledTimes(1);
  for (let i = 1; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(3001); send(message('limited')); await settle();
  }
  expect(edge.complete).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(3001);
  const over = message('limited'); send(over); await settle();
  expect(edge.complete).toHaveBeenCalledTimes(10);
  expect(over.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('bit quickly') }));
});


it('returns a waiting reservation if the polling wait rejects', async () => {
  const releases: Array<() => void> = [];
  edge.complete.mockImplementation(() => new Promise((_resolve, reject) => releases.push(() => reject(new Error('synthetic failure')))));
  const send = (m: ReturnType<typeof message>) => edge.listeners.get('message')!(m);
  for (let i = 0; i < 3; i++) send(message(`active-${i}`));
  await settle();
  edge.sleep.mockRejectedValueOnce(new Error('synthetic wait failure'));
  send(message('failed-wait')); await settle();
  expect(edge.capture).toHaveBeenCalled();
  const waiting = Array.from({ length: 10 }, (_, i) => message(`waiting-${i}`));
  waiting.forEach(send); await settle();
  expect(waiting.every(m => m.reply.mock.calls.length === 0)).toBe(true);
  const over = message('queue-full'); send(over); await settle();
  expect(over.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Busy helping') }));
  for (let round = 0; round < 5; round++) {
    releases.splice(0).forEach(release => release()); await settle();
    await vi.advanceTimersByTimeAsync(200); await settle();
  }
  expect(edge.complete).toHaveBeenCalledTimes(13);
});
