/**
 * BroadcastChannel sync layer for cross-instance chat state.
 * All chat widget instances (inline, FAB, embed) share this channel.
 * Works same-tab (separate React roots) and cross-tab (same origin).
 */

import type { ChatConversation, ChatMessage } from './chat-api';

const CHANNEL_NAME = 'hr_chat_sync';

export type SyncMessage =
  | { instanceId: string; type: 'input'; payload: { text: string }; ts: number }
  | { instanceId: string; type: 'state'; payload: { conversations: ChatConversation[]; activeConversationId: string | null; messages: ChatMessage[]; isLoading: boolean; error: string | null }; ts: number }
  | { instanceId: string; type: 'thread-new'; payload: Record<string, never>; ts: number }
  | { instanceId: string; type: 'thread-deleted'; payload: { id: string }; ts: number };

export function generateInstanceId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    window.addEventListener('beforeunload', () => {
      channel?.close();
      channel = null;
    }, { once: true });
  }
  return channel;
}

export function postSync(msg: SyncMessage): void {
  getChannel()?.postMessage(msg);
}

export function subscribeSync(handler: (msg: SyncMessage) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => handler(e.data as SyncMessage);
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

// rAF-throttled input broadcaster — batches keystrokes to one broadcast per animation frame
let rafId: number | null = null;
let pendingInput: { instanceId: string; text: string } | null = null;

export function postInputSync(instanceId: string, text: string): void {
  pendingInput = { instanceId, text };
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (!pendingInput) return;
    postSync({
      instanceId: pendingInput.instanceId,
      type: 'input',
      payload: { text: pendingInput.text },
      ts: Date.now(),
    });
    pendingInput = null;
  });
}
