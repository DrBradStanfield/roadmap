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
  type ChatDelta,
  type ChatMessage,
  type ChatPending,
} from '../lib/chat-api';
import { postSync, postInputSync, subscribeSync, generateInstanceId, type SyncState } from '../lib/chat-sync';
import { useChatBusy } from './useChatBusy';
import { cutText } from '@roadmap/health-core/chat-history';
import type { ChatContextPayload } from '@roadmap/health-core/chat-context';
import type { ProposedEdit } from '@roadmap/health-core/chat-edits';
import { confirmSubscriptionChange, type SubscriptionCard, type SubscriptionResult } from '../lib/subscription-card';

/** A subscription change card under an answer (US-59): idle, sending, or closed with its outcome. */
export interface SubscriptionCardState {
  card: SubscriptionCard;
  phase: 'idle' | 'sending' | 'closed';
  /** The last outcome; a 'busy' one leaves the card open to try again. */
  result?: SubscriptionResult;
  dismissed?: boolean;
}

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
  /** Called when the model proposes form edits via tool_use (pre-fill / med update). */
  onProposeEdit?: (edits: ProposedEdit[]) => void;
}

/** This instance's chat state, to every other instance (US-15 AC17c names its fields). */
const postState = (instanceId: string, payload: SyncState) => postSync({ instanceId, type: 'state', payload, ts: Date.now() });

export const MAX_CHARS = 8000;
const CUT_NOTICE = `Your message was cut at ${MAX_CHARS.toLocaleString('en')} characters.`;
const NO_PENDING: ChatPending = { thinking: '', text: '', status: '', sources: [] };

/** Enter sends, Shift+Enter is a new line, and an Enter that commits an input method's composition only commits it
 *  (US-15 AC26a): Chrome and Firefox mark it `isComposing`, Safari sends it just after with keyCode 229. */
export function sendsOnEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

