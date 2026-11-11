/**
 * Shared chat state hook used by ChatSection (bubble) and ChatEmbed (inline panel).
 * Handles all data fetching, API calls, optimistic updates, and BroadcastChannel sync.
 * UI-only state (isExpanded, showThreads, etc.) stays in the consuming component.
 */

import { Sentry } from '../lib/sentry';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  listConversations,
  loadConversation,
  sendMessage,
  deleteConversation,
  type ChatApproach,
  type ChatConversation,
  type ChatMessage,
} from '../lib/chat-api';
import { postSync, postInputSync, subscribeSync, generateInstanceId, type SyncState } from '../lib/chat-sync';
import { useChatBusy } from './useChatBusy';
import { useOffline } from './useOffline';
import { useShownChat } from './useShownChat';
import { cutText } from '@roadmap/health-core/chat-history';
import type { ChatContextPayload } from '@roadmap/health-core/chat-context';
import type { ProposedEdit } from '@roadmap/health-core/chat-edits';
import type { ChatEditRefusal } from '@roadmap/health-core/chat-edit-refusals';
import { useSubscriptionCards } from './useSubscriptionCards';
import { NO_PENDING, useChatStream } from './useChatStream';
import { CHAT_CLEARED_BY_REMOTE_ERASE } from '@roadmap/health-core/erase';
export type { SubscriptionCardState } from './useSubscriptionCards';

export interface ChatPrefetchData {
  conversations: ChatConversation[];
  messages: ChatMessage[];
  activeConversationId: string | null;
}

/** Reads the health context sent with each message, as it is sent (US-15 AC10). */
export type ChatContextSource = () => ChatContextPayload | null;

interface UseChatStateOptions {
  isLoggedIn: boolean;
  guestInputs?: ChatContextSource;
  prefetchedData?: ChatPrefetchData | null;
  onRemoteConversationSelected?: () => void;
  /** Where the form edits the model proposes via tool_use go (pre-fill / med update). */
  onProposeEdit?: ChatEditTarget;
  /** The erase the page shows, and whether this tab's erase runs (US-15
   *  AC62). A move clears the conversation and drops a reply asked before it.
   *  Null off the widget (the bubble, the embed): no erase to follow. */
  erase?: ChatErase | null;
}

export interface ChatErase {
  shown: string;
  erasing: boolean;
}

/** A reply's form edits (US-16): `ask` reads the erase the question is asked
 *  under as it is sent; `take` gets the reply's edits with it, so they never
 *  land on a record erased since (US-16 AC2a). `leave`: the conversation
 *  switched (New chat, or a saved chat opened). */
export interface ChatEditTarget {
  ask: () => string;
  /** `stayed`: the chat the question was sent from (its local identity) is still shown. `refusals`: the parts
   *  refused as unreadable (US-67 AC2), their edits already left out. */
  take: (edits: ProposedEdit[], asked: string, stayed: boolean, refusals?: ChatEditRefusal[]) => void;
  leave: () => void;
}

/** This instance's chat state, to every other instance (US-15 AC17c names its fields). */
const postState = (instanceId: string, erase: string | undefined, payload: SyncState) =>
  postSync({ instanceId, type: 'state', payload: { ...payload, erase: erase ?? null }, ts: Date.now() });

export const MAX_CHARS = 8000;
const CUT_NOTICE = `Your message was cut at ${MAX_CHARS.toLocaleString('en')} characters.`;

/** Enter sends, Shift+Enter is a new line, and an Enter that commits an input method's composition only commits it
 *  (US-15 AC26a): Chrome and Firefox mark it `isComposing`, Safari sends it just after with keyCode 229. */
export function sendsOnEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

