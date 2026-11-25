/**
 * What "Delete all my data" says once it ends, keyed by which of its steps
 * finished: the record erase, and the chat history's before it (US-11 AC5).
 * One table, so the web and the iPhone say the same words. Each sentence says
 * only what its step did: the record erase is written last, so the chat step
 * may have finished when the record erase did not.
 */

/** The chat step, once it ran: deleted, not reached, or reached and not read. */
export type EraseChatStep = 'erased' | 'unreached' | 'unread';

export type EraseOutcome =
  /** The record is erased. */
  | { record: 'erased'; chat: EraseChatStep }
  /** The erase landed nowhere, after the chat step: the record is as it was (lead S57). */
  | { record: 'not-saved'; chat: EraseChatStep }
  /** The record erase stopped with words of its own; `chat` is null when it stopped before the chat step ran. */
  | { record: 'failed'; reason: string; chat: EraseChatStep | null };

const CHAT_UNREAD = 'Your chat history could not be read, so any chats you saved are still in your cloud folder, in chat-history.json.';

/** The chat step beside an erased record. */
const CHAT_AFTER_ERASE: Record<EraseChatStep, string> = {
  erased: 'Your health record and chat history are deleted.',
  // The chat step is best-effort: an unreachable cloud must never trap the record. The page's copy is
  // tombstoned before the read that failed, so its next chat save sends them (ChatSession.eraseAll).
  unreached: 'Your health record is deleted. Your chat history could not be reached just now; it is erased on your next chat.',
  // The stored file still holds its conversations, and the failure may last (a newer schema, an
  // unreadable file): say where it still is (US-11 AC2c).
  unread: `Your health record is deleted. ${CHAT_UNREAD}`,
};

/** The chat step beside a record that was not erased. */
const CHAT_AFTER_FAILURE: Record<EraseChatStep, string> = {
  erased: 'Your chat history was deleted.',
  unreached: 'Your chat history could not be reached just now.',
  unread: CHAT_UNREAD,
};

export function eraseOutcomeWords(outcome: EraseOutcome): string {
  switch (outcome.record) {
    case 'erased':
      return CHAT_AFTER_ERASE[outcome.chat];
    case 'not-saved':
      return `Your health record was not deleted: the erase could not be saved. ${CHAT_AFTER_FAILURE[outcome.chat]} Try again.`;
    case 'failed':
      return outcome.chat ? `${outcome.reason} ${CHAT_AFTER_FAILURE[outcome.chat]}` : outcome.reason;
  }
}
