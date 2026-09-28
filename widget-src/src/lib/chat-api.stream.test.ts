import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-15 AC16/AC17: sendMessage asks for a stream, hands thinking and text
// deltas to onDelta, and resolves on the `done` line. A JSON answer (older
// server, a proxy that rewrote the type, an error status) takes today's path.
vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
const store = vi.hoisted(() => ({ recordExchange: vi.fn(async () => {}) }));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { sendMessage, type ChatDelta } from './chat-api';
import * as SentryReact from '@sentry/react';

const done = { type: 'done', success: true, conversationId: 'c1', messageId: null, content: 'Final answer', isFallback: false };

/** An NDJSON body cut into `size`-byte chunks, so lines and UTF-8 split across reads. */
function ndjson(lines: unknown[], size = 5, contentType = 'application/x-ndjson') {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  }), { status: 200, headers: { 'Content-Type': contentType } });
}

describe('chat-api streaming (US-15 AC16/AC17)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const deltas = () => {
    const seen: ChatDelta[] = [];
    return { seen, onDelta: (d: ChatDelta) => { seen.push(d); } };
  };

  it('sends stream: true, forwards deltas in order, and resolves on done', async () => {
    fetchMock.mockResolvedValue(ndjson([
      { type: 'thinking', text: 'Weighing — the “ApoB” entry' },
      { type: 'text', text: 'Final ' },
      { type: 'text', text: 'answer' },
      done,
    ]));
    const { seen, onDelta } = deltas();
    const { result, error } = await sendMessage('q', null, null, [], onDelta);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(error).toBeNull();
    expect(seen).toEqual([
      { type: 'thinking', text: 'Weighing — the “ApoB” entry' },
      { type: 'text', text: 'Final ' },
      { type: 'text', text: 'answer' },
    ]);
    expect(result).toEqual({ conversationId: 'c1', messageId: null, content: 'Final answer', sessionToken: undefined, isGuest: undefined });
    // The cloud history gets the final answer only, never the thinking.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.recordExchange).toHaveBeenCalledWith(expect.objectContaining({ assistantText: 'Final answer' }));
    expect(JSON.stringify(store.recordExchange.mock.calls)).not.toContain('Weighing');
  });

  // US-15 AC19: only the widget's own chat, which applies edits, asks for the tools.
  it('sends canApplyEdits only when the caller applies edits', async () => {
    fetchMock.mockImplementation(async () => ndjson([done]));
    await sendMessage('q', null, null, [], () => {});
    await sendMessage('q', null, null, [], () => {}, true);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0]).not.toHaveProperty('canApplyEdits');
    expect(bodies[1].canApplyEdits).toBe(true);
  });

  it('a refusal or fallback done line carries isFallback and replaces the streamed text', async () => {
    fetchMock.mockResolvedValue(ndjson([
      { type: 'text', text: 'Partial the model began' },
      { ...done, content: "I can't help with that request.", isRefusal: true, isFallback: true },
    ]));
    const { result } = await sendMessage('q', null, null, [], () => {});
    expect(result).toMatchObject({ content: "I can't help with that request.", isFallback: true });
    expect(result).not.toHaveProperty('discard');
  });

  it('an error done line is an error, as a JSON error is', async () => {
    fetchMock.mockResolvedValue(ndjson([{ type: 'text', text: 'x' }, { type: 'done', success: false, error: 'Failed to process message' }]));
    const { result, error } = await sendMessage('q', null, null, [], () => {});
    expect(result).toBeNull();
    expect(error).toEqual({ error: 'Failed to process message' });
  });

  // US-15 AC16: a cut-off stream is reported, never retried, even inside an
  // existing conversation — the server finishes and persists the turn after a
  // disconnect, so a retry would store it twice on the blog chat and embed.
  it('a stream that ends without done is a network error and is not retried', async () => {
    fetchMock.mockResolvedValue(ndjson([{ type: 'text', text: 'x' }]));
    const { result, error } = await sendMessage('q', 'c1', null, [], () => {});
    expect(result).toBeNull();
    expect(error).toEqual({ error: 'Network error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a corrupted line fails with a fixed message that never quotes the line', async () => {
    fetchMock.mockResolvedValue(new Response(
      '{"type":"text","text":"ok"}\n{"type":"text","text":"SECRET-HEALTH-VALUE\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    ));
    const { result, error } = await sendMessage('q', null, null, [], () => {});
    expect(result).toBeNull();
    expect(error).toEqual({ error: 'Network error' });
    const captured = vi.mocked(SentryReact.captureException).mock.calls.flat().map(String).join(' ');
    expect(captured).not.toContain('SECRET-HEALTH-VALUE');
    expect(captured).toContain('Chat stream line was not JSON');
  });

  // Adversary R4: a proxy can rewrite the type; the body decides (US-15 AC16).
  it('an NDJSON body served as text/plain still streams', async () => {
    fetchMock.mockResolvedValue(ndjson([{ type: 'text', text: 'Final answer' }, done], 5, 'text/plain; charset=utf-8'));
    const { seen, onDelta } = deltas();
    const { result } = await sendMessage('q', null, null, [], onDelta);
    expect(seen).toEqual([{ type: 'text', text: 'Final answer' }]);
    expect(result?.content).toBe('Final answer');
  });

  it('a 200 non-JSON body that is not NDJSON fails as before, without a delta', async () => {
    fetchMock.mockResolvedValue(new Response('<html>edge page</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const onDelta = vi.fn();
    const { result, error } = await sendMessage('q', null, null, [], onDelta);
    expect(result).toBeNull();
    expect(error).toEqual({ error: 'Failed to send message' });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('falls back to the JSON path when the server answers JSON', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, conversationId: 'c1', messageId: null, content: 'json answer' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const onDelta = vi.fn();
    const { result } = await sendMessage('q', null, null, [], onDelta);
    expect(result?.content).toBe('json answer');
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('a JSON 429 is still rate_limited', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'rate_limited' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }));
    expect((await sendMessage('q', null, null, [], () => {})).error).toEqual({ error: 'rate_limited' });
  });
});
