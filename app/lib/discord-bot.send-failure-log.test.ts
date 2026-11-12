import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { format, inspect } from 'node:util';
import { DiscordAPIError } from '@discordjs/rest';

// US-09 AC6d: a failed Discord send never writes the reply to the host log.
// discord.js keeps the body it sent on DiscordAPIError.requestBody, and
// console.error prints an error's own properties, so logging the error object
// put the answer (and the asker's <@id> mention) in the Fly log.
const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), sleep: vi.fn(), capture: vi.fn(), captureMessage: vi.fn(), duplicate: vi.fn(),
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
vi.mock('@sentry/react-router', () => ({ captureException: edge.capture, captureMessage: edge.captureMessage }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: vi.fn(), generateTitle: vi.fn(), CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic', sanitizeForRouter: (s: string) => s }));
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

// Every argument of every Sentry call, serialized deep.
const sentryText = () => inspect([edge.capture.mock.calls, edge.captureMessage.mock.calls], { depth: null, showHidden: true });

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
    expect(log).toContain('Discord: chunk send failed: DiscordAPIError[50013] 50013 403');
    // Sentry gets fixed words and the Discord code, never the error object,
    // whose requestBody holds the reply (US-15 AC62).
    expect(sentryText()).not.toContain('4.9 mmol/L');
    expect(sentryText()).not.toContain('<@u1>');
    expect(edge.captureMessage).toHaveBeenCalledWith('Discord: chunk send failed',
      expect.objectContaining({ tags: expect.objectContaining({ code: '50013' }) }));
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
    // US-15 AC62: the re-send goes through the same sendChunks as the answer.
    expect(log).toContain('Discord: chunk send failed: DiscordAPIError[50013] 50013 403');
    expect(sentryText()).not.toContain('4.9 mmol/L');
    expect(sentryText()).not.toContain('<@u3>');
  });

  it('a plain error logs its name, not its message', async () => {
    await deliver(failingMessage('u2', 'plain'));
    const log = logged.join('\n');
    expect(log).toContain('Discord: chunk send failed: Error');
    expect(log).not.toContain('Missing Permissions');
    expect(log).not.toContain('4.9 mmol/L');
    expect(sentryText()).not.toContain('4.9 mmol/L');
    expect(sentryText()).not.toContain('Missing Permissions');
  });
});

// H47 (US-15 AC62, US-09 AC6d): the message handler's outer catch sends Sentry
// a stand-in error with its own stack, fixed words, a shaped tag and the stage
// the handler had reached. No part of the original error leaves: a model or
// history error can carry the question or a request body in its message, its
// stack, its cause or its own properties, and a frame it names would be read
// from disk by Sentry's ContextLines.
describe('US-15 AC62: the outer catch reaches Sentry as fixed words, its own stack and a stage', () => {
  const SENTINEL = 'zz-sentinel-question-text';
  function okMessage(id: string) {
    const reply = vi.fn().mockResolvedValue({ id: `r-${id}` });
    return { ...failingMessage(id, 'plain'), reply };
  }
  // The one captured error and its options.
  const captured = () => {
    expect(edge.capture).toHaveBeenCalledTimes(1);
    const [error, options] = edge.capture.mock.calls[0] as [Error, Record<string, unknown>];
    return { error, options };
  };

  it('a model error whose message, cause and body hold text never reaches Sentry or the log', async () => {
    const err = Object.assign(new Error(`model said ${SENTINEL}`, { cause: new Error(`body ${SENTINEL}`) }),
      { requestBody: { json: { messages: [{ content: SENTINEL }] } } });
    edge.complete.mockRejectedValue(err);
    const m = okMessage('u4');
    await deliver(m);
    expect(sentryText()).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
    const { error, options } = captured();
    expect(error).not.toBe(err);
    expect(error.message).toBe('Discord: handleMessage failed');
    expect(error.name).toBe('DiscordHandleError');
    // Nothing for LinkedErrors to follow, and nothing copied over.
    expect(error.cause).toBeUndefined();
    expect('errors' in error).toBe(false);
    expect(Object.keys(error)).toEqual([]);
    expect(options).toEqual({ level: 'error', fingerprint: ['discord-handle', 'Error', 'ask'],
      tags: { platform: 'discord', subsystem: 'handle', code: 'Error', stage: 'ask' } });
    // The person still gets the same error line.
    expect(m.reply).toHaveBeenLastCalledWith(expect.objectContaining(
      { content: 'Something went wrong on my end. Please try again in a moment.' }));
  });

  it("no part of the error's stack is sent: frame-shaped prose, a file frame and a CJK frame", async () => {
    const err = new Error('upstream failed');
    err.stack = ['Error: upstream failed',
      '    at rosuvastatin_20mg (/request:1:2)',
      '    at x (/proc/self/environ:1:1)',
      '    at \u8a3a\u65ad\u7d50\u679c (/app/build/server/zz-real-looking.js:10:5)',
      '    at handler (/app/build/server/zz-real-looking.js:12:7)'].join('\n');
    edge.complete.mockRejectedValue(err);
    await deliver(okMessage('u7'));
    const text = sentryText();
    for (const part of ['upstream', 'rosuvastatin', '/request', 'environ', '\u8a3a\u65ad', 'zz-real-looking']) {
      expect(text).not.toContain(part);
    }
    // Its own stack: the header, then frames in our code, the catch among them.
    const { stack } = captured().error;
    expect(stack).toMatch(/^DiscordHandleError: Discord: handleMessage failed\n {4}at /);
    expect(stack).toMatch(/at .*discord-bot\.server\.ts:\d+:\d+/);
  });

  it('a failure at two stages gives two stage tags and fingerprints', async () => {
    edge.complete.mockImplementation(() => (null as unknown as { x: { y: number } }).x.y);
    await deliver(okMessage('u9'));
    expect(captured().options).toMatchObject({ fingerprint: ['discord-handle', 'TypeError', 'ask'], tags: { stage: 'ask' } });
    expect(captured().error.stack).not.toContain('Cannot read');

    edge.capture.mockClear();
    // An answer with no content fails where it is split for sending.
    edge.complete.mockResolvedValue({ content: undefined, usage: {}, isFallback: false, routerResult: null,
      classifier: { classification: 'ANSWER', routerSkipped: true } });
    await deliver(okMessage('u10'));
    expect(captured().options).toMatchObject({ fingerprint: ['discord-handle', 'TypeError', 'send'], tags: { stage: 'send' } });
  });

  it('a free-text code becomes the placeholder tag in the outer catch', async () => {
    edge.complete.mockRejectedValue(Object.assign(new Error('x'), { code: `bad code ${SENTINEL}` }));
    await deliver(okMessage('u5'));
    expect(sentryText()).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
    expect(logged.join('\n')).toContain('Discord handleMessage error: Error unknown');
    expect(captured().options).toMatchObject({ fingerprint: ['discord-handle', 'unknown', 'ask'], tags: { code: 'unknown' } });
  });
});

