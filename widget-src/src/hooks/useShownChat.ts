/**
 * The chat on screen and its turns, each with its one writer (US-67 AC2):
 * `openChat` for the chat, `showMessages` for the turns. Each sets the ref an
 * async step reads and the state in one call, so a step resolving before the
 * next render never sees the chat it left as shown. Split from useChatState
 * (file budget); useChatState.one-writer.test.ts holds the rule.
 */
import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/chat-api';

/** The chat on screen, carrying the server's `id` as data. Its `key` is the identity a reply is
 *  checked against (US-67 AC2): a new chat mints a fresh one, so two unsaved chats never match;
 *  a saved thread's is its own, so reopening it mid-send still shows its reply (US-15 AC7a). */
let chatSeq = 0;
const mintChat = (id: string | null) => ({ key: id === null ? `new:${++chatSeq}` : `thread:${id}`, id });

export function useShownChat(prefetched: { activeConversationId: string | null; messages: ChatMessage[] } | null | undefined) {
  const [shownChat, setShownChat] = useState(() => mintChat(prefetched?.activeConversationId ?? null));
  const [messages, setMessages] = useState<ChatMessage[]>(prefetched?.messages ?? []);
  const shownChatRef = useRef(shownChat);
  const messagesRef = useRef(messages);
  /** The shown chat's turns, ref and state in one call, as openChat does for the chat itself. */
  const showMessages = useCallback((list: ChatMessage[]) => { messagesRef.current = list; setMessages(list); }, []);
  /** The ONE writer of the chat shown (US-67 AC2): the ref a landing reply reads and the state, in one
   *  call, so a reply resolving before the next render never sees the chat it left as shown. */
  const openChat = useCallback((id: string | null) => { shownChatRef.current = mintChat(id); setShownChat(shownChatRef.current); }, []);
  return { shownChat, shownChatRef, messages, messagesRef, showMessages, openChat };
}
