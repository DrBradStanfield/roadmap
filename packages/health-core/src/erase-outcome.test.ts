/**
 * US-11 AC13: what "Delete all my data" says, one sentence set per outcome,
 * read by the web (useErase) and, from the next engine release, the iPhone.
 * Every outcome is listed: a new step or state must add its row here.
 */
import { describe, expect, it } from 'vitest';
import { eraseOutcomeWords, type EraseChatStep, type EraseOutcome } from './erase-outcome';

const REASON = 'Your cloud storage could not be reached, so nothing was deleted. Try again once it answers.';

const TABLE: Array<[EraseOutcome, string]> = [
  [{ record: 'erased', chat: 'erased' }, 'Your health record and chat history are deleted.'],
  [{ record: 'erased', chat: 'unreached' }, 'Your health record is deleted. Your chat history could not be reached just now; it is erased on your next chat.'],
  [{ record: 'erased', chat: 'unread' }, 'Your health record is deleted. Your chat history could not be read, so any chats you saved are still in your cloud folder, in chat-history.json.'],
  [{ record: 'not-saved', chat: 'erased' }, 'Your health record was not deleted: the erase could not be saved. Your chat history was deleted. Try again.'],
  [{ record: 'not-saved', chat: 'unreached' }, 'Your health record was not deleted: the erase could not be saved. Your chat history could not be reached just now. Try again.'],
  [{ record: 'not-saved', chat: 'unread' }, 'Your health record was not deleted: the erase could not be saved. Your chat history could not be read, so any chats you saved are still in your cloud folder, in chat-history.json. Try again.'],
  [{ record: 'failed', reason: REASON, chat: null }, REASON],
  [{ record: 'failed', reason: 'Saving failed.', chat: 'erased' }, 'Saving failed. Your chat history was deleted.'],
  [{ record: 'failed', reason: 'Saving failed.', chat: 'unreached' }, 'Saving failed. Your chat history could not be reached just now.'],
  [{ record: 'failed', reason: 'Saving failed.', chat: 'unread' }, 'Saving failed. Your chat history could not be read, so any chats you saved are still in your cloud folder, in chat-history.json.'],
];

describe('US-11 AC13: the erase outcome words', () => {
  it.each(TABLE)('%j says its sentence', (outcome, words) => {
    expect(eraseOutcomeWords(outcome)).toBe(words);
  });

  it('the table covers every record state with every chat step', () => {
    const chats: EraseChatStep[] = ['erased', 'unreached', 'unread'];
    for (const record of ['erased', 'not-saved', 'failed'] as const) {
      for (const chat of chats) expect(TABLE.some(([o]) => o.record === record && o.chat === chat)).toBe(true);
    }
    expect(TABLE.some(([o]) => o.record === 'failed' && o.chat === null)).toBe(true);
  });

  it('never says the record is deleted unless it is, nor the chat history unless the chat step deleted it', () => {
    for (const [outcome, words] of TABLE) {
      expect(/health record (is|and chat history are) deleted/.test(words)).toBe(outcome.record === 'erased');
      expect(/chat history (was|are) deleted/.test(words)).toBe(outcome.chat === 'erased');
      expect(words).not.toMatch(/  |—/);
    }
  });
});
