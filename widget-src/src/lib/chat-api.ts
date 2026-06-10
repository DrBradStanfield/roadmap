/**
 * Chat API client — conversations, messages, send/delete.
 * Uses the same Shopify app proxy path as all other API calls.
 */
import * as Sentry from '@sentry/react';
import { PROXY_PATH, parseJsonResponse } from './api';

// Set by the Shopify v2 vite build (undefined → false in the production widget).
// When true, the user's plan is client-side, so sendMessage tells the server to
// trust the client-supplied context instead of looking for a DB record.
const LOCAL_FIRST = import.meta.env.VITE_LOCAL_FIRST === 'true';

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

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

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

export async function listConversations(): Promise<ChatListResult | null> {
  try {
    const qs = chatQueryParts();
    const params = qs.length ? `?${qs.join('&')}` : '';
    const response = await fetch(`${PROXY_PATH}/api/chat${params}`);
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
  try {
    const params = [`conversationId=${encodeURIComponent(conversationId)}`, ...chatQueryParts()].join('&');
    const response = await fetch(
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
    const response = await fetch(`${PROXY_PATH}/api/chat`, {
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

    return {
      result: {
        conversationId: data.conversationId,
        messageId: data.messageId,
        content: data.content,
        sessionToken: data.sessionToken,
        isGuest: data.isGuest,
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
  try {
    const response = await fetch(`${PROXY_PATH}/api/chat`, {
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

