/**
 * The website chat's requests to /api/chat (chat-api.ts): the guest session
 * token, the shared query and body parts, the one retry for a transient
 * upstream failure, and a guest's lost thread. No conversation logic.
 */
import * as Sentry from '@sentry/react';
import type { ChatReply } from './chat-api';
import { LOCAL_FIRST } from './build-flags';

/** A reply's guest session token, or undefined when it is not a non-empty string (US-15 AC6b). */
export function tokenOf(data: ChatReply | null): string | undefined {
  return typeof data?.sessionToken === 'string' && data.sessionToken ? data.sessionToken : undefined;
}

const GUEST_SESSION_KEY = 'health_roadmap_guest_session';

export function getGuestSessionToken(): string | null {
  try { return localStorage.getItem(GUEST_SESSION_KEY); } catch { return null; }
}

export function setGuestSessionToken(token: string): void {
  try { localStorage.setItem(GUEST_SESSION_KEY, token); } catch { /* noop */ }
}

const TRANSIENT_RETRY_DELAY_MS = 1000;

/**
 * Fetch with ONE retry for transient upstream failures (US-15 AC3). The
 * Shopify app proxy / Fly edge occasionally answers instead of our handler —
 * machine restart or cold start mid-request — as a 5xx with a non-JSON (often
 * empty) body, unlike our handler's JSON errors (Sentry JAVASCRIPT-REMIX-1M,
 * -22). Deterministic answers from our handler (JSON 5xx, 429) are never
 * retried.
 *
 * `retryable`: the send POST is retryable ONLY within an existing
 * conversation — on the stored surfaces the server's consecutive-duplicate
 * dedup (chat-dedup.server.ts) is gated on conversationId, so retrying a
 * thread's FIRST message could mint a ghost conversation + a second LLM
 * spend. On the local-first widget the server keeps no transcript, only a
 * masked question row, so a retry that lands after attempt 1 died
 * mid-pipeline costs one more LLM call and at most one more question row.
 */
export async function fetchWithTransientRetry(input: string, init?: RequestInit, retryable = true): Promise<Response> {
  const first = await fetch(input, init);
  if (!retryable || first.status < 500) return first;
  const contentType = first.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return first;
  // Keep the transient-failure rate visible in Sentry even when the retry
  // rescues the request (the machine-level cause is still an open data gap).
  Sentry.captureMessage('Chat transient upstream 5xx, retrying once', {
    level: 'info',
    tags: { feature: 'chat' },
    extra: { status: first.status, contentType: contentType || null },
  });
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
  return fetch(input, init);
}

/** Query-string fragments shared by the GET endpoints: the guest session token
 *  (if any) and the local-first flag (forces the server's guest path). */
export function chatQueryParts(): string[] {
  const parts: string[] = [];
  const sessionToken = getGuestSessionToken();
  if (sessionToken) parts.push(`sessionToken=${encodeURIComponent(sessionToken)}`);
  if (LOCAL_FIRST) parts.push('localFirst=1');
  return parts;
}

/** Body fields shared by the POST/DELETE endpoints — the JSON twin of
 *  chatQueryParts(). localFirst tells the server to use the client-supplied
 *  context even if the visitor happens to be a logged-in Shopify customer
 *  (local-first builds have no DB record to read). Brad still pays. */
export function chatBodyParts(sessionToken = getGuestSessionToken()): Record<string, unknown> {
  return {
    ...(sessionToken ? { sessionToken } : {}),
    ...(LOCAL_FIRST ? { localFirst: true } : {}),
  };
}

/** The server's own 404 for a thread it does not know (US-15 AC6a), not a proxy's. */
export const threadNotFound = (status: number, data: ChatReply | null): boolean => status === 404 && data?.error === 'Conversation not found';

/**
 * A guest's 404 for a thread it no longer owns (US-15 AC6a): its IP changed,
 * so it is a new guest. Keep the session the server handed back.
 */
export function guestThreadGone(status: number, data: ChatReply | null): boolean {
  if (!threadNotFound(status, data) || data?.isGuest !== true) return false;
  const sessionToken = tokenOf(data);
  if (sessionToken) setGuestSessionToken(sessionToken);
  return true;
}
