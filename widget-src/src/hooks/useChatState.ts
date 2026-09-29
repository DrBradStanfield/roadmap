/**
 * Shared chat state hook used by ChatSection (bubble) and ChatEmbed (inline panel).
 * Handles all data fetching, API calls, optimistic updates, and BroadcastChannel sync.
 * UI-only state (isExpanded, showThreads, etc.) stays in the consuming component.
 */

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
import { postSync, postInputSync, subscribeSync, generateInstanceId } from '../lib/chat-sync';
import type { ChatContextPayload, ProposedEdit } from '@roadmap/health-core';

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

export const MAX_CHARS = 500;
const NO_PENDING: ChatPending = { thinking: '', text: '', status: '', sources: [] };

export function useChatState({ isLoggedIn, guestInputs, prefetchedData, onRemoteConversationSelected, onProposeEdit }: UseChatStateOptions) {
  const [instanceId] = useState(generateInstanceId);

  const [conversations, setConversations] = useState<ChatConversation[]>(prefetchedData?.conversations ?? []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(prefetchedData?.activeConversationId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(prefetchedData?.messages ?? []);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // isLocalSender: true only on the instance that triggered the send — controls animation
  const [isLocalSender, setIsLocalSender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(!!prefetchedData);
  // The reply as it streams in (US-15 AC16/AC17/AC20), on the sending
  // instance only; other tabs show the dots.
  const [pending, setPending] = useState(NO_PENDING);
  // A landed answer's thinking summary and articles read, by message id, for
  // this session only (AC17/AC22). Never persisted: not in `messages` (so not synced
  // to other tabs or written to the user's cloud chat history) and never sent to the server.
  const [approachById, setApproachById] = useState<Record<string, ChatApproach>>({});
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
  const isLoadingConvsRef = useRef(false);
  useEffect(() => {
    conversationsRef.current = conversations;
    activeConversationIdRef.current = activeConversationId;
    messagesRef.current = messages;
  }, [conversations, activeConversationId, messages]);

  // Offline detection
  useEffect(() => {
    const off = () => setIsOffline(true);
    const on = () => setIsOffline(false);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  // Deltas collect in a ref and render at most once per animation frame.
  const handleDelta = useCallback((delta: ChatDelta) => {
    const stream = streamRef.current;
    if (delta.type === 'sources') stream.sources = delta.titles;
    else if (delta.type === 'status') stream.status = delta.text;
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
    return subscribeSync((msg) => {
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
        setIsLoading(payload.isLoading);
        setIsLocalSender(false);
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
  }, [instanceId, onRemoteConversationSelected]);

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
        setActiveConversationId(latest.id);
        const msgs = await loadConversation(latest.id);
        setMessages(msgs);
      }
    }
  }, [isLoggedIn]);

  const selectConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    setError(null);
    const msgs = await loadConversation(id);
    setMessages(msgs);
    postSync({
      instanceId,
      type: 'state',
      payload: {
        conversations: conversationsRef.current,
        activeConversationId: id,
        messages: msgs,
        isLoading: false,
        error: null,
      },
      ts: Date.now(),
    });
  }, [instanceId]);

  const startNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
    postSync({ instanceId, type: 'thread-new', payload: {}, ts: Date.now() });
  }, [instanceId]);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isLoading) return;
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
    postInputSync(instanceId, '');
    setIsLoading(true);
    setIsLocalSender(true);

    postSync({
      instanceId,
      type: 'state',
      payload: {
        conversations: currentConvs,
        activeConversationId: currentConvId,
        messages: optimisticMessages,
        isLoading: true,
        error: null,
      },
      ts: Date.now(),
    });

    // Always send the plan as chat context: local-first (v2) means the server
    // has no health data for logged-in customers either (the v1 tables were
    // purged June 2026), so this is the only context the answer gets. Every
    // surface builds it with chatContextOf: the widget from its own state, the
    // blog bubble and the chatbot embed from the widget's saved copy. The
    // reader runs here, so each message carries what is saved now, even a save
    // made after the page loaded (US-15 AC10). None degrades to the empty context.
    const { result, error: sendError } = await sendMessage(
      trimmed,
      currentConvId,
      guestInputs?.() ?? null,
      messagesRef.current,
      handleDelta,
      Boolean(onProposeEditRef.current),
    );
    const approach = endStream();

    if (sendError) {
      const withoutOptimistic = optimisticMessages.filter(m => m.id !== optimisticMsg.id);
      setMessages(withoutOptimistic);
      setError(sendError.error);
      setIsLoading(false);
      setIsLocalSender(false);
      postSync({
        instanceId,
        type: 'state',
        payload: {
          conversations: currentConvs,
          activeConversationId: currentConvId,
          messages: withoutOptimistic,
          isLoading: false,
          error: sendError.error,
        },
        ts: Date.now(),
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
      const finalMessages = [...optimisticMessages, assistantMsg];
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

      let finalConversations = currentConvs;
      let finalConvId = currentConvId;
      if (!currentConvId) {
        finalConvId = result.conversationId;
        setActiveConversationId(finalConvId);
        finalConversations = [{
          id: result.conversationId,
          title: trimmed.slice(0, 80),
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, ...currentConvs];
        setConversations(finalConversations);
      }

      setIsLoading(false);
      setIsLocalSender(false);
      postSync({
        instanceId,
        type: 'state',
        payload: {
          conversations: finalConversations,
          activeConversationId: finalConvId,
          messages: finalMessages,
          isLoading: false,
          error: null,
        },
        ts: Date.now(),
      });
    }
  }, [inputText, isLoading, isOffline, instanceId, guestInputs, handleDelta, endStream]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await deleteConversation(id);
    if (ok) {
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConversationIdRef.current === id) {
        setActiveConversationId(null);
        setMessages([]);
      }
      postSync({ instanceId, type: 'thread-deleted', payload: { id }, ts: Date.now() });
    }
  }, [instanceId]);

  const handleInputChange = useCallback((text: string) => {
    const sliced = text.slice(0, MAX_CHARS);
    setInputText(sliced);
    postInputSync(instanceId, sliced);
  }, [instanceId]);

  return {
    state: {
      conversations,
      activeConversationId,
      messages,
      inputText,
      isLoading,
      isLocalSender,
      error,
      pending,
      approachById,
      isOffline,
    },
    actions: {
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
