/**
 * US-15 AC16/AC17: the web chat streams the answer and the thinking summary.
 * streamAnthropicWithUsage parses the Messages API's SSE events and returns the
 * same result shape as the non-streaming call, so tool parsing, the refusal
 * outcome and telemetry downstream are untouched.
 *
 * The fixture lines are real events captured from claude-sonnet-5-5 on
 * 2026-09-29 (thinking display 'summarized'), trimmed; the padding after each
 * JSON object is the API's own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
vi.mock('./cron-helpers.server', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';

import { streamAnthropicWithUsage, type AnthropicStreamEvent } from './anthropic.server';
import { classifyChatError } from './chat.server';

const REAL_FETCH = global.fetch;
afterEach(() => { global.fetch = REAL_FETCH; vi.useRealTimers(); });

const HEAD = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","id":"msg_011CfWaXkPc2Js7BUCk3MQ2t","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":78,"cache_creation_input_tokens":12,"cache_read_input_tokens":3400,"output_tokens":24,"service_tier":"standard","inference_geo":"global"},"diagnostics":null}   }',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}    }',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I"}   }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" need"}             }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a"}           }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"CAQSgwcKEAgSGAI4AUIIdGhpbmtpbmc"}  }',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0            }',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}      }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"2 9 "}       }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"4\\n7 5 3"}    }',
  '',
];

const TEXT_END = [
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1               }',
  '',
];

const TOOL = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_017WboPP1C2Qk75ZYS8k99vz","name":"propose_field_edit","input":{},"caller":{"type":"direct"}}           }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}    }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"field"}      }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\": \\"weight\\", \\"valu"}        }',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"e\\": 80}"}              }',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":2             }',
  '',
];

const stop = (stopReason: string, stopDetails = 'null') => [
  'event: message_delta',
  `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null,"stop_details":${stopDetails},"container":null},"usage":{"input_tokens":78,"cache_creation_input_tokens":12,"cache_read_input_tokens":3400,"output_tokens":250,"output_tokens_details":{"thinking_tokens":231}}              }`,
  '',
  'event: message_stop',
  'data: {"type":"message_stop"               }',
  '',
];

/** A streamed 200 whose body arrives in `size`-byte chunks, cutting lines and UTF-8 sequences mid-way. */
function sse(lines: string[], size = 37): Response {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockFetch(...responses: Array<Response | (() => Response)>) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockImplementationOnce(async () => (typeof r === 'function' ? r() : r));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function collect() {
  const events: AnthropicStreamEvent[] = [];
  return { events, onEvent: (e: AnthropicStreamEvent) => { events.push(e); } };
}

const joined = (events: AnthropicStreamEvent[], type: 'thinking' | 'text') => events.filter((e) => e.type === type).map((e) => e.text).join('');

describe('US-15 AC16/AC17 — streamAnthropicWithUsage', () => {
  it('sends stream: true and forwards thinking then text deltas in order', async () => {
    const fetchMock = mockFetch(sse([...HEAD, ...TEXT_END, ...stop('end_turn')]));
    const { events, onEvent } = collect();
    await streamAnthropicWithUsage({ model: 'claude-sonnet-5-5', messages: [] }, onEvent);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['thinking', 'thinking', 'thinking', 'text', 'text']);
    expect(joined(events, 'thinking')).toBe('I need a');
    expect(joined(events, 'text')).toBe('2 9 4\n7 5 3');
  });

  it('returns exactly the non-streaming result shape: text, blocks with parsed tool input, usage, stop reason', async () => {
    mockFetch(sse([...HEAD, ...TEXT_END, ...TOOL, ...stop('tool_use')]));
    const result = await streamAnthropicWithUsage({}, () => {});
    expect(result).toEqual({
      content: '2 9 4\n7 5 3',
      contentBlocks: [
        { type: 'thinking', thinking: 'I need a', signature: 'CAQSgwcKEAgSGAI4AUIIdGhpbmtpbmc' },
        { type: 'text', text: '2 9 4\n7 5 3' },
        { type: 'tool_use', id: 'toolu_017WboPP1C2Qk75ZYS8k99vz', name: 'propose_field_edit', input: { field: 'weight', value: 80 }, caller: { type: 'direct' } },
      ],
      usage: { inputTokens: 78, outputTokens: 250, cacheCreationTokens: 12, cacheReadTokens: 3400 },
      stopReason: 'tool_use',
    });
  });

  it('parses the same events whatever the chunk boundaries', async () => {
    for (const size of [1, 7, 4096]) {
      mockFetch(sse([...HEAD, ...TEXT_END, ...TOOL, ...stop('tool_use')], size));
      const { events, onEvent } = collect();
      const result = await streamAnthropicWithUsage({}, onEvent);
      expect(result.content).toBe('2 9 4\n7 5 3');
      expect(joined(events, 'thinking')).toBe('I need a');
    }
  });

  it('a refusal mid-stream: the deltas already went out, the result is the empty refusal', async () => {
    mockFetch(sse([...HEAD, ...TEXT_END, ...stop('refusal', '{"type":"refusal","category":"bio","explanation":"declined"}')]));
    const { events, onEvent } = collect();
    const result = await streamAnthropicWithUsage({}, onEvent);
    expect(joined(events, 'text')).toBe('2 9 4\n7 5 3');
    expect(result).toEqual({
      content: '', contentBlocks: [], stopReason: 'refusal', refusalCategory: 'bio',
      usage: { inputTokens: 78, outputTokens: 250, cacheCreationTokens: 12, cacheReadTokens: 3400 },
    });
  });

  it('an unknown refusal category is "other"', async () => {
    mockFetch(sse([...HEAD, ...stop('refusal', '{"type":"refusal","category":"brand_new","explanation":"x"}')]));
    expect((await streamAnthropicWithUsage({}, () => {})).refusalCategory).toBe('other');
  });

  it('retries a transient status before the first byte, and discards the error body', async () => {
    const cancel = vi.fn();
    const err503 = { ok: false, status: 503, body: { cancel }, json: async () => ({}), text: async () => 'echo' } as unknown as Response;
    const fetchMock = mockFetch(err503, sse([...HEAD, ...TEXT_END, ...stop('end_turn')]));
    const result = await streamAnthropicWithUsage({}, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalled();
    expect(result.content).toBe('2 9 4\n7 5 3');
  });

  it('an error event after streaming began throws without a retry and without quoting the provider', async () => {
    const fetchMock = mockFetch(sse([...HEAD, 'event: error', 'data: {"type":"error","error":{"type":"overloaded_error","message":"echo of user text"}}', '']));
    const err = await streamAnthropicWithUsage({}, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Anthropic stream error (overloaded_error)');
    expect(err.message).not.toContain('echo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a stream that ends before message_stop throws, not a partial answer', async () => {
    const fetchMock = mockFetch(sse(HEAD));
    await expect(streamAnthropicWithUsage({}, () => {})).rejects.toThrow('Anthropic stream ended early');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 200 with no text and no tool use is "No text in Anthropic response", as today', async () => {
    mockFetch(sse([HEAD[0], HEAD[1], '', ...stop('end_turn')]));
    await expect(streamAnthropicWithUsage({}, () => {})).rejects.toThrow('No text in Anthropic response');
  });

  // Codex R2 / adversary R7: max_tokens can cut a tool's input mid-JSON.
  it('text then a tool input cut off by max_tokens: keeps the text, drops the tool block, does not throw', async () => {
    const cut = [...TOOL.slice(0, 12), ...TOOL.slice(15)]; // the last input delta never arrives
    const result = await (mockFetch(sse([...HEAD, ...TEXT_END, ...cut, ...stop('max_tokens')])), streamAnthropicWithUsage({}, () => {}));
    expect(result.content).toBe('2 9 4\n7 5 3');
    expect(result.stopReason).toBe('max_tokens');
    expect(result.contentBlocks.some((b) => b.type === 'tool_use')).toBe(false);
  });

  it('thinking only, then max_tokens: an empty result carrying the stop reason, not "No text"', async () => {
    mockFetch(sse([...HEAD.slice(0, 24), ...stop('max_tokens')]));
    const result = await streamAnthropicWithUsage({}, () => {});
    expect(result).toMatchObject({ content: '', stopReason: 'max_tokens' });
  });

  it('an overloaded_error stream event classifies as overloaded_529', async () => {
    mockFetch(sse([...HEAD, 'event: error', 'data: {"type":"error","error":{"type":"overloaded_error","message":"x"}}', '']));
    const err = await streamAnthropicWithUsage({}, () => {}).catch((e) => e);
    expect(classifyChatError(err)).toBe('overloaded_529');
  });

  it('30 s with no chunk after streaming began is a timeout, not retried', async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode(HEAD.join('\n') + '\n');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      },
    }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const pending = streamAnthropicWithUsage({}, () => {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await pending;
    expect(err.name).toBe('TimeoutError');
    expect(classifyChatError(err)).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
