/**
 * One Anthropic key per purpose, so the Console shows spend by feature.
 * `anthropicKey` reads ANTHROPIC_API_KEY_<PURPOSE> and falls back to ANTHROPIC_API_KEY
 * when that is unset or empty. The pipeline tests check the key each surface's calls
 * actually send: every YouTube or Discord turn's classifier, router and answer calls
 * carry that platform's key, never the web chat's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./cron-helpers.server', async (orig) => ({ ...(await orig<typeof import('./cron-helpers.server')>()), sleep: async () => {} }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null }));

import { anthropicKey, callAnthropicWithUsage, extractOrClassify, streamAnthropicWithUsage, type AnthropicPurpose } from './anthropic.server';
import { classifyMessage } from './chat-classifier.server';
import { routeQuery } from './chat-router.server';
import { getChatCompletion } from './chat.server';
import { platformChatCompletion } from './platform-chat.server';
import { runPipeline } from './youtube-bot.server';

const PURPOSES: AnthropicPurpose[] = ['CHAT', 'YOUTUBE', 'DISCORD', 'PURGE', 'LABS', 'CONNECTOR'];
const VARS = ['ANTHROPIC_API_KEY', ...PURPOSES.map((p) => `ANTHROPIC_API_KEY_${p}`)];
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

function textReply(text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Every request's x-api-key, in order. */
function stubFetch(reply: () => Response = () => textReply('ROUTE')): string[] {
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)['x-api-key']);
    return reply();
  }));
  return keys;
}

beforeEach(() => {
  for (const v of VARS) delete process.env[v];
  process.env.ANTHROPIC_API_KEY = 'test-token-shared';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('anthropicKey', () => {
  it.each(PURPOSES)('%s: its own key wins over the shared one', (purpose) => {
    process.env[`ANTHROPIC_API_KEY_${purpose}`] = `test-token-${purpose.toLowerCase()}`;
    expect(anthropicKey(purpose)).toBe(`test-token-${purpose.toLowerCase()}`);
  });

  it('a missing purpose key falls back to ANTHROPIC_API_KEY', () => {
    expect(anthropicKey('YOUTUBE')).toBe('test-token-shared');
  });

  it('an empty purpose key falls back to ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY_YOUTUBE = '';
    expect(anthropicKey('YOUTUBE')).toBe('test-token-shared');
  });

  it('another purpose\'s key is never used', () => {
    process.env.ANTHROPIC_API_KEY_CHAT = 'test-token-chat';
    expect(anthropicKey('YOUTUBE')).toBe('test-token-shared');
  });

  it('with no key at all it throws the same error as before', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => anthropicKey('CHAT')).toThrow('ANTHROPIC_API_KEY not configured');
  });

  it('an unknown purpose does not type-check', () => {
    // @ts-expect-error 'TRENDING' is not an AnthropicPurpose
    expect(anthropicKey('TRENDING')).toBe('test-token-shared');
  });
});

describe('each call sends its purpose key', () => {
  beforeEach(() => {
    for (const p of PURPOSES) process.env[`ANTHROPIC_API_KEY_${p}`] = `test-token-${p.toLowerCase()}`;
  });

  it('callAnthropicWithUsage', async () => {
    const keys = stubFetch();
    await callAnthropicWithUsage({ model: 'x' }, 'PURGE');
    expect(keys).toEqual(['test-token-purge']);
  });

  it('streamAnthropicWithUsage', async () => {
    const keys = stubFetch(() => new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      'data: {"type":"message_stop"}', '',
    ].join('\n'), { status: 200 }));
    await streamAnthropicWithUsage({ model: 'x' }, () => {}, 'CHAT');
    expect(keys).toEqual(['test-token-chat']);
  });

  it('extractOrClassify', async () => {
    const keys = stubFetch(() => textReply('not json'));
    await extractOrClassify([{ type: 'text', content: 'doc' }], { purpose: 'CONNECTOR' }).catch(() => {});
    expect(keys).toEqual(['test-token-connector', 'test-token-connector']);
  });

  it('the web chat\'s classifier, router and answer', async () => {
    const keys = stubFetch();
    await classifyMessage('What is ApoB?', undefined, undefined, 'CHAT');
    await routeQuery('What is ApoB?', undefined, undefined, 'CHAT');
    await getChatCompletion([{ type: 'text', text: 'x' }], [{ role: 'user', content: 'What is ApoB?' }], false, undefined, { purpose: 'CHAT' });
    expect(keys).toEqual(['test-token-chat', 'test-token-chat', 'test-token-chat']);
  });

  it('a YouTube turn: every call carries the YouTube key', async () => {
    const keys = stubFetch();
    const thread = { topLevelCommentId: 't1', videoId: 'v1', authorDisplayName: 'A', authorChannelId: null, text: 'What is a good ApoB?', publishedAt: '2026-11-03T00:00:00Z' };
    const entry = { title: 'ApoB', handle: 'apob', url: 'https://drstanfield.com/blogs/news/apob', tags: [], publishedAt: '2026-09-01' };
    await runPipeline(thread, entry, 'Video body');
    expect(keys.length).toBe(3); // classifier, router, answer
    expect(new Set(keys)).toEqual(new Set(['test-token-youtube']));
  });

  it('a Discord turn: every call carries the Discord key', async () => {
    const keys = stubFetch();
    await platformChatCompletion({ message: 'What is a good ApoB?', history: [] });
    expect(keys.length).toBe(3); // classifier, router, answer
    expect(new Set(keys)).toEqual(new Set(['test-token-discord']));
  });
});
