/**
 * Registry handing the cloud-backed ChatHistoryStore to the chat transports.
 *
 * chat-api.ts is bundled into the PRODUCTION widget, which must not drag in
 * the local-first storage stack — so this module holds only a slot (type-only
 * import, zero runtime deps). roadmap-data.ts populates it at init time on
 * local-first builds; on production builds nothing ever calls the setter and
 * `getChatHistory()` stays null, leaving the server CRUD path untouched.
 */
import type { ChatHistoryStore } from '../storage/chat-history-store';

let chatHistory: Promise<ChatHistoryStore> | null = null;

export function setChatHistory(store: Promise<ChatHistoryStore> | null): void {
  chatHistory = store;
}

/**
 * The cloud chat-history store, or null when this build/session doesn't have
 * one (production widget, or no data layer initialised). The promise rejects
 * if the initial cloud read failed — callers catch and fall back (history is
 * best-effort everywhere).
 */
export function getChatHistory(): Promise<ChatHistoryStore> | null {
  return chatHistory;
}
