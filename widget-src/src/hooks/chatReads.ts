/**
 * A thread's turns, read with a time limit (N1, Fable 2026-11-12): the chat
 * locks Send while the shown thread loads, so a read that hangs must still end.
 * It always settles: turns, 'gone' (a 404, US-15 AC6a) or 'failed' (an error,
 * a throw, or no answer within LOAD_TIMEOUT_MS). The time limit aborts the
 * read and is cleared when it lands; `pending` holds the stop for each read in
 * flight, so an unmount clears its timer too.
 */
import { loadConversation, type ChatMessage } from '../lib/chat-api';

/** How long a thread's turns may take to read before the read counts as failed. */
export const LOAD_TIMEOUT_MS = 20_000;

export async function readThread(id: string, pending: Set<() => void>): Promise<ChatMessage[] | 'gone' | 'failed'> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); abort.abort(); };
  pending.add(stop);
  try {
    const timedOut = new Promise<'failed'>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve('failed'); }, LOAD_TIMEOUT_MS); });
    const turns = await Promise.race([loadConversation(id, abort.signal), timedOut]);
    return Array.isArray(turns) || turns === 'gone' ? turns : 'failed';
  } catch {
    return 'failed'; // a throw, even a synchronous one in the cloud store, is a failed read
  } finally {
    clearTimeout(timer);
    pending.delete(stop);
  }
}
