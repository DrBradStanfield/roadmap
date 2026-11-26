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
 * just doesn't persist) — consumers never need their own catch. A failed open
 * is not kept: the next caller (a turn, a list or thread read) opens again,
 * never a timer (US-15 AC69).
 */
import * as Sentry from '@sentry/react';
import type { ChatHistoryStore } from '../storage/chat-history-store';
import { recordFailure } from './error-diagnostics';

/**
 * The page's one open of the chat-history file (US-15 AC69). `attempt` only
 * grows, so a result names the attempt it began under and a late one from an
 * older attempt changes nothing. One open is in flight at a time and an open
 * session is replaced only by a reset, so the page never holds two sessions
 * (US-11 AC2g): a second one would not wait for the first one's saves.
 * `served` is what callers get: the open, or a re-read of its copy (null: it
 * failed). `readAt` is the erase identity that read is for (null: read again).
 * A re-read in flight is `opening` again, so `open` means the copy was read at
 * `readAt` and a send may take its marks at once (AC2h).
 */
type Served = Promise<ChatHistoryStore | null>;
export type ChatHistoryOpen =
  | { phase: 'closed'; attempt: number }
  | { phase: 'opening'; attempt: number; pending: Promise<ChatHistoryStore>; served: Served; readAt: string | null }
  | { phase: 'open'; attempt: number; pending: Promise<ChatHistoryStore>; served: Served; readAt: string; store: ChatHistoryStore }
  | { phase: 'failed'; attempt: number };

export type ChatHistoryOpenEvent =
  | { type: 'open-began'; pending: Promise<ChatHistoryStore>; served: Served; at: string }
  | { type: 'reread-began'; attempt: number; served: Served; at: string }
  | { type: 'opened'; attempt: number; store: ChatHistoryStore; at: string }
  | { type: 'open-failed'; attempt: number }
  | { type: 'reread-failed'; attempt: number; at: string }
  | { type: 'reset' };

export function transition(s: ChatHistoryOpen, e: ChatHistoryOpenEvent): ChatHistoryOpen {
  switch (e.type) {
    case 'reset':
      return { phase: 'closed', attempt: s.attempt + 1 };
    case 'open-began':
      return s.phase === 'closed' || s.phase === 'failed'
        ? { phase: 'opening', attempt: s.attempt + 1, pending: e.pending, served: e.served, readAt: e.at }
        : s;
    case 'reread-began':
      return (s.phase === 'opening' || s.phase === 'open') && s.attempt === e.attempt
        ? { phase: 'opening', attempt: s.attempt, pending: s.pending, served: e.served, readAt: e.at }
        : s;
    case 'opened':
      return s.phase === 'opening' && s.attempt === e.attempt && s.readAt === e.at
        ? { phase: 'open', attempt: s.attempt, pending: s.pending, served: s.served, readAt: e.at, store: e.store }
        : s;
    case 'open-failed':
      return s.phase === 'opening' && s.attempt === e.attempt ? { phase: 'failed', attempt: s.attempt } : s;
    case 'reread-failed':
      return s.phase === 'opening' && s.attempt === e.attempt && s.readAt === e.at ? { ...s, readAt: null } : s;
  }
}

let factory: (() => Promise<ChatHistoryStore>) | null = null;
let state: ChatHistoryOpen = { phase: 'closed', attempt: 0 };
const send = (e: ChatHistoryOpenEvent): void => { state = transition(state, e); };
/** The record's erase identity. */
let eraseIdentity = (): string => '';

export function setChatHistoryFactory(f: (() => Promise<ChatHistoryStore>) | null, identity = (): string => ''): void {
  factory = f;
  send({ type: 'reset' });
  eraseIdentity = identity;
}

/** Whether a history layer is registered: then chat never reads the server's history (US-15 AC69). */
export function hasChatHistoryLayer(): boolean {
  return factory !== null;
}

type Session = Extract<ChatHistoryOpen, { phase: 'opening' | 'open' }>;
const live = (): Session | null => (state.phase === 'opening' || state.phase === 'open' ? state : null);

/** The open in flight or done, or a new one when there is none (closed, or the last one failed). */
function session(): Session {
  const held = live();
  if (held) return held;
  const pending = factory!();
  const at = eraseIdentity();
  send({ type: 'open-began', pending, served: pending.catch(() => null), at });
  const { attempt } = state;
  pending.then((s) => send({ type: 'opened', attempt, store: s, at }), () => send({ type: 'open-failed', attempt }));
  return live()!;
}

/**
 * The cached store, read again first when the record's erase identity moved
 * since it was read (US-11 AC2g): after another device's erase it still holds
 * the erased conversations live. A failed re-read resolves null, so no list
 * from before the erase is served, but it is not kept: the next caller reads
 * again.
 */
function cached(held: Session): Served {
  const now = eraseIdentity();
  if (now === held.readAt) return held.served;
  const { attempt, pending } = held;
  const served = pending.then((s) => s.reload().then(() => {
    send({ type: 'opened', attempt, store: s, at: now });
    return s;
  }, () => {
    send({ type: 'reread-failed', attempt, at: now });
    return null;
  }), () => null);
  send({ type: 'reread-began', attempt, served, at: now });
  return served;
}

/** The cloud chat-history store, or null (production build, no data layer, or
 *  the cloud read failed; the next call opens again). Never rejects. */
export function getChatHistory(): Promise<ChatHistoryStore | null> {
  if (!factory) return Promise.resolve(null);
  return cached(session());
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
    const askedMarks = state.phase === 'open' && state.readAt === eraseIdentity() ? state.store.eraseMarks() : undefined;
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
  const found = live() !== null;
  const opened = session();
  const served = await cached(opened);
  if (served) return served;
  const held = await opened.pending.catch(() => null);
  if (held) return held.reload().then(() => held, (e: unknown) => held.eraseAll().then(() => held, () => { throw e; }));
  // An open this call began rejects; one it found in flight is tried once more.
  return found ? session().pending : opened.pending;
}
