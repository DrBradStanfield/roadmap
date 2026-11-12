/**
 * Shared content-based dedup for chat surfaces (web + Discord).
 *
 * If a user re-sends a message that is byte-identical to their previous turn
 * AND the matching assistant reply was issued within DEDUP_WINDOW_MS AND that
 * reply was not a fallback or a refusal line, the chat handler skips classifier/router/main LLM
 * and re-serves the previous reply instead. Prevents wasted token spend on
 * double-sends (browser glitch, accidental resend, intentional retype) and
 * keeps the audit log clean.
 *
 * YouTube uses a different dedup model (`youtube_bot_log.youtube_comment_id`
 * UNIQUE constraint — same comment is never processed twice), so this helper
 * is for web + Discord only.
 *
 * The local-first widget keeps no transcript server-side, only a masked
 * question row (US-15 AC7), so its twin lives in the client (widget-src chat-api.ts sendMessage): the same
 * adjacent-pair rule, window and no-fallback check over the widget's own
 * file (the POST response carries `isFallback` for it). Not shared on purpose
 * — a package export for four lines would cost more than the twin.
 *
 * See claude_business docs/chat-architecture.md § Consecutive-duplicate dedup.
 *
 * Behind it, `claimChatTurn` stops an identical message while its first turn
 * still runs (US-15 AC63): the re-serve alone only sees a finished reply.
 */
import crypto from 'node:crypto';
import * as Sentry from '@sentry/react-router';
import { CLAIM_TIMEOUT_MS, insertClaim, releaseSingleUse, sweepSingleUse, type ClaimResult } from './single-use-claims.server';

export const DEDUP_WINDOW_MS = 60_000;

export interface DedupHistoryItem {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  /** Only set on assistant messages; missing from older rows is treated as false. */
  is_fallback?: boolean | null;
  /** 'refusal' marks a refusal line (US-15 AC14), 'partial' a Discord answer cut
   *  off part way (US-15 AC62); neither is ever re-served. */
  failure_mode?: string | null;
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
  if (lastMsg.is_fallback === true || lastMsg.failure_mode === 'refusal' || lastMsg.failure_mode === 'partial') return null;
  const ageMs = Date.now() - new Date(lastMsg.created_at).getTime();
  if (ageMs >= DEDUP_WINDOW_MS) return null;
  return { content: lastMsg.content, assistantCreatedAt: lastMsg.created_at, ageMs };
}

// ---------------------------------------------------------------------------
// One answer per identical message while a turn runs (US-15 AC63)
// ---------------------------------------------------------------------------

/** What the bubble and the embed show for an identical message sent while its answer is still coming. */
export const CHAT_BUSY_REPLY = 'Still answering this question. Try sending it again in a moment.';

/**
 * How long a claim blocks. It must outlast the longest turn, or a slow turn
 * loses its claim and a resend runs beside it. From the timeouts, each with
 * anthropic-fetch's one retry (RETRY_MAX_ATTEMPTS 2, RETRY_DELAY_MS 1 s):
 * classifier 2 x 5 s + 1 s (CLASSIFIER_TIMEOUT_MS) + router 2 x 5 s + 1 s
 * (ROUTER_TIMEOUT_MS) + answer 2 x 60 s + 1 s (ANTHROPIC_TIMEOUT_MS) = 143 s.
 * The rest (orders, Supabase writes) has no timeout of its own: 37 s of margin.
 * The live chat_timing p99 could not be read on 2026-11-12 (the Fly log buffer
 * held no chat_timing line). chat-dedup.server.test.ts fails if the sum ever
 * reaches this. The sum covers the model stages only: a longer turn (a slow
 * Discord send) just loses its claim early. Its release names its own row's
 * exact created_at, so it never deletes a twin's later claim.
 */
