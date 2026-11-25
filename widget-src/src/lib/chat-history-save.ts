/**
 * The one save of a chat exchange to the chat-history file, shared by both
 * transports (chat-api.ts, byok-chat.ts). Fire-and-forget: history never
 * blocks or fails the chat. Runtime imports are the ones chat-api.ts already
 * bundles, so the production widget brings in no storage stack.
 */
import * as Sentry from '@sentry/react';
import { hasChatHistoryLayer, type askChatHistory } from './chat-history-access';
import { chatAskedUnder, recordEraseIn } from './chat-erase';
import { recordFailure } from './error-diagnostics';
import type { ChatHistoryStore } from '../storage/chat-history-store';

type Exchange = Omit<Parameters<ChatHistoryStore['recordExchange']>[0], 'askedMarks' | 'askedUnder'>;

/** 'unsaved': a history file exists but the turn is not in it. `session` null: no file opened, so the turn is never
 *  written; a number: the save failed, and that session's working copy keeps the turn for its next save.
 *  'skipped': nothing to keep, as an erase began since the question, or there is no history file. */
export type ExchangeSave = { outcome: 'saved'; session: number } | { outcome: 'unsaved'; session: number | null } | { outcome: 'skipped' };

/** Each opened store (one working copy) by a number the chat state can hold. */
const sessions = new WeakMap<ChatHistoryStore, number>();
let lastSession = 0;
function sessionOf(store: ChatHistoryStore): number {
  if (!sessions.has(store)) sessions.set(store, ++lastSession);
  return sessions.get(store)!;
}

/**
 * Saves the exchange under the erase marks taken as its question was asked,
 * unless an erase began since (US-11 AC2h). A failed save is reported with
 * fixed words (US-15 AC47) and resolves 'unsaved', so the chat can say so
 * by the reply (US-15 AC76). Never rejects.
 */
export function saveExchange(opened: ReturnType<typeof askChatHistory>, asked: string, exchange: Exchange): Promise<ExchangeSave> {
  return opened
    .then(({ store, askedMarks }): Promise<ExchangeSave> | ExchangeSave => {
      if (chatAskedUnder() !== asked) return { outcome: 'skipped' };
      if (!store) return hasChatHistoryLayer() ? { outcome: 'unsaved', session: null } : { outcome: 'skipped' };
      const session = sessionOf(store);
      return store.recordExchange({ ...exchange, askedMarks, askedUnder: recordEraseIn(asked) }).then(
        // Not written: no copy holds the turn, so no later save writes it, and other marks stand.
        (result): ExchangeSave => (result === 'written' ? { outcome: 'saved', session }
          : result === 'closed' ? { outcome: 'skipped' } : { outcome: 'unsaved', session: null }),
        (error: unknown): ExchangeSave => {
          Sentry.captureException(recordFailure(error, 'Chat-history save failed'), { tags: { area: 'chat-history', op: 'save' } });
          return { outcome: 'unsaved', session };
        },
      );
    })
    .catch((): ExchangeSave => ({ outcome: 'unsaved', session: null })); // askChatHistory never rejects
}
