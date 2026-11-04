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
/** The record's erase identity, and the one the cached store was read at. */
let eraseIdentity = (): string => '';
let readAt = '';

export function setChatHistoryFactory(f: (() => Promise<ChatHistoryStore>) | null, identity = (): string => ''): void {
  factory = f;
  store = null;
  eraseIdentity = identity;
}

/**
 * The cached store, read again first when the record's erase identity moved
 * since it was read (US-11 AC2g): after another device's erase it still holds
 * the erased conversations live. A failed re-read resolves null, as a failed
 * open does, so no list from before the erase is served.
 */
function cached(): Promise<ChatHistoryStore | null> | null {
  const now = eraseIdentity();
  if (store && now !== readAt) store = store.then((s) => s && s.reload().then(() => s, () => null));
  readAt = now;
  return store;
}

/** The cloud chat-history store, or null (production build, no data layer, or
 *  the cloud read failed). Never rejects. */
export function getChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return Promise.resolve(null);
  return cached() ?? (store = factory().catch(() => null));
}

/**
 * The same store for the erase, which must know whether it was reached
 * (US-11 AC2c). A failed open REJECTS here instead of resolving null, and an
 * open that failed earlier this page is tried again rather than taken from the
 * cache. Null only when no chat layer is registered, where no history exists.
 * A successful open becomes the shared instance, so a chat panel opened
 * afterwards sees the tombstones.
 */
export async function openChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return null;
  const open = await cached();
  if (open) return open;
  const opening = factory();
  store = opening.catch(() => null);
  return opening;
}
