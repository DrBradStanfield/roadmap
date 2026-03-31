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

export interface ChatPack {
  name: string;
  price: string;
  amount: number;
  url: string;
}

export interface SendMessageResult {
  conversationId: string;
  messageId: string | null;
  content: string;
  dailyRemaining: number;
  messageCredits: number;
  packs?: ChatPack[];
}

export interface ChatListResult {
  conversations: ChatConversation[];
  dailyRemaining: number;
  messageCredits: number;
  packs?: ChatPack[];
}

export interface ChatError {
  error: string;
  dailyRemaining?: number;
  messageCredits?: number;
  packs?: ChatPack[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function listConversations(): Promise<ChatListResult | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/chat`);
    if (!response.ok) return null;
    const result = await parseJsonResponse<{
      success: boolean;
      conversations: ChatConversation[];
      dailyRemaining: number;
      messageCredits: number;
    }>(response);
    if (!result?.success) return null;
    return {
      conversations: result.conversations,
      dailyRemaining: result.dailyRemaining,
      messageCredits: result.messageCredits ?? 0,
      packs: result.packs,
    };
  } catch (error) {
    console.warn('Error listing conversations:', error);
    Sentry.captureException(error);
    return null;
  }
}

export async function loadConversation(conversationId: string): Promise<ChatMessage[]> {
  try {
    const response = await fetch(
      `${PROXY_PATH}/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
    );
    if (!response.ok) return [];
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
): Promise<{ result: SendMessageResult | null; error: ChatError | null }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationId: conversationId || undefined,
      }),
    });

    const data = await parseJsonResponse<any>(response);

    if (response.status === 429) {
      return {
        result: null,
        error: {
          error: data?.error ?? 'limit_reached',
          dailyRemaining: data?.dailyRemaining ?? 0,
          messageCredits: data?.messageCredits ?? 0,
          packs: data?.packs,
        },
      };
    }

    if (!response.ok || !data?.success) {
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
        dailyRemaining: data.dailyRemaining,
        messageCredits: data.messageCredits ?? 0,
        packs: data.packs,
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
      body: JSON.stringify({ conversationId }),
    });
    if (!response.ok) return false;
    const data = await parseJsonResponse<{ success: boolean }>(response);
    return data?.success ?? false;
  } catch (error) {
    console.warn('Error deleting conversation:', error);
    Sentry.captureException(error);
    return false;
  }
}