export function useChatState({ isLoggedIn, guestInputs, prefetchedData, onRemoteConversationSelected, onProposeEdit }: UseChatStateOptions) {
  const [instanceId] = useState(generateInstanceId);

  const [conversations, setConversations] = useState<ChatConversation[]>(prefetchedData?.conversations ?? []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(prefetchedData?.activeConversationId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(prefetchedData?.messages ?? []);
  const [inputText, setInputText] = useState('');
  // isLocalSender: true only on the instance that triggered the send — controls animation
  const [isLocalSender, setIsLocalSender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(!!prefetchedData);
  // The reply as it streams in (US-15 AC16/AC17/AC20), on the sending
  // instance only; other tabs show the dots.
  const [pending, setPending] = useState(NO_PENDING);
  // The thread the reply in flight was sent from: the stream shows only there (US-15 AC7a).
  const [sendingConversationId, setSendingConversationId] = useState<string | null>(null);
  // A landed answer's thinking summary and articles read, by message id, for
  // this session only (AC17/AC22). Never persisted: not in `messages` (so not synced
  // to other tabs or written to the user's cloud chat history) and never sent to the server.
  const [approachById, setApproachById] = useState<Record<string, ChatApproach>>({});
  // US-59: subscription change cards, by assistant message id, this tab only
  // (like approachById: never persisted, synced or sent anywhere but the confirm).
  const [cardsById, setCardsById] = useState<Record<string, SubscriptionCardState>>({});
  const streamRef = useRef({ ...NO_PENDING, frame: 0 });
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Keep the latest onProposeEdit in a ref so handleSend's closure always fires
  // the current callback without re-creating the (memoised) handler.
  const onProposeEditRef = useRef(onProposeEdit);
  useEffect(() => { onProposeEditRef.current = onProposeEdit; }, [onProposeEdit]);

  // Refs for current values needed inside async callbacks and subscriptions
  const conversationsRef = useRef(conversations);
  const activeConversationIdRef = useRef(activeConversationId);
  const messagesRef = useRef(messages);
  const inputTextRef = useRef(inputText);
  const isLoadingConvsRef = useRef(false);
  // Busy while any tab's send is in flight, each tracked on its own (US-15 AC17c).
  const { isLoading, busyNow, ownSending, startOwnSend, endOwnSend, onRemote } = useChatBusy();
  // Bumped by each thread load and by a reply landing on screen: a load that
  // started before either is stale (US-15 AC7a).
  const loadGenRef = useRef(0);
  useEffect(() => {
    conversationsRef.current = conversations;
    activeConversationIdRef.current = activeConversationId;
    messagesRef.current = messages;
    inputTextRef.current = inputText;
  }, [conversations, activeConversationId, messages, inputText]);

  // Offline detection
  useEffect(() => {
    const off = () => setIsOffline(true);
    const on = () => setIsOffline(false);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  // Deltas collect in a ref and render at most once per animation frame.
  // A status line starts a new phase: text streamed before it was not the
  // answer (a run_roadmap round's preamble, US-15 AC38), so it is cleared.
  const handleDelta = useCallback((delta: ChatDelta) => {
    const stream = streamRef.current;
    if (delta.type === 'sources') stream.sources = delta.titles;
    else if (delta.type === 'status') { stream.status = delta.text; stream.text = ''; }
    else stream[delta.type] += delta.text;
    if (stream.frame) return;
    stream.frame = requestAnimationFrame(() => {
      stream.frame = 0;
      setPending({ thinking: stream.thinking, text: stream.text, status: stream.status, sources: stream.sources });
    });
  }, []);

  /** Ends the stream; returns the thinking summary and the articles read it collected. */
  const endStream = useCallback((): ChatApproach => {
    const stream = streamRef.current;
    cancelAnimationFrame(stream.frame);
    const { thinking, sources } = stream;
    streamRef.current = { ...NO_PENDING, frame: 0 };
    setPending(NO_PENDING);
    return { thinking, sources };
  }, []);

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
        if (payload.activeConversationId !== activeConversationIdRef.current) {
          onRemoteConversationSelected?.();
        }
        setConversations(payload.conversations);
        setActiveConversationId(payload.activeConversationId);
        setMessages(payload.messages);
        // That tab's own send, tracked apart from this tab's (US-15 AC17c).
        onRemote(msg.instanceId, payload.sending, payload.isLoading);
        if (!ownSending()) setIsLocalSender(false);
        setError(payload.error);
        return;
      }

      if (msg.type === 'thread-new') {
        setActiveConversationId(null);
        setMessages([]);
        setError(null);
        return;
      }

      if (msg.type === 'thread-deleted') {
        const { id } = msg.payload;
        setConversations(prev => prev.filter(c => c.id !== id));
        if (activeConversationIdRef.current === id) {
          setActiveConversationId(null);
          setMessages([]);
        }
        return;
      }
    });
    return unsubscribe;
  }, [instanceId, onRemoteConversationSelected, onRemote]);

  const dropThread = useCallback((id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConversationIdRef.current === id) {
      setActiveConversationId(null);
      setMessages([]);
    }
  }, []);

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
        activeConversationIdRef.current = latest.id; // dropThread reads it after the await
        setActiveConversationId(latest.id);
        const gen = ++loadGenRef.current;
        const msgs = await loadConversation(latest.id);
        if (!msgs) { dropThread(latest.id); return; }
        // The guest opened another thread, or a reply landed, meanwhile (US-15 AC7a).
        if (activeConversationIdRef.current !== latest.id || gen !== loadGenRef.current) return;
        setMessages(msgs);
      }
    }
  }, [isLoggedIn, dropThread]);

  const selectConversation = useCallback(async (id: string) => {
    // Set now, not after render: dropThread below reads it after the await.
    activeConversationIdRef.current = id;
    setActiveConversationId(id);
    setError(null);
    const gen = ++loadGenRef.current;
    const msgs = await loadConversation(id);
    // The server no longer recognizes this guest thread (US-15 AC6a), even if another is open now.
    if (!msgs) { dropThread(id); return; }
    // Another thread was opened, or a reply landed, meanwhile (US-15 AC7a).
    if (activeConversationIdRef.current !== id || gen !== loadGenRef.current) return;
    setMessages(msgs);
    postState(instanceId, {
      conversations: conversationsRef.current,
      activeConversationId: id,
      messages: msgs,
      isLoading: busyNow(), // for older bundles: a reply still in flight is not over (US-15 AC7a)
      sending: ownSending(),
      error: null,
    });
  }, [instanceId, dropThread]);

  const startNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
    postSync({ instanceId, type: 'thread-new', payload: {}, ts: Date.now() });
  }, [instanceId]);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || busyNow()) return; // read now: a second press before the re-render sends nothing
    if (trimmed.length > MAX_CHARS) return;
    if (isOffline) { setError("You're offline. Check your connection and try again."); return; }

    setError(null);
    const currentConvId = activeConversationIdRef.current;
    const currentConvs = conversationsRef.current;

    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    const optimisticMessages = [...messagesRef.current, optimisticMsg];

    setMessages(optimisticMessages);
    setInputText('');
    inputTextRef.current = ''; // the box is empty now, before the re-render (US-15 AC57)
    postInputSync(instanceId, '');
    startOwnSend();
    setIsLocalSender(true);
    setSendingConversationId(currentConvId);

    postState(instanceId, {
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
    const { result, error: sendError } = await (async () => sendMessage(
      trimmed,
      currentConvId,
      guestInputs?.() ?? null,
      messagesRef.current,
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
    const shownId = activeConversationIdRef.current;
    const stayed = shownId === currentConvId;
    // The list as it is now: a thread dropped during the send stays dropped (US-15 AC7a).
    const convsNow = conversationsRef.current;

    if (sendError) {
      const withoutOptimistic = stayed ? optimisticMessages.filter(m => m.id !== optimisticMsg.id) : messagesRef.current;
      setMessages(withoutOptimistic);
      // The question leaves the thread, so it goes back in the box, unless
      // something new was typed meanwhile, as Stop does on the iPhone (US-15 AC57).
      if (stayed && !inputTextRef.current) {
        setInputText(trimmed);
        postInputSync(instanceId, trimmed);
      }
      setError(sendError.error);
      setIsLocalSender(false);
      postState(instanceId, {
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
      setMessages(finalMessages);
      if ((approach.thinking || approach.sources.length > 0) && !result.isFallback) {
        setApproachById(prev => ({ ...prev, [assistantMsg.id]: approach }));
      }

      // Apply any form edits the model proposed. Only the local sender reaches
      // here (handleSend runs on the instance that sent), so the pre-fill /
      // med-update fires once, not once per open tab.
      if (result.proposedEdits && result.proposedEdits.length > 0) {
        onProposeEditRef.current?.(result.proposedEdits);
      }
      if (result.subscriptionCard) {
        const card = result.subscriptionCard;
        setCardsById(prev => ({ ...prev, [assistantMsg.id]: { card, phase: 'idle' } }));
      }

      let finalConversations = convsNow;
      let finalConvId = shownId;
      if (!currentConvId || restarted) {
        if (stayed) { finalConvId = result.conversationId; setActiveConversationId(finalConvId); }
        finalConversations = [{
          id: result.conversationId,
          title: cutText(trimmed, 80), // never half an emoji (US-15 AC26b)
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, ...convsNow.filter(c => c.id !== currentConvId)];
        setConversations(finalConversations);
      }

      setIsLocalSender(false);
      postState(instanceId, {
        conversations: finalConversations,
        activeConversationId: finalConvId,
        messages: finalMessages,
        isLoading: false,
        sending: false,
        error: null,
      });
    }
  }, [inputText, busyNow, isOffline, instanceId, guestInputs, handleDelta, endStream, startOwnSend, endOwnSend]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await deleteConversation(id);
    if (ok) {
      dropThread(id);
      postSync({ instanceId, type: 'thread-deleted', payload: { id }, ts: Date.now() });
    }
  }, [instanceId, dropThread]);

  /** The customer pressed Confirm (US-59): the one request that makes the change. */
  const cardsRef = useRef(cardsById);
  const setCards = useCallback((next: Record<string, SubscriptionCardState>) => { cardsRef.current = next; setCardsById(next); }, []);
  useEffect(() => { cardsRef.current = cardsById; }, [cardsById]);
  const confirmSubscription = useCallback(async (messageId: string) => {
    const entry = cardsRef.current[messageId];
    // The ref flips to 'sending' synchronously, so a double click sends once.
    if (!entry || entry.phase !== 'idle') return;
    setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'sending' } });
    const result = await confirmSubscriptionChange(entry.card);
    // The usage signal is counted by the server's confirm route (US-59), on every bundle.
    // 'busy' leaves the card open to try again; every other outcome closes it.
    setCards({ ...cardsRef.current, [messageId]: { ...entry, result, phase: result.code === 'busy' ? 'idle' : 'closed' } });
  }, [setCards]);

  const dismissSubscription = useCallback((messageId: string) => {
    const entry = cardsRef.current[messageId];
    if (entry?.phase === 'idle') setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'closed', dismissed: true } });
  }, [setCards]);

  const handleInputChange = useCallback((text: string) => {
    const sliced = cutText(text, MAX_CHARS);
    // Say so when a paste is cut (US-15 AC26); the next edit within the cap clears it.
    setError(prev => text.length > MAX_CHARS ? CUT_NOTICE : prev === CUT_NOTICE ? null : prev);
    setInputText(sliced);
    postInputSync(instanceId, sliced);
  }, [instanceId]);

  // Another thread open while the reply streams (US-15 AC7a): it shows the dots, not the reply.
  const onSendingThread = activeConversationId === sendingConversationId;
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
    },
    actions: {
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
