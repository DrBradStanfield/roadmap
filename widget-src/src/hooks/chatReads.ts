/**
 * A thread's turns, read with a time limit (N1, Fable 2026-11-12): the chat
 * locks Send while the shown thread loads, so a read that hangs must still end.
 * It always settles: turns, 'gone' (a 404, US-15 AC6a) or 'failed' (an error,
 * a throw, or no answer within LOAD_TIMEOUT_MS). It stops, its timer cleared
 * and its fetch aborted, at the time limit, as soon as the store's load is no
 * longer this read (New chat, another thread: PR 1359 R2), or at an unmount
 * (`pending` holds the stop for each read in flight).
 */
import { loadConversation, type ChatMessage } from '../lib/chat-api';
import type { ChatStore } from './chatStore';

/** How long a thread's turns may take to read before the read counts as failed. */
export const LOAD_TIMEOUT_MS = 20_000;

export async function readThread(store: ChatStore, opening: number, id: string, pending: Set<() => void>): Promise<ChatMessage[] | 'gone' | 'failed'> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle = (_: 'failed') => {};
  const stop = () => { clearTimeout(timer); abort.abort(); settle('failed'); };
  const unsubscribe = store.subscribe(() => {
    const { load } = store.getSnapshot();
    if (load.phase !== 'loading' || load.opening !== opening || load.id !== id) stop();
  });
  pending.add(stop);
  try {
    const stopped = new Promise<'failed'>((resolve) => { settle = resolve; timer = setTimeout(stop, LOAD_TIMEOUT_MS); });
    const turns = await Promise.race([loadConversation(id, abort.signal), stopped]);
    return Array.isArray(turns) || turns === 'gone' ? turns : 'failed';
  } catch {
    return 'failed'; // a throw, even a synchronous one in the cloud store, is a failed read
  } finally {
    clearTimeout(timer);
    unsubscribe();
    pending.delete(stop);
  }
}
