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
  type ChatConversation,
  type ChatMessage,
} from '../lib/chat-api';
import { postSync, postInputSync, subscribeSync, generateInstanceId } from '../lib/chat-sync';

export interface ChatPrefetchData {
  conversations: ChatConversation[];
  messages: ChatMessage[];
  activeConversationId: string | null;
}

interface UseChatStateOptions {
  isLoggedIn: boolean;
  guestInputs?: Record<string, unknown> | null;
  prefetchedData?: ChatPrefetchData | null;
  onRemoteConversationSelected?: () => void;
}

export const MAX_CHARS = 500;

export const THINKING_MESSAGES = [
  'Reviewing your health data…',
  'Checking clinical guidelines…',
  'Looking up relevant research…',
  'Cross-referencing your results…',
  'Consulting the evidence…',
  'Pulling the latest guidelines…',
  'Framing the answer…',
  'Double-checking the numbers…',
  'Almost there…',
  'Preparing response…',
];

export function useChatState({ isLoggedIn, guestInputs, prefetchedData, onRemoteConversationSelected }: UseChatStateOptions) {
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
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

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

  // Thinking message cycle — only animate on the instance that sent the message
  useEffect(() => {
    if (!isLoading || !isLocalSender) { setThinkingIndex(0); return; }
    let timeout: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = 1000 + Math.random() * 2000;
      timeout = setTimeout(() => {
        setThinkingIndex(i => (i + 1) % THINKING_MESSAGES.length);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timeout);
  }, [isLoading, isLocalSender]);

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

    // HealthTool already decides when guestInputs is populated (true guests +
    // every local-first build). Pass it straight through; in the production
    // widget it's null for logged-in users, so the server uses DB context.
    const { result, error: sendError } = await sendMessage(
      trimmed,
      currentConvId,
      guestInputs ?? null,
    );

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
      };
      const finalMessages = [...optimisticMessages, assistantMsg];
      setMessages(finalMessages);

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
  }, [inputText, isLoading, isOffline, instanceId, isLoggedIn, guestInputs]);

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
      thinkingIndex,
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
