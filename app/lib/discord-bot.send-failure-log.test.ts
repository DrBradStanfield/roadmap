import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { format } from 'node:util';
import { DiscordAPIError } from '@discordjs/rest';

// US-09 AC6d: a failed Discord send never writes the reply to the host log.
// discord.js keeps the body it sent on DiscordAPIError.requestBody, and
// console.error prints an error's own properties, so logging the error object
// put the answer (and the asker's <@id> mention) in the Fly log.
const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), sleep: vi.fn(), capture: vi.fn(), duplicate: vi.fn(),
  conversation: null as { id: string } | null,
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
vi.mock('./chat-dedup.server', () => ({ findDuplicateReply: edge.duplicate }));
vi.mock('./cron-helpers.server', () => ({ sleep: edge.sleep }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: () => {
    const query = { select: () => query, eq: () => query, gte: () => query,
      order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: edge.conversation, error: null }),
      then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      insert: () => query, single: async () => ({ data: null, error: null }) };
    return query;
  },
} }));

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ANSWER = 'An LDL of 4.9 mmol/L on rosuvastatin 20 mg is above target';

function failingMessage(id: string, kind: 'discord' | 'plain') {
  const reply = vi.fn().mockImplementation(async (opts: { content: string }) => {
    if (kind === 'plain') throw new Error('Missing Permissions');
    // What discord.js REST throws on a 403 (Missing Permissions), body included.
    throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST',
      'https://discord.com/api/v10/channels/1/messages', { body: { content: opts.content } });
  });
  return { id, author: { id, bot: false }, guild: { id: 'guild' }, system: false,
    content: 'Synthetic question', channelId: 'ai',
    mentions: { everyone: false, users: new Set<string>() },
    channel: { isThread: () => false, isTextBased: () => false },
    reply };
}

async function deliver(message: ReturnType<typeof failingMessage>) {
  edge.listeners.get('message')!(message);
  // The 50 ms wait is a margin for any timer or I/O hop the handler may gain;
  // the microtask drain alone settles it today.
  await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
}

let stop: () => void;
let logged: string[];
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); edge.listeners.clear(); logged = [];
  edge.conversation = null;
  edge.duplicate.mockReturnValue(null);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(format(...args)); });
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: 'blocked' })) vi.stubEnv(key, value);
  edge.sleep.mockResolvedValue(undefined);
  edge.complete.mockResolvedValue({ content: ANSWER, usage: {}, isFallback: false, routerResult: null,
    classifier: { classification: 'ANSWER', routerSkipped: true } });
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('US-09 AC6d: a failed Discord send logs the error kind, never the reply', () => {
  it('a failed answer logs name, code and status, not the reply or the asker id', async () => {
    await deliver(failingMessage('u1', 'discord'));
    const log = logged.join('\n');
    expect(log).not.toContain('4.9 mmol/L');
    expect(log).not.toContain('<@u1>');
    expect(log).toContain('Discord handleMessage error: DiscordAPIError[50013] 50013 403');
    // Sentry keeps the error itself; its scrub runs there.
    expect(edge.capture).toHaveBeenCalledWith(expect.any(DiscordAPIError), expect.anything());
  });

  it('a failed duplicate re-send logs the same way', async () => {
    edge.conversation = { id: 'conv-1' };
    edge.duplicate.mockReturnValue({ content: ANSWER, ageMs: 1000 });
    const m = failingMessage('u3', 'discord');
    await deliver(m);
    expect(m.reply).toHaveBeenCalled();
    expect(edge.complete).not.toHaveBeenCalled();
    const log = logged.join('\n');
    expect(log).not.toContain('4.9 mmol/L');
    expect(log).not.toContain('<@u3>');
    expect(log).toContain('Discord: dedup re-send failed: DiscordAPIError[50013] 50013 403');
  });

  it('a plain error logs its name, not its message', async () => {
    await deliver(failingMessage('u2', 'plain'));
    const log = logged.join('\n');
    expect(log).toContain('Discord handleMessage error: Error');
    expect(log).not.toContain('Missing Permissions');
    expect(log).not.toContain('4.9 mmol/L');
  });
});
