/**
 * Registry handing the cloud-backed ChatHistoryStore to the chat transports.
 *
 * chat-api.ts is bundled into the PRODUCTION widget, which must not drag in
 * the local-first storage stack — so this module holds only a factory slot
 * (type-only import, zero runtime deps). roadmap-data.ts registers the factory
 * at init time on local-first builds; on production builds nothing ever calls
 * the setter and `getChatHistory()` resolves null, leaving the server CRUD
 * path untouched.
 *
 * LAZY + best-effort by construction: the store is created on the FIRST chat
 * interaction (users who never open chat never pay the cloud read — on Drive
 * an absent chat-history.json would otherwise cost a files.list probe every
 * boot), and a failed create resolves to null (chat still answers, history
 * just doesn't persist) — consumers never need their own catch.
 */
import type { ChatHistoryStore } from '../storage/chat-history-store';

let factory: (() => Promise<ChatHistoryStore>) | null = null;
let store: Promise<ChatHistoryStore | null> | null = null;

export function setChatHistoryFactory(f: (() => Promise<ChatHistoryStore>) | null): void {
  factory = f;
  store = null;
}

/** The cloud chat-history store, or null (production build, no data layer, or
 *  the cloud read failed). Never rejects. */
export function getChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return Promise.resolve(null);
  return (store ??= factory().catch(() => null));
}