export const CHAT_TURN_TTL_MS = 180_000;
const KIND = 'chat-turn';
/** Domain separation: this MAC can never equal one the same secret makes elsewhere. */
const KEY_LABEL = 'chat-turn-claim:v1';
/** The claim's whole store time (insert, sweep, retry) shares one deadline, then fails open. */
const CLAIM_BUDGET_MS = CLAIM_TIMEOUT_MS;
/** An outage or a missing table reports once per process per this long, not on every turn. */
const CLAIM_FAILED_REPORT_MS = 10 * 60_000;
let missingSecretReported = false;
let claimFailedReportedAt = -Infinity;

export type TurnClaim =
  | { kind: 'duplicate'; content: string }
  | { kind: 'busy' }
  | { kind: 'run'; release: () => void };

const UNCLAIMED: TurnClaim = { kind: 'run', release: () => undefined };

/**
 * HMAC-SHA256 under SHOPIFY_API_SECRET (every surface that reaches chat has
 * it) of the label, the scope and the message. Null without the secret: the
 * turn then runs unclaimed, never under a plain hash.
 */
function turnKey(scope: string, message: string): string | null {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (secret) return crypto.createHmac('sha256', secret).update(`${KEY_LABEL}\n${scope}\n${message}`, 'utf8').digest('hex');
  if (!missingSecretReported) {
    missingSecretReported = true;
    Sentry.captureMessage('Chat: turn claim has no key secret', { level: 'warning', tags: { feature: 'chat' } });
  }
  return null;
}

/**
 * The one gate before a stored-surface turn (the web transcript surfaces and
 * Discord). First the 60 s re-serve of a finished reply (pass `[]` to turn it
 * off), then a claim in `single_use_claims` on (scope, message). Scope is the
 * conversation id or, for a first message, the session, user or Discord author
 * id. 'busy': an identical turn is still running. 'run': answer, then call
 * `release` when the turn ends, however it ends. A store that is down, a
 * missing table or a missing secret fails open: the turn runs as before, and
 * the worst case is today's second answer. Nothing here logs text or ids.
 */
export async function claimChatTurn(
  scope: string, message: string, history: DedupHistoryItem[], platform: 'shopify' | 'discord',
): Promise<TurnClaim> {
  const dup = findDuplicateReply(history, message);
  if (dup) {
    Sentry.captureMessage('chat: duplicate user message detected, re-serving previous reply', {
      level: 'info',
      tags: { feature: 'chat', platform, diagnostic: 'dedup' },
      extra: { ageMs: dup.ageMs, messageLength: message.length },
    });
    return { kind: 'duplicate', content: dup.content };
  }
  const key = turnKey(scope, message);
  if (!key) return UNCLAIMED;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), CLAIM_BUDGET_MS);
  let claim: ClaimResult;
  try {
    claim = await insertClaim(key, KIND, deadline.signal);
    // The row may be a crashed turn's: clear claims past the TTL and try once more.
    if (claim.outcome === 'spent') {
      await sweepSingleUse(KIND, CHAT_TURN_TTL_MS, deadline.signal);
      claim = await insertClaim(key, KIND, deadline.signal);
    }
  } finally {
    clearTimeout(timer);
  }
  if (claim.outcome === 'spent') {
    Sentry.captureMessage('chat: turn already running', {
      level: 'info',
      tags: { feature: 'chat', platform, diagnostic: 'inflight' },
      extra: { messageLength: message.length },
    });
    return { kind: 'busy' };
  }
  if (claim.outcome === 'unavailable') {
    if (Date.now() - claimFailedReportedAt >= CLAIM_FAILED_REPORT_MS) {
      claimFailedReportedAt = Date.now();
      Sentry.captureMessage('Chat: turn claim failed', { level: 'warning', tags: { feature: 'chat', platform } });
    }
    // Fail open with nothing to release: a row that may have landed expires through the sweep.
    return UNCLAIMED;
  }
  void sweepSingleUse(KIND, CHAT_TURN_TTL_MS);
  const createdAt = claim.outcome === 'claimed' ? claim.createdAt : null;
  return createdAt ? { kind: 'run', release: () => void releaseSingleUse(key, KIND, createdAt) } : UNCLAIMED;
}
