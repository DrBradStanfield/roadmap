import type { ChatDelta, ChatReply } from './chat-api';

/**
 * Read an NDJSON answer (US-15 AC16): hand each delta to `onDelta` and return
 * the `done` line, which is the JSON the non-streamed reply would have been.
 * The body decides, not the header (a proxy can rewrite it): a first line
 * that is not `{"type":…` returns null, as a non-JSON reply always has.
 * A stream that ends without `done` throws, so the caller reports a network error.
 */
export async function readChatStream(response: Response, onDelta: (delta: ChatDelta) => void): Promise<ChatReply | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }) + (done ? '\n' : '');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (first && !/^\{\s*"type"\s*:/.test(line)) {
        await reader.cancel().catch(() => {});
        return null;
      }
      first = false;
      // A fixed message: V8 quotes the offending input in its SyntaxError, and
      // a corrupted line can hold answer or thinking text, which must not
      // reach the caller's Sentry capture in chat-api.ts (the server scrubs the same case).
      let event;
      try { event = JSON.parse(line); } catch { throw new Error('Chat stream line was not JSON'); }
      if (event.type === 'done') {
        await reader.cancel().catch(() => {});
        const { type: _type, ...reply } = event;
        return reply;
      }
      if (event.type === 'thinking' || event.type === 'text' || event.type === 'status') onDelta({ type: event.type, text: String(event.text) });
      if (event.type === 'sources') {
        onDelta({ type: 'sources', titles: Array.isArray(event.titles) ? event.titles.filter((t: unknown) => typeof t === 'string') : [] });
      }
    }
    if (done) throw new Error('Chat stream ended without an answer');
  }
}
