/**
 * US-11 AC2b (D4 decision D2, 2026-10-21): a conversation deleted, or every
 * conversation erased, while a chat save is still in the air stays deleted
 * in memory. The cloud save used to put its result IN PLACE of the working
 * copy, so a save that started before the delete and answered after it
 * brought the conversation back on screen until a reload.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud, type WriteResult } from '@roadmap/health-core';
import { ChatHistoryStore } from './chat-history-store';

/** A cloud whose first write lands at once but answers only when released. */
class SlowFirstAnswer extends MemoryAdapter {
  private held = true;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  async write(fileName: string, body: object, expected: string | null): Promise<WriteResult> {
    const result = await super.write(fileName, body, expected);
    if (this.held) {
      this.held = false;
      await this.gate;
    }
    return result;
  }
}

async function inFlight() {
  const adapter = new SlowFirstAnswer(new MemoryCloud());
  const store = await ChatHistoryStore.create(adapter);
  const first = store.recordExchange({ conversationId: 'c1', isNew: true, userText: 'my ldl is 3.2', assistantText: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 0)); // the first save has written, and waits
  // A second exchange is made meanwhile. This session's saves run one at a
  // time (US-11 AC2e), so its save waits behind the first.
  const second = store.recordExchange({ conversationId: 'c2', isNew: true, userText: 'and my blood pressure', assistantText: 'ok' });
  return { adapter, store, first, second };
}

describe('a chat save in flight never undoes a delete made meanwhile (US-11 AC2b)', () => {
  it('deleteConversation', async () => {
    const { adapter, store, first, second } = await inFlight();
    const deleting = store.deleteConversation('c1');
    expect(store.listConversations().map((c) => c.id)).toEqual(['c2']);
    adapter.release();
    await Promise.all([first, second, deleting]);
    expect(store.listConversations().map((c) => c.id)).toEqual(['c2']);
    expect(store.getMessages('c1')).toEqual([]);
  });

  it('eraseAll', async () => {
    const { adapter, store, first, second } = await inFlight();
    const erasing = store.eraseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.release();
    await Promise.all([first, second, erasing]);
    expect(store.listConversations()).toEqual([]);
  });
});
