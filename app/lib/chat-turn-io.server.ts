/**
 * The web chat route's request shapes and reply stream (api.chat.ts): its
 * fixed-text error report, the conversation id check, the client history
 * reader and the NDJSON stream. Moved unchanged from api.chat.ts.
 */
import * as Sentry from '@sentry/react-router';
import { isValidUuid } from './route-helpers.server';
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_TURN_CHARS, cutText } from '../../packages/health-core/src/chat-history';

// Only fixed operation descriptions enter diagnostics. Database errors can echo
// conversation contents even when every identifier passed validation.
export function reportChatError(message: string): void {
  console.error(message);
  Sentry.captureException(new Error(message), { tags: { feature: 'chat' } });
}

export function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && isValidUuid(value.toLowerCase());
}

export type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The widget's earlier turns, sent from its own chat-history.json (US-15 AC7:
 * the server stores none). Whitelisted roles, non-empty strings, the same
 * bound the BYOK transport uses, each turn cut at MAX_HISTORY_TURN_CHARS (no
 * shorter than a question may be), and never starting on an assistant turn — the Messages API 400s on that,
 * which would surface as a fallback.
 */
export function readClientHistory(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  const turns = value.slice(-MAX_HISTORY_MESSAGES).filter((t): t is Turn =>
    !!t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant')
    && typeof t.content === 'string' && t.content.length > 0)
    .map((t) => ({ role: t.role, content: cutText(t.content, MAX_HISTORY_TURN_CHARS) }));
  return turns.slice(Math.max(0, turns.findIndex((t) => t.role === 'user')));
}

/**
 * An NDJSON reply (US-15 AC16): one JSON object per line, written as `run`
 * produces them. The status is sent before the answer exists, so a failure
 * inside `run` ends the stream with an error `done` line instead. A reader
 * that went away does not stop the turn: `run` still finishes and persists.
 * `no-transform` keeps proxies from buffering the stream to compress it.
 */
export function streamTurn(run: (write: (line: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: object) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(line) + '\n')); } catch { /* reader gone */ }
      };
      void run(write)
        .catch(() => {
          reportChatError('Chat: Action failed');
          write({ type: 'done', success: false, error: 'Failed to process message' });
        })
        .finally(() => { try { controller.close(); } catch { /* reader gone */ } });
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' },
  });
}
