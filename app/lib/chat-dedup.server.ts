/**
 * Shared content-based dedup for chat surfaces (web + Discord).
 *
 * If a user re-sends a message that is byte-identical to their previous turn
 * AND the matching assistant reply was issued within DEDUP_WINDOW_MS AND that
 * reply was not a fallback, the chat handler skips classifier/router/main LLM
 * and re-serves the previous reply instead. Prevents wasted token spend on
 * double-sends (browser glitch, accidental resend, intentional retype) and
 * keeps the audit log clean.
 *
 * YouTube uses a different dedup model (`youtube_bot_log.youtube_comment_id`
 * UNIQUE constraint — same comment is never processed twice), so this helper
 * is for web + Discord only.
 *
 * See docs/chat-architecture.md § Consecutive-duplicate dedup.
 */

export const DEDUP_WINDOW_MS = 60_000;

export interface DedupHistoryItem {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  /** Only set on assistant messages; missing from older rows is treated as false. */
  is_fallback?: boolean | null;
}

export interface DuplicateMatch {
  /** The previous assistant reply content to re-serve. */
  content: string;
  /** The previous assistant reply timestamp (ISO). */
  assistantCreatedAt: string;
  /** Milliseconds between the previous reply and now. */
  ageMs: number;
}

/**
 * Returns a DuplicateMatch if the last 2 messages in `history` are (user,
 * assistant) where the user content === `newMessage`, the assistant reply
 * was issued within `DEDUP_WINDOW_MS`, and the assistant reply was NOT a
 * fallback (we never re-serve a fallback — the user's retry was likely an
 * attempt to get a real answer).
 *
 * Returns null otherwise. Callers should run the full pipeline on null.
 */
export function findDuplicateReply(
  history: DedupHistoryItem[],
  newMessage: string,
): DuplicateMatch | null {
  const lastMsg = history[history.length - 1];
  const prevUserMsg = history[history.length - 2];
  if (!lastMsg || !prevUserMsg) return null;
  if (lastMsg.role !== 'assistant') return null;
  if (prevUserMsg.role !== 'user') return null;
  if (prevUserMsg.content !== newMessage) return null;
  if (lastMsg.is_fallback === true) return null;
  const ageMs = Date.now() - new Date(lastMsg.created_at).getTime();
  if (ageMs >= DEDUP_WINDOW_MS) return null;
  return { content: lastMsg.content, assistantCreatedAt: lastMsg.created_at, ageMs };
}
