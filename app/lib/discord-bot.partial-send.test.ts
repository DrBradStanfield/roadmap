import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { format, inspect } from 'node:util';
import { DiscordAPIError } from '@discordjs/rest';

// US-15 AC62: a Discord answer cut off part way. When a later chunk fails,
// the turn is stored as the text that went out, a short notice is tried once,
// no error line follows the partial answer, and the 60 s dedup never re-serves
// the cut-off text. Harness copied from discord-bot.send-failure-log.test.ts:
// a mocked discord.js Client, a stubbed model call, no network.
const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), sleep: vi.fn(), capture: vi.fn(), captureMessage: vi.fn(), duplicate: vi.fn(),
  conversation: null as { id: string } | null,
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
// The claim always grants the turn here; the re-serve answers from edge.duplicate (the claim itself: discord-bot.inflight.test.ts).
vi.mock('./chat-dedup.server', () => ({ claimChatTurn: async (_scope: string, message: string, history: unknown[]) => {
  const dup = edge.duplicate(history, message);
  return dup ? { kind: 'duplicate', content: dup.content } : { kind: 'run', release: () => undefined };
} }));
vi.mock('./cron-helpers.server', () => ({ sleep: edge.sleep }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: (table: string) => {
    const query = { select: () => query, eq: () => query, gte: () => query,
      order: () => query, limit: () => query, update: () => query,
      maybeSingle: async () => ({ data: edge.conversation, error: null }),
      then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      insert: (row: Record<string, unknown>) => { edge.inserts.push({ table, row }); return query; },
      single: async () => ({ data: { id: 'conv-new' }, error: null }) };
    return query;
  },
} }));

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
// Three synthetic paragraphs, 1500 characters each: splitForDiscord cuts at
// each paragraph break, so chunk k is paragraph k. No health values.
const para = (word: string) => `${word} `.repeat(1500 / (word.length + 1)).trimEnd();
const P1 = para('alphaword'), P2 = para('bravoword'), P3 = para('charlieword');
const ANSWER = `${P1}\n\n${P2}\n\n${P3}`;
const NOTICE = 'This answer was cut off. Please ask again.';

type Outcome = 'ok' | DiscordAPIError | Error;
const forbidden = (content: string) => new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403,
  'POST', 'https://discord.com/api/v10/channels/1/messages', { body: { content } });
const aborted = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

/** `replies` are the outcomes of message.reply in call order (chunk 1, then a
 *  notice or error line); `sends` of channel.send (chunk 2, chunk 3). */
function makeMessage(id: string, o: { replies?: Outcome[]; sends?: Outcome[]; noSend?: boolean } = {}) {
  let r = 0, s = 0;
  const outcome = (list: Outcome[] | undefined, i: number) => list?.[i] ?? 'ok';
  const reply = vi.fn().mockImplementation(async (opts: { content: string }) => {
    const out = outcome(o.replies, r++);
    if (out !== 'ok') throw out;
    return { id: `reply-${r}`, content: opts.content };
  });
  const send = vi.fn().mockImplementation(async (opts: { content: string }) => {
    const out = outcome(o.sends, s++);
    if (out !== 'ok') throw out;
    return { id: `send-${s}`, content: opts.content };
  });
  const channel: Record<string, unknown> = { isThread: () => false, isTextBased: () => true };
  if (!o.noSend) channel.send = send;
  return { id, author: { id, bot: false }, guild: { id: 'guild' }, system: false,
    content: 'Synthetic question', channelId: 'ai',
    mentions: { everyone: false, users: new Set<string>() },
    channel, reply, send };
}

async function deliver(message: ReturnType<typeof makeMessage>) {
  edge.listeners.get('message')!(message);
  await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
}

const replyTexts = (m: ReturnType<typeof makeMessage>) => m.reply.mock.calls.map((c) => (c[0] as { content: string }).content);
const rows = (role: string) => edge.inserts.filter((i) => i.table === 'chat_messages' && i.row.role === role).map((i) => i.row);
// Every argument of every Sentry call, serialized deep, plus every console line.
const allText = () => [logged.join('\n'),
  inspect([edge.capture.mock.calls, edge.captureMessage.mock.calls], { depth: null, showHidden: true })].join('\n');

const completion = (content: string) => ({ content, usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
  isFallback: false, routerResult: null, classifier: { classification: 'ANSWER', routerSkipped: true } });

