/**
 * ChatHistoryStore — chat conversations persisted to the user's OWN cloud as
 * `chat-history.json` (Phase 6), beside health-roadmap.json but a separate
 * file (Brad, firm). The session itself is health-core's ChatSession
 * (chat-session.ts, shared with the iPhone app); this module only opens it on
 * the web's RecordHost, over the SAME adapter as the roadmap store.
 *
 * Consumers: byok-chat.ts (Pages/self-host — replaces the localStorage
 * conversation cache) and chat-api.ts on local-first storefront builds
 * (conversation CRUD; the answer itself still comes from Brad's server).
 * Callers treat failures as best-effort (history must never break the chat).
 */
import { ChatSession, type StorageAdapter } from '@roadmap/health-core';
import { webRecordHost } from './web-record-host';

export type ChatHistoryStore = ChatSession;
export const ChatHistoryStore = {
  /** Load chat history from the given backend and return a ready store. */
  create: (adapter: StorageAdapter): Promise<ChatHistoryStore> => ChatSession.open(webRecordHost(adapter)),
};
