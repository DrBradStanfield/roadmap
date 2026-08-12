/**
 * Chat API client — conversations, messages, send/delete.
 * Uses the same Shopify app proxy path as all other API calls.
 */
import * as Sentry from '@sentry/react';
import type { ProposedEdit } from '@roadmap/health-core';
import { PROXY_PATH, parseJsonResponse } from './api';
import { getChatHistory } from './chat-history-access';
import type { ChatHistoryStore } from '../storage/chat-history-store';

// On local-first builds sendMessage tells the server to trust the
// client-supplied context instead of looking for a DB record.
import { LOCAL_FIRST } from './build-flags';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatConversation {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface SendMessageResult {
  conversationId: string;
  messageId: string | null;
  content: string;
  sessionToken?: string;
  isGuest?: boolean;
  /** Form edits the model proposed via tool_use (pre-fill the form / update meds). */
  proposedEdits?: ProposedEdit[];
}

export interface ChatListResult {
  conversations: ChatConversation[];
  sessionToken?: string;
  isGuest?: boolean;
}

export interface ChatError {
  error: string;
}

// ---------------------------------------------------------------------------
// Chat gate — BYOK hook point
// ---------------------------------------------------------------------------

/**
 * On the standalone build this module is swapped for byok-chat.ts (vite
 * resolveId redirect), whose gate asks for the user's own Anthropic API key.
 * On the Shopify widget there is no gate — chat is served by Brad's server.
 */
export interface ChatGate {
  needsKey: boolean;
  /** Returns an error message, or null on success. */
  saveKey(key: string): string | null;
  clearKey(): void;
}

export function getChatGate(): ChatGate | null {
  return null;
}

// ---------------------------------------------------------------------------
// Guest session token (localStorage)
// ---------------------------------------------------------------------------

const GUEST_SESSION_KEY = 'health_roadmap_guest_session';

export function getGuestSessionToken(): string | null {
  try { return localStorage.getItem(GUEST_SESSION_KEY); } catch { return null; }
}

export function setGuestSessionToken(token: string): void {
  try { localStorage.setItem(GUEST_SESSION_KEY, token); } catch { /* noop */ }
}

export function clearGuestSessionToken(): void {
  try { localStorage.removeItem(GUEST_SESSION_KEY); } catch { /* noop */ }
}

/**
 * On Shopify login, hand any guest chat history to the customer record and
 * drop the guest token (sync-embed mirrors this on non-widget pages). Returns
 * true when a migration was kicked off, so callers can clear stale guest UI.
 *
 * NEVER on local-first builds: there "logged in" is storage UX only and the
 * guest session IS the chat identity — clearing it orphaned the user's
 * conversations on every page load, and the migrate POST hit the data API as
 * an unauthed 401. The standalone build swaps in byok-chat's no-op.
 */
export function migrateGuestChatOnLogin(): boolean {
  if (LOCAL_FIRST) return false;
  const guestToken = getGuestSessionToken();
  if (!guestToken) return false;
  clearGuestSessionToken();
  fetch(`${PROXY_PATH}/api/measurements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ migrateGuestChat: guestToken }),
  }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

const TRANSIENT_RETRY_DELAY_MS = 1000;

/**
 * Fetch with ONE retry for transient upstream failures (US-15 AC3). The
 * Shopify app proxy / Fly edge occasionally answers instead of our handler —
 * machine restart or cold start mid-request — as a 5xx with a non-JSON (often
 * empty) body, unlike our handler's JSON errors (Sentry JAVASCRIPT-REMIX-1M,
 * -22). Retrying a send is safe: the server's consecutive-duplicate dedup
 * (chat-dedup.server.ts) re-serves the reply if the first attempt actually
 * completed. Deterministic answers from our handler (JSON 5xx, 429) are
 * never retried.
 */
async function fetchWithTransientRetry(input: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status < 500) return first;
  const contentType = first.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return first;
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
  return fetch(input, init);
}

/** Query-string fragments shared by the GET endpoints: the guest session token
 *  (if any) and the local-first flag (forces the server's guest path). */
function chatQueryParts(): string[] {
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
function chatBodyParts(): Record<string, unknown> {
  const sessionToken = getGuestSessionToken();
  return {
    ...(sessionToken ? { sessionToken } : {}),
    ...(LOCAL_FIRST ? { localFirst: true } : {}),
  };
}

/**
 * Cloud chat-history store on local-first builds (Phase 6): conversations live
 * in the user's OWN cloud (chat-history.json), not Brad's DB. Resolves null
 * when there's no store (never rejects — see chat-history-access.ts), and
 * callers fall back to the server CRUD path. The LOCAL_FIRST check is
 * redundant defense — the registry is only ever populated on local-first
 * builds — kept as a one-line belt against future registry callers.
 */
function cloudHistory(): Promise<ChatHistoryStore | null> {
  return LOCAL_FIRST ? getChatHistory() : Promise.resolve(null);
}

export async function listConversations(): Promise<ChatListResult | null> {
  const store = await cloudHistory();
  if (store) {
    return { conversations: store.listConversations(), isGuest: false };
  }
  try {
    const qs = chatQueryParts();
    const params = qs.length ? `?${qs.join('&')}` : '';
    const response = await fetchWithTransientRetry(`${PROXY_PATH}/api/chat${params}`);
    if (!response.ok) {
      Sentry.captureMessage('Chat listConversations failed', {
        level: 'warning',
        tags: { feature: 'chat' },
        extra: { status: response.status, contentType: response.headers.get('content-type') },
      });
      return null;
    }
    const result = await parseJsonResponse<any>(response);
    if (!result?.success) return null;

    // Persist guest session token if returned
    if (result.sessionToken) setGuestSessionToken(result.sessionToken);

    return {
      conversations: result.conversations,
      sessionToken: result.sessionToken,
      isGuest: result.isGuest,
    };
  } catch (error) {
    console.warn('Error listing conversations:', error);
    Sentry.captureException(error);
    return null;
  }
}

export async function loadConversation(conversationId: string): Promise<ChatMessage[]> {
  const store = await cloudHistory();
  if (store) return store.getMessages(conversationId);
  try {
    const params = [`conversationId=${encodeURIComponent(conversationId)}`, ...chatQueryParts()].join('&');
    const response = await fetchWithTransientRetry(
      `${PROXY_PATH}/api/chat?${params}`,
    );
    if (!response.ok) {
      Sentry.captureMessage('Chat loadConversation failed', {
        level: 'warning',
        tags: { feature: 'chat' },
        extra: { status: response.status, contentType: response.headers.get('content-type') },
      });
      return [];
    }
    const result = await parseJsonResponse<{
      success: boolean;
      messages: ChatMessage[];
    }>(response);
    if (!result?.success) return [];
    return result.messages;
  } catch (error) {
    console.warn('Error loading conversation:', error);
    Sentry.captureException(error);
    return [];
  }
}

export async function sendMessage(
  message: string,
  conversationId?: string | null,
  guestInputs?: Record<string, unknown> | null,
): Promise<{ result: SendMessageResult | null; error: ChatError | null }> {
  try {
    const response = await fetchWithTransientRetry(`${PROXY_PATH}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationId: conversationId || undefined,
        ...(guestInputs ? { guestInputs } : {}),
        ...chatBodyParts(),
      }),
    });

    const data = await parseJsonResponse<any>(response);

    // Persist guest session token if returned
    if (data?.sessionToken) setGuestSessionToken(data.sessionToken);

    if (response.status === 429) {
      return {
        result: null,
        error: { error: data?.error ?? 'rate_limited' },
      };
    }

    if (!response.ok || !data?.success) {
      Sentry.captureMessage('Chat sendMessage failed', {
        level: 'error',
        tags: { feature: 'chat' },
        extra: {
          status: response.status,
          contentType: response.headers.get('content-type'),
          dataNull: data === null,
          dataError: data?.error ?? null,
        },
      });
      return {
        result: null,
        error: { error: data?.error ?? 'Failed to send message' },
      };
    }

    // Local-first: mirror the exchange into the user's cloud history file,
    // keyed by the server's canonical conversation id. Fire-and-forget —
    // history must never block or fail the chat itself.
    void cloudHistory()
      .then((store) =>
        store?.recordExchange({
          conversationId: data.conversationId,
          isNew: !conversationId,
          userText: message,
          assistantText: data.content,
          assistantMessageId: data.messageId,
        }),
      )
      .catch(() => {});

    return {
      result: {
        conversationId: data.conversationId,
        messageId: data.messageId,
        content: data.content,
        sessionToken: data.sessionToken,
        isGuest: data.isGuest,
        ...(Array.isArray(data.proposedEdits) && data.proposedEdits.length > 0
          ? { proposedEdits: data.proposedEdits as ProposedEdit[] }
          : {}),
      },
      error: null,
    };
  } catch (error) {
    console.warn('Error sending message:', error);
    Sentry.captureException(error);
    return {
      result: null,
      error: { error: 'Network error' },
    };
  }
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  const store = await cloudHistory();
  if (store) {
    try {
      await store.deleteConversation(conversationId); // tombstone in the user's cloud
    } catch {
      return false;
    }
    // Best-effort server delete too: the server's copy exists for training
    // (anonymized), but honouring the user's delete there is the polite default.
    void deleteServerConversation(conversationId);
    return true;
  }
  return deleteServerConversation(conversationId);
}

async function deleteServerConversation(conversationId: string): Promise<boolean> {
  try {
    const response = await fetchWithTransientRetry(`${PROXY_PATH}/api/chat`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        ...chatBodyParts(),
      }),
    });
    if (!response.ok) {
      Sentry.captureMessage('Chat deleteConversation failed', {
        level: 'warning',
        tags: { feature: 'chat' },
        extra: { status: response.status, contentType: response.headers.get('content-type') },
      });
      return false;
    }
    const data = await parseJsonResponse<{ success: boolean }>(response);
    return data?.success ?? false;
  } catch (error) {
    console.warn('Error deleting conversation:', error);
    Sentry.captureException(error);
    return false;
  }
}

