/**
 * US-15 AC65: with the chat system prompt missing, the Discord and YouTube bots
 * do not start, so they make no model call and post nothing. Every other start
 * gate is open here; the control shows the same setup starts with the prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  // Both bots read their config at module load, and both auto-start on import.
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token-good', DISCORD_FORCE_START: 'true', DISCORD_SERVER_ID: 'guild-1', DISCORD_BOT_PROFILE_ID: 'bot-profile',
    YOUTUBE_BOT_CHANNEL_ID: 'synthetic-channel', YOUTUBE_BOT_CLIENT_ID: 'synthetic-client',
    YOUTUBE_BOT_CLIENT_SECRET: 'synthetic-secret', YOUTUBE_BOT_REFRESH_TOKEN: 'synthetic-refresh', YOUTUBE_BOT_FORCE_START: 'true',
  });
  return {
    prompt: { kind: 'missing' } as { kind: 'loaded'; text: string } | { kind: 'missing' },
    clients: 0,
    logins: 0,
  };
});

vi.mock('./chat-system-prompt.server', () => ({ get CHAT_PROMPT() { return state.prompt; } }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: {} }));
vi.mock('discord.js', () => ({
  Client: class {
    constructor() { state.clients++; }
    once() {}
    on() {}
    login() { state.logins++; return Promise.resolve('ok'); }
    destroy() {}
  },
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate', Error: 'error' },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3 },
  Partials: { Message: 1, Channel: 2 },
}));

import { startDiscordBot, stopDiscordBot } from './discord-bot.server';
import { startYouTubeBot, stopYouTubeBot } from './youtube-bot.server';

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stopDiscordBot();
  stopYouTubeBot();
  state.prompt = { kind: 'missing' };
  state.clients = 0;
  state.logins = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const youtubeStarted = () => log.mock.calls.some(([line]) => String(line).startsWith('YouTube bot started'));

describe('US-15 AC65: the bots do not start without the chat system prompt', () => {
  it('missing: neither bot starts, at import or on a later start call', () => {
    startDiscordBot();
    startYouTubeBot();
    expect(state.clients).toBe(0);
    expect(state.logins).toBe(0);
    expect(youtubeStarted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('control: loaded, the same setup starts both bots', () => {
    state.prompt = { kind: 'loaded', text: 'prompt' };
    startDiscordBot();
    startYouTubeBot();
    expect(state.logins).toBe(1);
    expect(youtubeStarted()).toBe(true);
  });
});
