/**
 * Chat API client — conversations, messages, send/delete.
 * Uses the same Shopify app proxy path as all other API calls.
 */
import * as Sentry from '@sentry/react';
import { PROXY_PATH, parseJsonResponse } from './api';

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

export async function listConversations(): Promise<ChatListResult | null> {
  try {
    const sessionToken = getGuestSessionToken();
    const params = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
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
    const sessionToken = getGuestSessionToken();
    const params = `conversationId=${encodeURIComponent(conversationId)}${sessionToken ? '&sessionToken=' + encodeURIComponent(sessionToken) : ''}`;
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
    const sessionToken = getGuestSessionToken();
    const response = await fetch(`${PROXY_PATH}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationId: conversationId || undefined,
        ...(sessionToken ? { sessionToken } : {}),
        ...(guestInputs ? { guestInputs } : {}),
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
    const sessionToken = getGuestSessionToken();
    const response = await fetch(`${PROXY_PATH}/api/chat`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        ...(sessionToken ? { sessionToken } : {}),
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

/**
 * Prime the Anthropic prompt cache on the server. Fire-and-forget — if it
 * fails, the next real chat message just pays the cold-cache cost. No
 * sessionToken: the server's warmup branch is HMAC-only and deliberately
 * doesn't touch guest sessions.
 */
export async function triggerWarmup(): Promise<void> {
  try {
    await fetch(`${PROXY_PATH}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmupOnly: true }),
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'chat', step: 'warmup' } });
  }
}