export function useChatState({ isLoggedIn, guestInputs, prefetchedData, onRemoteConversationSelected, onProposeEdit, erase }: UseChatStateOptions) {
  const [instanceId] = useState(generateInstanceId);
  // The erase the conversation belongs to, the thread on screen when the last
  // erase cleared it, and whether this tab's erase has run since the last move:
  // a move it made is its own, said by its alert (US-15 AC62). `ownRun` and the
  // page's erasing copy are a hidden mode owed by PR 1311 (lead C21): not a pattern to copy.
  const shown = erase?.shown;
  const erasing = erase?.erasing ?? false;
  const eraseRef = useRef(shown);
  const clearedFrom = useRef<string | null>(null);
  const ownRun = useRef(false);
  const erasingRef = useRef(erasing);
  erasingRef.current = erasing;
  // Another device's erase cleared the chat: said once, until dismissed or the next send.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;

  const [conversations, setConversations] = useState<ChatConversation[]>(prefetchedData?.conversations ?? []);
  // The chat on screen and its turns, each with its one writer (hooks/useShownChat).
  const { shownChat, shownChatRef, messages, messagesRef, showMessages, openChat } = useShownChat(prefetchedData);
  const activeConversationId = shownChat.id;
  const [inputText, setInputText] = useState('');
  // isLocalSender: true only on the instance that triggered the send — controls animation
  const [isLocalSender, setIsLocalSender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(!!prefetchedData);
  // The reply as it streams in (US-15 AC16/AC17/AC20), on the sending instance only (hooks/useChatStream).
  const { pending, handleDelta, endStream } = useChatStream();
  // The chat the reply in flight was sent from (its key): the stream shows only there (US-15 AC7a).
  const [sendingChat, setSendingChat] = useState<string | null>(null);
  // A landed answer's thinking summary and articles read, by message id, for
  // this session only (AC17/AC22). Never persisted: not in `messages` (so not synced
  // to other tabs or written to the user's cloud chat history) and never sent to the server.
  const [approachById, setApproachById] = useState<Record<string, ChatApproach>>({});
  // US-59: subscription change cards, by assistant message id, this tab only (hooks/useSubscriptionCards).
  const { cardsById, setCardsById, confirmSubscription, dismissSubscription } = useSubscriptionCards();
  const isOffline = useOffline();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Keep the latest onProposeEdit in a ref so handleSend's closure always fires
  // the current callback without re-creating the (memoised) handler.
  const onProposeEditRef = useRef(onProposeEdit);
  useEffect(() => { onProposeEditRef.current = onProposeEdit; }, [onProposeEdit]);

  // Refs for current values needed inside async callbacks and subscriptions
  const conversationsRef = useRef(conversations);
  const inputTextRef = useRef(inputText);
  const isLoadingConvsRef = useRef(false);
  // Busy while any tab's send is in flight, each tracked on its own (US-15 AC17c).
  const { isLoading, busyNow, ownSending, startOwnSend, endOwnSend, onRemote } = useChatBusy();
  // Bumped by each thread load and by a reply landing on screen: a load that
  // started before either is stale (US-15 AC7a).
  const loadGenRef = useRef(0);
  useEffect(() => {
    conversationsRef.current = conversations;
    inputTextRef.current = inputText;
  }, [conversations, inputText]);

  // BroadcastChannel subscription — sync state from other instances
  useEffect(() => {
    const unsubscribe = subscribeSync((msg) => {
      if (msg.instanceId === instanceId) return;

      if (msg.type === 'input') {
        // Only mirror if this instance's input isn't focused (focus = authoritative)
        if (document.activeElement !== inputRef.current) {
          setInputText(msg.payload.text);
        }
        return;
      }

      if (msg.type === 'state') {
        const { payload } = msg;
        // A tab at another erase, or one that names none (the bubble, the embed, an older
        // bundle): its busy state counts, its conversation never mirrors in (US-15 AC62).
        if (eraseRef.current !== undefined && (payload.erase ?? undefined) !== eraseRef.current) {
          onRemote(msg.instanceId, payload.sending, payload.isLoading);
          return;
        }
        if (payload.activeConversationId !== shownChatRef.current.id) {
          onRemoteConversationSelected?.();
          onProposeEditRef.current?.leave();
          openChat(payload.activeConversationId);
        }
        setConversations(payload.conversations);
        showMessages(payload.messages);
        // That tab's own send, tracked apart from this tab's (US-15 AC17c).
        onRemote(msg.instanceId, payload.sending, payload.isLoading);
        if (!ownSending()) setIsLocalSender(false);
        setError(payload.error);
        return;
      }

      if (msg.type === 'thread-new') {
        openChat(null);
        showMessages([]);
        setError(null);
        onProposeEditRef.current?.leave();
        return;
      }

      if (msg.type === 'thread-deleted') {
        const { id } = msg.payload;
        setConversations(prev => prev.filter(c => c.id !== id));
        if (shownChatRef.current.id === id) {
          openChat(null);
          showMessages([]);
          onProposeEditRef.current?.leave();
        }
        return;
      }
    });
    return unsubscribe;
  }, [instanceId, onRemoteConversationSelected, onRemote, openChat]);

  const dropThread = useCallback((id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (shownChatRef.current.id === id) {
      openChat(null);
      showMessages([]);
      onProposeEditRef.current?.leave();
    }
  }, [openChat]);

  const loadConversationsIfNeeded = useCallback(async () => {
    if (hasLoadedRef.current || isLoadingConvsRef.current) return;
    hasLoadedRef.current = true;
    isLoadingConvsRef.current = true;
    const result = await listConversations();
    isLoadingConvsRef.current = false;
    if (result) {
      setConversations(result.conversations);
      if (!isLoggedIn && result.conversations.length > 0) {
        const latest = result.conversations[0];
        openChat(latest.id);
        const gen = ++loadGenRef.current;
        const msgs = await loadConversation(latest.id);
        if (!msgs) { dropThread(latest.id); return; }
        // The guest opened another thread, or a reply landed, meanwhile (US-15 AC7a).
        if (shownChatRef.current.id !== latest.id || gen !== loadGenRef.current) return;
        showMessages(msgs);
      }
    }
  }, [isLoggedIn, dropThread, openChat]);

  // An erase the page now shows clears the conversation: its turns are erased,
  // so none shows or goes back as history, and the list is read again (US-15
  // AC62). The edits' notice stays: it outlasts the erase it reports (US-16 AC2e).
  useEffect(() => {
    if (erasing) ownRun.current = true;
    const own = ownRun.current;
    if (!erasing) ownRun.current = false; // this tab's erase ended, moved or refused
    if (shown === eraseRef.current) return;
    eraseRef.current = shown;
    // Another device's erase says why the chat emptied, in place of a refused reply's notice (US-16 AC2e).
    if (!own) onProposeEditRef.current?.leave();
    setNotice(own ? null : CHAT_CLEARED_BY_REMOTE_ERASE);
    clearedFrom.current = shownChatRef.current.id;
    openChat(null);
    showMessages([]);
    loadGenRef.current++; // a thread load started before the erase is stale
    setConversations([]);
    setApproachById({});
    setCardsById({});
    setError(null);
    hasLoadedRef.current = false;
    void loadConversationsIfNeeded();
  }, [shown, erasing, loadConversationsIfNeeded, setCardsById, openChat, showMessages]);

  const selectConversation = useCallback(async (id: string) => {
    openChat(id);
    setError(null);
    onProposeEditRef.current?.leave();
    const gen = ++loadGenRef.current;
    const msgs = await loadConversation(id);
    // The server no longer recognizes this guest thread (US-15 AC6a), even if another is open now.
    if (!msgs) { dropThread(id); return; }
    // Another thread was opened, or a reply landed, meanwhile (US-15 AC7a).
    if (shownChatRef.current.id !== id || gen !== loadGenRef.current) return;
    showMessages(msgs);
    postState(instanceId, eraseRef.current, {
      conversations: conversationsRef.current,
      activeConversationId: id,
      messages: msgs,
      isLoading: busyNow(), // for older bundles: a reply still in flight is not over (US-15 AC7a)
      sending: ownSending(),
      error: null,
    });
  }, [instanceId, dropThread, openChat]);

  const startNewChat = useCallback(() => {
    openChat(null);
    showMessages([]);
    setError(null);
    onProposeEditRef.current?.leave();
    inputRef.current?.focus();
    postSync({ instanceId, type: 'thread-new', payload: {}, ts: Date.now() });
  }, [instanceId, openChat]);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || busyNow() || erasingRef.current) return; // read now: a second press before the re-render sends nothing
    if (trimmed.length > MAX_CHARS) return;
    if (isOffline) { setError("You're offline. Check your connection and try again."); return; }

    setError(null);
    setNotice(null);
    const sentChat = shownChatRef.current;
    const eraseAtSend = eraseRef.current;
    const currentConvId = sentChat.id;
    const currentConvs = conversationsRef.current;

    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    const history = messagesRef.current; // the turns before this question, sent with it
    const optimisticMessages = [...history, optimisticMsg];

    showMessages(optimisticMessages);
    setInputText('');
    inputTextRef.current = ''; // the box is empty now, before the re-render (US-15 AC57)
    postInputSync(instanceId, '');
    startOwnSend();
    setIsLocalSender(true);
    setSendingChat(sentChat.key);

    postState(instanceId, eraseRef.current, {
      conversations: currentConvs,
      activeConversationId: currentConvId,
      messages: optimisticMessages,
      isLoading: true,
      sending: true,
      error: null,
    });

    // Always send the plan as chat context: local-first (v2) means the server
    // has no health data for logged-in customers either (the v1 tables were
    // purged June 2026), so this is the only context the answer gets. Every
    // surface builds it with chatContextOf: the widget from its own state, the
    // blog bubble and the chatbot embed from the widget's saved copy. The
    // reader runs here, so each message carries what is saved now, even a save
    // made after the page loaded (US-15 AC10). None degrades to the empty context.
    // A throw before the request (reading the plan for context) is a failed
    // send like any other: the chat frees and the question goes back (US-15 AC17b).
    const asked = onProposeEditRef.current?.ask() ?? ''; // the turn carries it to the reply (US-16 AC2a)
    const { result, error: sendError } = await (async () => sendMessage(
      trimmed,
      currentConvId,
      guestInputs?.() ?? null,
      history,
      handleDelta,
      Boolean(onProposeEditRef.current),
    ))().catch(() => {
      // A fixed message: the thrown error can quote the saved plan, which holds health values.
      Sentry.captureMessage('Chat context read failed', { tags: { feature: 'chat' } });
      return { result: null, error: { error: 'Something went wrong. Please try again.' } };
    });
    endOwnSend(); // another tab's send may still be in flight (US-15 AC17c)
    const approach = endStream();
    // Another thread was opened while the reply was in flight (US-15 AC7a): it stays
    // on screen, and the reply stays with the thread it was sent from.
    const shownId = shownChatRef.current.id;
    // An erase since the question cleared its thread: the turn is erased too (US-15 AC62).
    const erased = eraseRef.current !== eraseAtSend;
    const stayed = !erased && shownChatRef.current.key === sentChat.key;
    // The list as it is now: a thread dropped during the send stays dropped (US-15 AC7a).
    const convsNow = conversationsRef.current;

    if (sendError) {
      const withoutOptimistic = stayed ? optimisticMessages.filter(m => m.id !== optimisticMsg.id) : messagesRef.current;
      showMessages(withoutOptimistic);
      // The question leaves the thread, so it goes back in the box, unless
      // something new was typed meanwhile, as Stop does on the iPhone (US-15 AC57).
      if (stayed && !inputTextRef.current) {
        setInputText(trimmed);
        postInputSync(instanceId, trimmed);
      }
      setError(sendError.error);
      setIsLocalSender(false);
      postState(instanceId, eraseRef.current, {
        conversations: convsNow,
        activeConversationId: shownId,
        messages: withoutOptimistic,
        isLoading: false,
        sending: false,
        error: sendError.error,
      });
      return;
    }

    if (result) {
      const assistantMsg: ChatMessage = {
        id: result.messageId ?? `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.content,
        createdAt: new Date().toISOString(),
        ...(result.isFallback ? { isFallback: true } : {}),
      };
      // chat-api moved the message to a new thread when the server no longer
      // recognized this one (US-15 AC6a): show that thread, not the old turns,
      // and drop the old thread from the list, since opening it would 404.
      const restarted = currentConvId !== null && result.conversationId !== currentConvId;
      const finalMessages = stayed ? [...(restarted ? [optimisticMsg] : optimisticMessages), assistantMsg] : messagesRef.current;
      if (stayed) loadGenRef.current++; // a load started before the reply would replace it
      if (stayed && restarted) onProposeEditRef.current?.leave(); // a new thread (US-15 AC6a)
      showMessages(finalMessages);
      if ((approach.thinking || approach.sources.length > 0) && !result.isFallback && !erased) {
        setApproachById(prev => ({ ...prev, [assistantMsg.id]: approach }));
      }

      // Apply any form edits the model proposed. Only the local sender reaches
      // here (handleSend runs on the instance that sent), so the pre-fill /
      // med-update fires once, not once per open tab.
      if (result.proposedEdits?.length || result.editRefusals?.length) {
        // Erased: refused, and said in the thread the erase cleared, unless it had been left or
        // another device's erase is said there already: one notice at a time (US-16 AC2e, US-15 AC62).
        onProposeEditRef.current?.take(result.proposedEdits ?? [], asked, erased ? clearedFrom.current === currentConvId && !noticeRef.current : stayed, result.editRefusals);
      }
      if (result.subscriptionCard && !erased) {
        const card = result.subscriptionCard;
        setCardsById(prev => ({ ...prev, [assistantMsg.id]: { card, phase: 'idle' } }));
      }

      let finalConversations = convsNow;
      let finalConvId = shownId;
      if (!erased && (!currentConvId || restarted)) {
        // The same chat, now a saved thread: it takes that thread's identity.
        if (stayed) { finalConvId = result.conversationId; openChat(finalConvId); }
        finalConversations = [{
          id: result.conversationId,
          title: cutText(trimmed, 80), // never half an emoji (US-15 AC26b)
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, ...convsNow.filter(c => c.id !== currentConvId)];
        setConversations(finalConversations);
      }

      setIsLocalSender(false);
      postState(instanceId, eraseRef.current, {
        conversations: finalConversations,
        activeConversationId: finalConvId,
        messages: finalMessages,
        isLoading: false,
        sending: false,
        error: null,
      });
    }
  }, [inputText, busyNow, isOffline, instanceId, guestInputs, handleDelta, endStream, startOwnSend, endOwnSend, openChat]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await deleteConversation(id);
    if (ok) {
      dropThread(id);
      postSync({ instanceId, type: 'thread-deleted', payload: { id }, ts: Date.now() });
    }
  }, [instanceId, dropThread]);

  const handleInputChange = useCallback((text: string) => {
    const sliced = cutText(text, MAX_CHARS);
    // Say so when a paste is cut (US-15 AC26); the next edit within the cap clears it.
    setError(prev => text.length > MAX_CHARS ? CUT_NOTICE : prev === CUT_NOTICE ? null : prev);
    setInputText(sliced);
    postInputSync(instanceId, sliced);
  }, [instanceId]);

  // Another thread open while the reply streams (US-15 AC7a): it shows the dots, not the reply.
  const onSendingThread = shownChat.key === sendingChat;
  return {
    state: {
      conversations,
      activeConversationId,
      messages,
      inputText,
      isLoading,
      isLocalSender: isLocalSender && onSendingThread,
      error,
      pending: onSendingThread ? pending : NO_PENDING,
      approachById,
      cardsById,
      isOffline,
      erasing,
      notice,
    },
    actions: {
      dismissNotice: () => setNotice(null),
      confirmSubscription,
      dismissSubscription,
      handleInputChange,
      selectConversation,
      startNewChat,
      handleSend,
      handleDelete,
      loadConversationsIfNeeded,
    },
    refs: { inputRef, messagesContainerRef },
  };
}
