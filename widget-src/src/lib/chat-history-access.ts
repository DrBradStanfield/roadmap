/**
 * Registry handing the cloud-backed ChatHistoryStore to the chat transports.
 *
 * chat-api.ts is bundled into the PRODUCTION widget, which must not drag in
 * the local-first storage stack — so this module holds only a factory slot
 * (type-only import of the store; its runtime imports are the ones chat-api.ts
 * already bundles: Sentry and the fixed failure words). roadmap-data.ts registers the factory
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
import * as Sentry from '@sentry/react';
import type { ChatHistoryStore } from '../storage/chat-history-store';
import { recordFailure } from './error-diagnostics';

let factory: (() => Promise<ChatHistoryStore>) | null = null;
/**
 * The page's one session: its open, in flight or done (rejecting if it
 * failed). Set before any await and replaced only once it has failed, so the
 * page never holds two sessions (US-11 AC2g): a second one would not wait
 * for the first one's saves.
 */
let session: Promise<ChatHistoryStore> | null = null;
/** The session once its open has resolved, for what a send takes at once. */
let ready: ChatHistoryStore | null = null;
/** What callers are served: the session, or its re-read (null: it failed). */
let store: Promise<ChatHistoryStore | null> | null = null;
/** The record's erase identity, and the one the store was read at (null: read again). */
let eraseIdentity = (): string => '';
let readAt: string | null = '';
/** The erase identity the ready session's copy was read at, once that read is done. */
let readyAt: string | null = null;

export function setChatHistoryFactory(f: (() => Promise<ChatHistoryStore>) | null, identity = (): string => ''): void {
  factory = f;
  session = store = ready = null;
  eraseIdentity = identity;
}

function open(): Promise<ChatHistoryStore> {
  const opening = factory!();
  session = opening;
  ready = null;
  const at = eraseIdentity();
  opening.then((s) => { if (session === opening) { ready = s; readyAt = at; } }, () => {});
  store = opening.catch(() => null);
  readAt = at;
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
    store = opened.then((s) => s.reload().then(() => {
      readyAt = now;
      return s;
    }, () => {
      readAt = null;
      return null;
    }), () => null);
  }
  readAt = now;
  return store!;
}

/** The cloud chat-history store, or null (production build, no data layer, or
 *  the cloud read failed). Never rejects. */
export function getChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return Promise.resolve(null);
  return cached(session ?? open());
}

/**
 * The store for a question's reply, and the erase marks the question is asked
 * under (US-11 AC2h): taken at once from the open session's copy when it was
 * read at the record's erase identity, or else from the open, which reads it
 * again first (AC2g). Best-effort: a read that throws or fails gives no
 * store, so nothing is saved, and the send neither fails nor waits. Never rejects.
 */
export function askChatHistory(): Promise<{ store: ChatHistoryStore | null; askedMarks?: string[] }> {
  try {
    const askedMarks = ready && readyAt === eraseIdentity() ? ready.eraseMarks() : undefined;
    return getChatHistory()
      .then((s) => ({ store: s, askedMarks: askedMarks ?? s?.eraseMarks() }))
      .catch(unavailable);
  } catch (error) {
    return Promise.resolve(unavailable(error));
  }
}

function unavailable(error: unknown): { store: null } {
  Sentry.captureException(recordFailure(error, 'Chat-history read failed'), { tags: { area: 'chat-history', op: 'ask' } });
  return { store: null };
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
