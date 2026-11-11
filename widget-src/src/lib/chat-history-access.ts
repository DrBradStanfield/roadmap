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
/**
 * The page's one session: its open, in flight or done (rejecting if it
 * failed). Set before any await and replaced only once it has failed, so the
 * page never holds two sessions (US-11 AC2g): a second one would not wait
 * for the first one's saves.
 */
let session: Promise<ChatHistoryStore> | null = null;
/** What callers are served: the session, or its re-read (null: it failed). */
let store: Promise<ChatHistoryStore | null> | null = null;
/** The record's erase identity, and the one the store was read at (null: read again). */
let eraseIdentity = (): string => '';
let readAt: string | null = '';

export function setChatHistoryFactory(f: (() => Promise<ChatHistoryStore>) | null, identity = (): string => ''): void {
  factory = f;
  session = store = null;
  eraseIdentity = identity;
}

function open(): Promise<ChatHistoryStore> {
  const opening = factory!();
  session = opening;
  store = opening.catch(() => null);
  readAt = eraseIdentity();
  return opening;
}

/**
 * The cached store, read again first when the record's erase identity moved
 * since it was read (US-11 AC2g): after another device's erase it still holds
 * the erased conversations live. A failed re-read resolves null, so no list
 * from before the erase is served, but it is not kept: the next caller reads
 * again.
 */
function cached(opened: Promise<ChatHistoryStore>): Promise<ChatHistoryStore | null> {
  const now = eraseIdentity();
  if (now !== readAt) {
    store = opened.then((s) => s.reload().then(() => s, () => {
      readAt = null;
      return null;
    }), () => null);
  }
  readAt = now;
  return store!;
}

/** Erases this page has begun on its chat history: bumped as the erase's chat
 *  step starts, before its tombstones are written (US-15 AC62). */
let erasures = 0;
export function beginChatErase(): void {
  erasures += 1;
}
/** This page's erase is running, from the confirm to its result: a copy of the
 *  page's erasing mode, owed by PR 1311 (lead C21), not a pattern to copy. */
let erasing = false;
export async function whileErasing<T>(run: () => Promise<T>): Promise<T> {
  erasing = true;
  try {
    return await run();
  } finally {
    erasing = false;
  }
}
/**
 * Where the chat stands as a question is sent; null while this page's erase
 * runs, and a null mark never saves. A reply is saved to the history file only
 * if the mark is unchanged when it lands: an erase begun here since, or another
 * device's taken in, would otherwise save a turn it erased, perhaps one
 * claiming a change the erased record does not hold (US-15 AC62).
 */
export function chatMark(): string | null {
  return erasing ? null : `${erasures}|${eraseIdentity()}`;
}
/** Whether a reply asked under `mark` may still be saved. */
export function stillMarked(mark: string | null): boolean {
  return mark !== null && mark === chatMark();
}

/** The cloud chat-history store, or null (production build, no data layer, or
 *  the cloud read failed). Never rejects. */
export function getChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return Promise.resolve(null);
  return cached(session ?? open());
}

/**
 * The same store for the erase, which must know whether it was reached
 * (US-11 AC2c). A failed open REJECTS here instead of resolving null, and an
 * open that failed earlier this page is tried again rather than taken from the
 * cache. Null only when no chat layer is registered, where no history exists.
 * A successful open becomes the shared instance, so a chat panel opened
 * afterwards sees the tombstones. When the page's session failed its re-read,
 * it reads again. If that fails too, its copy is erased anyway (tombstoned
 * even when the save fails), so deleting the file by hand lasts, and the open
 * rejects unless that save got through (US-11 AC2g).
 */
export async function openChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return null;
  const earlier = session;
  const opened = earlier ?? open();
  const served = await cached(opened);
  if (served) return served;
  const held = await opened.catch(() => null);
  if (held) return held.reload().then(() => held, (e: unknown) => held.eraseAll().then(() => held, () => { throw e; }));
  return session === earlier ? open() : session;
}