describe('US-09 AC6d: errorKind keeps only shaped parts', () => {
  it.each([
    ['a free-text name becomes unknown', { name: 'zz name with words', code: 50013, status: 403 }, 'unknown 50013 403'],
    ['a string status is dropped', { name: 'TypeError', status: 'zz status words' }, 'TypeError'],
    ['a Discord error keeps name, code and status', { name: 'DiscordAPIError[50013]', code: 50013, status: 403 }, 'DiscordAPIError[50013] 50013 403'],
  ])('%s', async (_case, err, expected) => {
    const { errorKind } = await import('./discord-bot-messages.server');
    expect(errorKind(err)).toBe(expected);
  });
});

describe('H46: the send path shape-checks its Sentry code tag', () => {
  it('a free-text code on a failed chunk becomes the placeholder tag', async () => {
    const m = failingMessage('u6', 'plain');
    m.reply.mockRejectedValue(Object.assign(new Error('x'), { code: 'free text zz-sentinel-code' }));
    await deliver(m);
    expect(sentryText()).not.toContain('zz-sentinel-code');
    expect(logged.join('\n')).not.toContain('zz-sentinel-code');
    expect(logged.join('\n')).toContain('Discord: chunk send failed: Error unknown');
    expect(edge.captureMessage).toHaveBeenCalledWith('Discord: chunk send failed',
      expect.objectContaining({ tags: expect.objectContaining({ code: 'unknown' }) }));
  });
});

describe('US-15 AC62: sentText never stores a wrong prefix', () => {
  it.each([
    ['a chunk not in the content', 'first part. second part.', ['other text']],
    ['chunks out of order', 'first part. second part.', ['second part.', 'first part.']],
  ])('%s throws in fixed words', async (_case, content, texts) => {
    const { sentText } = await import('./discord-bot-send.server');
    const sent = texts.map((text, i) => ({ id: `m${i}`, text }));
    expect(() => sentText(content, sent)).toThrow('Discord: sent chunk not found in the answer');
  });

  it('chunks found in order give the text as far as they reach', async () => {
    const { sentText } = await import('./discord-bot-send.server');
    expect(sentText('first part.\n\nsecond part. third.', [{ id: 'a', text: 'first part.' }, { id: 'b', text: 'second part.' }]))
      .toBe('first part.\n\nsecond part.');
  });
});
