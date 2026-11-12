/**
 * The web chat's one copy of its turn and shown chat (the chat-turn reducer,
 * packages/health-core/src/chat-turn.ts), shaped like createEraseStore:
 * `dispatch` steps the pure `transition`, swaps the state, tells subscribers,
 * then runs the effects in order. `getSnapshot` is synchronous, so an async
 * step reads the live state, never a ref. This is the only caller of
 * `transition` (useChatState.one-writer.test.ts).
 */
import { transition, type ChatEvent, type ChatState, type Effect } from '@roadmap/health-core/chat-turn';

export interface ChatStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ChatState;
  /** Step the state, tell subscribers, then run the effects; resolves when their async work (a request, a read) ends. */
  dispatch: (event: ChatEvent) => Promise<void>;
}

export function createChatStore(initial: ChatState, run: (effect: Effect) => Promise<void> | void): ChatStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => state,
    dispatch(event) {
      const step = transition(state, event);
      if (step.state !== state) {
        state = step.state;
        for (const listener of [...listeners]) listener();
      }
      return Promise.all(step.effects.map(run)).then(() => {});
    },
  };
}

/** Every chat mounted on the page: an erase the page now shows reaches each one (useErase's mark effect, design R6). */
const live = new Set<ChatStore>();
export function joinChats(store: ChatStore): () => void {
  live.add(store);
  return () => { live.delete(store); };
}
export function tellChats(event: ChatEvent): void {
  for (const store of [...live]) void store.dispatch(event);
}