let stop: () => void;
let logged: string[];
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); edge.listeners.clear(); logged = []; edge.inserts = [];
  edge.conversation = null;
  edge.duplicate.mockReturnValue(null);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(format(...args)); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(format(...args)); });
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: 'blocked' })) vi.stubEnv(key, value);
  edge.sleep.mockResolvedValue(undefined);
  edge.complete.mockResolvedValue(completion(ANSWER));
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('US-15 AC62: a Discord answer cut off part way', () => {
  it('chunk 2 fails (50013): no error line follows the partial answer, the notice is posted once', async () => {
    const m = makeMessage('u1', { sends: [forbidden(P2)] });
    await deliver(m);
    const texts = replyTexts(m);
    expect(texts[0]).toContain(P1);
    expect(texts.some((t) => t.includes('went wrong'))).toBe(false);
    expect(texts.filter((t) => t === NOTICE)).toHaveLength(1);
    expect(m.reply).toHaveBeenCalledTimes(2);
  });

  it('chunk 2 fails: the turn is stored as chunk 1, under chunk 1\'s id, marked partial', async () => {
    await deliver(makeMessage('u2', { sends: [forbidden(P2)] }));
    expect(rows('user')).toHaveLength(1);
    const assistant = rows('assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(P1);
    expect(assistant[0].discord_message_id).toBe('reply-1');
    expect(assistant[0].failure_mode).toBe('partial');
  });

  it('the notice is not stored as part of the turn', async () => {
    await deliver(makeMessage('u3', { sends: [forbidden(P2)] }));
    expect(JSON.stringify(edge.inserts)).not.toContain(NOTICE);
  });

  it('chunk 3 fails (AbortError): no app retry, chunks 1-2 stored, the log holds the error kind only', async () => {
    const m = makeMessage('u4', { sends: ['ok', aborted()] });
    await deliver(m);
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(rows('assistant')[0].content).toBe(`${P1}\n\n${P2}`);
    const log = logged.join('\n');
    expect(log).toContain('AbortError');
    for (const word of ['alphaword', 'bravoword', 'charlieword', '<@u4>', 'aborted']) expect(log).not.toContain(word);
  });

  it('chunk 1 fails: one error line, nothing stored (unchanged)', async () => {
    const m = makeMessage('u5', { replies: [forbidden(P1)] });
    await deliver(m);
    const texts = replyTexts(m);
    expect(texts.filter((t) => t.includes('went wrong'))).toHaveLength(1);
    expect(texts).not.toContain(NOTICE);
    expect(m.send).not.toHaveBeenCalled();
    expect(edge.inserts).toHaveLength(0);
  });

  it('all chunks sent: one assistant row with the whole answer, no notice', async () => {
    const m = makeMessage('u6');
    await deliver(m);
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(replyTexts(m)).not.toContain(NOTICE);
    const assistant = rows('assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(ANSWER);
    expect(assistant[0].failure_mode).toBeNull();
  });

  it('a failed notice is swallowed, reported in fixed words, and not retried', async () => {
    const m = makeMessage('u7', { replies: ['ok', forbidden(NOTICE)], sends: [forbidden(P2)] });
    await deliver(m);
    expect(m.reply).toHaveBeenCalledTimes(2);
    expect(replyTexts(m).some((t) => t.includes('went wrong'))).toBe(false);
    expect(rows('assistant')[0].content).toBe(P1);
    expect(logged.join('\n')).toContain('Discord: cut-off notice failed: DiscordAPIError[50013] 50013 403');
  });

  it('a dedup re-send whose chunk 2 fails posts no later chunk, then the notice', async () => {
    edge.conversation = { id: 'conv-1' };
    edge.duplicate.mockReturnValue({ content: ANSWER, ageMs: 1000 });
    const m = makeMessage('u8', { sends: [forbidden(P2)] });
    await deliver(m);
    expect(edge.complete).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(replyTexts(m).filter((t) => t === NOTICE)).toHaveLength(1);
    expect(edge.inserts).toHaveLength(0);
  });

  it('a channel with no send: chunk 2 counts as failed, so the turn is partial', async () => {
    const m = makeMessage('u9', { noSend: true });
    await deliver(m);
    expect(rows('assistant')[0].content).toBe(P1);
    expect(rows('assistant')[0].failure_mode).toBe('partial');
    expect(replyTexts(m).filter((t) => t === NOTICE)).toHaveLength(1);
  });

  it('logs and every Sentry argument never carry chunk text or the asker mention', async () => {
    await deliver(makeMessage('u10', { replies: ['ok', forbidden(NOTICE)], sends: [forbidden(P2)] }));
    await deliver(makeMessage('u11', { noSend: true }));
    const text = allText();
    for (const word of ['alphaword', 'bravoword', 'charlieword', '<@u10>', '<@u11>', 'Missing Permissions']) {
      expect(text).not.toContain(word);
    }
  });

  it('a dedup re-send whose chunk 1 fails posts the error line once and stores nothing', async () => {
    edge.conversation = { id: 'conv-1' };
    edge.duplicate.mockReturnValue({ content: ANSWER, ageMs: 1000 });
    const m = makeMessage('u12', { replies: [forbidden(P1)] });
    await deliver(m);
    expect(edge.complete).not.toHaveBeenCalled();
    expect(replyTexts(m).filter((t) => t.includes('went wrong'))).toHaveLength(1);
    expect(m.send).not.toHaveBeenCalled();
    expect(edge.inserts).toHaveLength(0);
  });

  it('a partial stores the answer exactly as far as it went out, separators included', async () => {
    edge.complete.mockResolvedValueOnce(completion(`${P1}\n\n\n${P2}\n\n${P3}`));
    await deliver(makeMessage('u13', { sends: ['ok', aborted()] }));
    expect(rows('assistant')[0].content).toBe(`${P1}\n\n\n${P2}`);
  });

  it('a failed chunk and a failed notice reach Sentry as fixed words, tags and a code only', async () => {
    await deliver(makeMessage('u14', { replies: ['ok', forbidden(NOTICE)], sends: [forbidden(P2)] }));
    expect(edge.capture).not.toHaveBeenCalled();
    expect(edge.captureMessage).toHaveBeenCalledWith('Discord: chunk send failed', expect.objectContaining({
      tags: { platform: 'discord', subsystem: 'send', chunk: 'later', code: '50013' } }));
    expect(edge.captureMessage).toHaveBeenCalledWith('Discord: cut-off notice failed', expect.objectContaining({
      tags: { platform: 'discord', subsystem: 'send', chunk: 'notice', code: '50013' } }));
  });
});

describe('US-15 AC62: the dedup never re-serves a partial answer', () => {
  it('a stored partial reply is not a duplicate; a whole one still is', async () => {
    const { findDuplicateReply } = await vi.importActual<typeof import('./chat-dedup.server')>('./chat-dedup.server');
    const now = new Date().toISOString();
    const history = (failure_mode: string | null) => [
      { role: 'user' as const, content: 'Synthetic question', created_at: now },
      { role: 'assistant' as const, content: P1, created_at: now, is_fallback: false, failure_mode },
    ];
    expect(findDuplicateReply(history('partial'), 'Synthetic question')).toBeNull();
    expect(findDuplicateReply(history(null), 'Synthetic question')?.content).toBe(P1);
  });
});

describe('US-15 AC62: sendChunks returns one result', () => {
  type Step = 'ok' | 'throw' | 'none';
  const table: Array<[string, Step[], unknown]> = [
    ['no chunks (silent turn)', [], { kind: 'all-sent', sent: [] }],
    ['one chunk sent', ['ok'], { kind: 'all-sent', sent: [{ id: 'id-0', text: 'c0' }] }],
    ['three chunks sent', ['ok', 'ok', 'ok'], { kind: 'all-sent', sent: [{ id: 'id-0', text: 'c0' }, { id: 'id-1', text: 'c1' }, { id: 'id-2', text: 'c2' }] }],
    ['chunk 1 throws', ['throw', 'ok'], { kind: 'none-sent' }],
    ['chunk 1 has no sender', ['none', 'ok'], { kind: 'none-sent' }],
    ['chunk 2 throws', ['ok', 'throw', 'ok'], { kind: 'partial', sent: [{ id: 'id-0', text: 'c0' }], stoppedAt: 1 }],
    ['chunk 2 has no sender', ['ok', 'none', 'ok'], { kind: 'partial', sent: [{ id: 'id-0', text: 'c0' }], stoppedAt: 1 }],
    ['chunk 3 throws', ['ok', 'ok', 'throw'], { kind: 'partial', sent: [{ id: 'id-0', text: 'c0' }, { id: 'id-1', text: 'c1' }], stoppedAt: 2 }],
  ];
  it.each(table)('%s', async (_name, steps, expected) => {
    const { sendChunks } = await import('./discord-bot-send.server');
    const post = vi.fn(async (_text: string, i: number) => {
      if (steps[i] === 'throw') throw forbidden(`c${i}`);
      return steps[i] === 'none' ? null : `id-${i}`;
    });
    expect(await sendChunks(post, steps.map((_, i) => `c${i}`))).toEqual(expected);
    // Stops at the first failure: nothing after it is tried.
    const failedAt = steps.findIndex((s) => s !== 'ok');
    expect(post).toHaveBeenCalledTimes(failedAt === -1 ? steps.length : failedAt + 1);
  });
});
