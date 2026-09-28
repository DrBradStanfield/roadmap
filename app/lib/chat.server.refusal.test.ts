/**
 * US-15 AC13/AC14 (chat audit 2026-09-29 F1, F2): the main answer runs on the
 * pinned CHAT_MODEL with its family's request shape, and a refusal is a third
 * outcome beside answer and fallback — a short line, never the partial text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./cron-helpers.server', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';

import * as Sentry from '@sentry/react-router';
import { getChatCompletion, reportChatFallback, FALLBACK_RESPONSE, REFUSAL_RESPONSES } from './chat.server';

const REAL_FETCH = global.fetch;
const PARTIAL = 'Partial answer the model began before declining';

function respond(stop_reason: string, content: unknown[], stop_details: unknown = null) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ content, stop_reason, stop_details, usage: { input_tokens: 10, output_tokens: 5 } }),
  } as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const refusal = (category: string | null) => respond('refusal', [{ type: 'text', text: PARTIAL }], { type: 'refusal', category, explanation: 'x' });

afterEach(() => {
  global.fetch = REAL_FETCH;
  vi.clearAllMocks();
});

describe('US-15 AC13: the answer body comes from the model pin', () => {
  it('sends Sonnet 5.5 with adaptive thinking (summarized), effort medium, no sampling param', async () => {
    const fetchMock = respond('end_turn', [{ type: 'text', text: 'An answer.' }]);
    await getChatCompletion([], [{ role: 'user', content: 'hi' }], true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('temperature');
  });
});

// US-15 AC19: the form tools go only to a client that applies them.
describe('US-15 AC19: tools only where a client can apply them', () => {
  it('canApplyEdits: true sends the two form tools', async () => {
    const fetchMock = respond('end_turn', [{ type: 'text', text: 'An answer.' }]);
    await getChatCompletion([], [{ role: 'user', content: 'hi' }], true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit']);
  });

  it('canApplyEdits: false sends no tools', async () => {
    const fetchMock = respond('end_turn', [{ type: 'text', text: 'An answer.' }]);
    await getChatCompletion([], [{ role: 'user', content: 'hi' }], false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('tools');
  });
});

describe('US-15 AC14: a refusal is its own outcome', () => {
  it.each([
    ['bio', REFUSAL_RESPONSES.clinical],
    ['general_harms', REFUSAL_RESPONSES.clinical],
    [null, REFUSAL_RESPONSES.clinical],
    ['reasoning_extraction', REFUSAL_RESPONSES.request],
    ['cyber', REFUSAL_RESPONSES.request],
    ['frontier_llm', REFUSAL_RESPONSES.request],
  ])('category %s gets its line; the partial text is discarded', async (category, line) => {
    refusal(category);
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true);
    expect(result.isRefusal).toBe(true);
    expect(result.isFallback).toBe(false);
    expect(result.failureMode).toBe('refusal');
    expect(result.refusalCategory).toBe(category ?? 'other');
    expect(result.stopReason).toBe('refusal');
    expect(result.content).toBe(line);
    expect(result.content).not.toContain(PARTIAL);
    expect(result.proposedEdits).toBeUndefined();
  });

  it('the lines are fixed text', () => {
    expect(REFUSAL_RESPONSES.clinical).toBe("I can't help with that here. Please raise it with your doctor or pharmacist.");
    expect(REFUSAL_RESPONSES.request).toBe("I can't help with that request.");
    expect(FALLBACK_RESPONSE).toBe("Sorry — I'm having trouble responding right now. Please try again, or email brad@drstanfield.com if it keeps happening.");
  });

  it('a max_tokens stop keeps the answer, appends nothing, and logs only the stop reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond('max_tokens', [{ type: 'text', text: 'An answer cut off mid' }]);
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true);
    expect(result.content).toBe('An answer cut off mid');
    expect(result.isFallback).toBe(false);
    expect(result.isRefusal).toBeUndefined();
    expect(result.stopReason).toBe('max_tokens');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({ evt: 'chat_truncated', stopReason: 'max_tokens' });
    warn.mockRestore();
  });

  it('Sentry gets a warning tagged with the stop reason and category only', async () => {
    refusal('bio');
    const completion = await getChatCompletion([], [{ role: 'user', content: 'q' }], true);
    reportChatFallback({ completion, platform: 'shopify', latencyMs: 12, conversationId: null });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = (Sentry.captureMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toBe('Chat: main-LLM refusal');
    expect(ctx.tags).toEqual({ feature: 'chat', subsystem: 'main-llm', platform: 'shopify', stopReason: 'refusal', refusalCategory: 'bio' });
    expect(JSON.stringify(ctx)).not.toContain(PARTIAL);
    expect(JSON.stringify(ctx)).not.toContain(REFUSAL_RESPONSES.clinical);
  });
});

// US-15 AC16: the web route passes onEvent and the answer streams; every
// outcome above stays the same, and the caller discards the streamed partial.
describe('US-15 AC16: getChatCompletion streams when given onEvent', () => {
  function streamed(events: unknown[]) {
    const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const fetchMock = vi.fn().mockResolvedValue(new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const start = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } };
  const textBlock = (text: string) => [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
  ];
  const end = (stop_reason: string, stop_details: unknown = null) => [
    { type: 'message_delta', delta: { stop_reason, stop_details }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];

  it('sends stream: true, forwards the deltas, and returns the answer', async () => {
    const fetchMock = streamed([start, ...textBlock('An answer.'), ...end('end_turn')]);
    const onEvent = vi.fn();
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true, onEvent);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({ type: 'text', text: 'An answer.' });
    expect(result).toMatchObject({ content: 'An answer.', isFallback: false, stopReason: 'end_turn' });
  });

  it('a refusal after text streamed is still the refusal line', async () => {
    streamed([start, ...textBlock(PARTIAL), ...end('refusal', { type: 'refusal', category: 'bio', explanation: 'x' })]);
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true, vi.fn());
    expect(result).toMatchObject({ isRefusal: true, content: REFUSAL_RESPONSES.clinical, failureMode: 'refusal' });
  });

  it('a stream that breaks after text streamed is the api-error fallback', async () => {
    streamed([start, ...textBlock(PARTIAL)]);
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true, vi.fn());
    expect(result).toMatchObject({ isFallback: true, failureMode: 'api-error', content: FALLBACK_RESPONSE });
  });

  it('thinking only, then max_tokens: the empty-response fallback, logged with its stop reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    streamed([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing it up' } },
      { type: 'content_block_stop', index: 0 },
      ...end('max_tokens')]);
    const result = await getChatCompletion([], [{ role: 'user', content: 'q' }], true, vi.fn());
    expect(result).toMatchObject({ isFallback: true, failureMode: 'empty-response', stopReason: 'max_tokens', content: FALLBACK_RESPONSE });
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ evt: 'chat_truncated', stopReason: 'max_tokens' }));
    warn.mockRestore();
  });

  it('without onEvent the request is not streamed', async () => {
    const fetchMock = respond('end_turn', [{ type: 'text', text: 'An answer.' }]);
    await getChatCompletion([], [{ role: 'user', content: 'q' }], true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('stream');
  });
});
