/**
 * The chat on screen and its turns, each with its one writer (US-67 AC2):
 * `openChat` for the chat, `showMessages` for the turns. Each sets the ref an
 * async step reads and the state in one call, so a step resolving before the
 * next render never sees the chat it left as shown. Split from useChatState
 * (file budget); useChatState.one-writer.test.ts holds the rule.
 *
 * Every async step of the chat (a streamed line, a reply, the thread list, a
 * thread's turns) takes `askNow()` as it starts and passes `stands()` before
 * it touches the screen (Fable 2026-11-12, US-15 AC62): one identity, one test.
 */
import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/chat-api';

/** What an async step was asked under: the chat shown (its key) and the erase
 *  shown. A load also names the turns it would replace, since a reply or
 *  another tab's turns landing meanwhile are newer (US-15 AC7a). */
export interface Asked {
  key: string;
  erase: string;
  turns?: ChatMessage[];
}

/** The erase half of the identity: roadmap-data's `askedUnder` and
 *  `stillShown`, the pair US-16's `replyStanding` reads (US-16 AC2a). */
export interface EraseCheck {
  askedUnder: () => string;
  stillShown: (asked: string) => boolean;
}
/** Off the widget (the bubble, the embed) the chat follows no erase (lead C12). */
const NO_ERASE: EraseCheck = { askedUnder: () => '', stillShown: () => true };

/** The chat on screen, carrying the server's `id` as data. Its `key` is the identity a reply is
 *  checked against (US-67 AC2): a new chat mints a fresh one, so two unsaved chats never match;
 *  a saved thread's is its own, so reopening it mid-send still shows its reply (US-15 AC7a).
 *  An erase empties the chat in place and passes its key on (US-15 AC62). */
let chatSeq = 0;
const mintChat = (id: string | null, key?: string) => ({ key: key ?? (id === null ? `new:${++chatSeq}` : `thread:${id}`), id });

export function useShownChat(
  prefetched: { activeConversationId: string | null; messages: ChatMessage[] } | null | undefined,
  eraseCheck: EraseCheck | null | undefined,
) {
  const [shownChat, setShownChat] = useState(() => mintChat(prefetched?.activeConversationId ?? null));
  const [messages, setMessages] = useState<ChatMessage[]>(prefetched?.messages ?? []);
  const shownChatRef = useRef(shownChat);
  const messagesRef = useRef(messages);
  const check = useRef(eraseCheck ?? NO_ERASE);
  check.current = eraseCheck ?? NO_ERASE;
  /** The shown chat's turns, ref and state in one call, as openChat does for the chat itself. */
  const showMessages = useCallback((list: ChatMessage[]) => { messagesRef.current = list; setMessages(list); }, []);
  /** The ONE writer of the chat shown (US-67 AC2): the ref a landing reply reads and the state, in one
   *  call, so a reply resolving before the next render never sees the chat it left as shown. */
  const openChat = useCallback((id: string | null, key?: string) => { shownChatRef.current = mintChat(id, key); setShownChat(shownChatRef.current); }, []);
  /** The identity a step starts under; `turns` for a load, which replaces the turns shown. */
  const askNow = useCallback((turns = false): Asked => (
    { key: shownChatRef.current.key, erase: check.current.askedUnder(), ...(turns ? { turns: messagesRef.current } : {}) }
  ), []);
  /** Where a step asked under `asked` stands: its chat still shown, and its erase still shown. */
  const where = useCallback((asked: Asked) => ({
    stayed: asked.key === shownChatRef.current.key && (asked.turns === undefined || asked.turns === messagesRef.current),
    current: check.current.stillShown(asked.erase),
  }), []);
  /** The one test every async step passes before it touches the screen. */
  const stands = useCallback((asked: Asked) => { const { stayed, current } = where(asked); return stayed && current; }, [where]);
  return { shownChat, shownChatRef, messages, messagesRef, showMessages, openChat, askNow, where, stands };
}
