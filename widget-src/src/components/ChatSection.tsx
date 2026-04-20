/**
 * ChatSection — floating chat widget.
 *
 * Collapsed: fixed bubble at bottom-right of viewport.
 * Expanded: fixed panel at bottom-right with thread list + messages.
 * Guest: greyed out bubble with login tooltip.
 *
 * All API calls are lazy — nothing fires until the user clicks the bubble.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  listConversations,
  loadConversation,
  sendMessage,
  deleteConversation,
  triggerWarmup,
  type ChatConversation,
  type ChatMessage,
} from '../lib/chat-api';
import { renderMarkdown } from '../lib/markdown';
import { FeedbackForm } from './FeedbackForm';

export interface ChatPrefetchData {
  conversations: ChatConversation[];
  messages: ChatMessage[];
  activeConversationId: string | null;
}

interface ChatSectionProps {
  isLoggedIn: boolean;
  /** When true, renders expanded immediately (skips collapsed bubble) */
  startExpanded?: boolean;
  /** External close handler — used by floating FAB to control open/close */
  onClose?: () => void;
  /** When provided, clicking the collapsed bubble calls this instead of expanding internally */
  onExpand?: () => void;
  /** Guest health inputs from the widget — passed to server for personalized context */
  guestInputs?: Record<string, unknown> | null;
  /** Pre-fetched data from HealthTool — avoids delay when chat opens */
  prefetchedData?: ChatPrefetchData | null;
}

const MAX_CHARS = 500;

const THINKING_MESSAGES = [
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

/** Memoized message bubble — avoids re-parsing markdown on every render */
const ChatMessageBubble = React.memo(function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const html = useMemo(
    () => msg.role === 'assistant' ? renderMarkdown(msg.content) : null,
    [msg.content, msg.role],
  );

  return (
    <div className={`chat-message chat-message--${msg.role}`}>
      {html ? (
        <div className="chat-message-content" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="chat-message-content">{msg.content}</div>
      )}
    </div>
  );
});

export function ChatSection({ isLoggedIn, startExpanded, onClose, onExpand, guestInputs, prefetchedData }: ChatSectionProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>(prefetchedData?.conversations ?? []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(prefetchedData?.activeConversationId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(prefetchedData?.messages ?? []);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(startExpanded ?? false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(!!prefetchedData);
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Cycle thinking messages while loading, with random 1-3s intervals
  useEffect(() => {
    if (!isLoading) { setThinkingIndex(0); return; }
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
  }, [isLoading]);

  // Track scroll position — only auto-scroll if user is near bottom
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const shouldShow = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
    setShowScrollBtn(prev => prev === shouldShow ? prev : shouldShow);
  }, []);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Network offline detection
  useEffect(() => {
    const off = () => setIsOffline(true);
    const on = () => setIsOffline(false);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  // Prime the Anthropic prompt cache when the chat panel becomes visible.
  // Server-side cooldown dedupes rapid toggles. Called as a statement (not
  // returned) so React doesn't treat the Promise as a cleanup function.
  useEffect(() => {
    if (isExpanded) triggerWarmup();
  }, [isExpanded]);

  // Lazy-load conversations (only when user first expands the chat)
  const loadConversationsIfNeeded = useCallback(async () => {
    if (hasLoadedConversations) return;
    setHasLoadedConversations(true);
    const result = await listConversations();
    if (result) {
      setConversations(result.conversations);

      // Auto-load the most recent conversation if guest has one (resume after refresh)
      if (!isLoggedIn && result.conversations.length > 0) {
        const latest = result.conversations[0];
        setActiveConversationId(latest.id);
        const msgs = await loadConversation(latest.id);
        setMessages(msgs);
      }
    }
  }, [hasLoadedConversations, isLoggedIn]);

  // Load conversations on mount when startExpanded
  useEffect(() => {
    if (startExpanded) {
      loadConversationsIfNeeded();
    }
  }, [startExpanded, loadConversationsIfNeeded]);

  // Load conversation messages when selecting a thread
  const selectConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    setShowThreads(false);
    setError(null);
    const msgs = await loadConversation(id);
    setMessages(msgs);
  }, []);

  // Start a new conversation
  const startNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setError(null);
    setShowThreads(false);
    inputRef.current?.focus();
  }, []);

  // Send message
  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isLoading) return;
    if (trimmed.length > MAX_CHARS) return;
    if (isOffline) {
      setError("You're offline. Check your connection and try again.");
      return;
    }

    setError(null);

    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimisticMsg]);
    setInputText('');
    setIsLoading(true);

    const { result, error: sendError } = await sendMessage(
      trimmed, activeConversationId, !isLoggedIn ? guestInputs : null,
    );

    if (sendError) {
      setMessages(prev => prev.filter(m => m.id !== optimisticMsg.id));
      setError(sendError.error);
      setIsLoading(false);
      return;
    }

    if (result) {
      const assistantMsg: ChatMessage = {
        id: result.messageId ?? `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.content,
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMsg]);

      if (!activeConversationId) {
        setActiveConversationId(result.conversationId);
        setConversations(prev => [{
          id: result.conversationId,
          title: trimmed.slice(0, 80),
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, ...prev]);
      }
    }

    setIsLoading(false);
  }, [inputText, isLoading, activeConversationId, isOffline]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await deleteConversation(id);
    if (ok) {
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConversationId === id) {
        setActiveConversationId(null);
        setMessages([]);
      }
    }
  }, [activeConversationId]);

  const handleExpand = useCallback(() => {
    // Delegate to parent (e.g. open floating FAB chat) if provided
    if (onExpand) { onExpand(); return; }
    setIsExpanded(true);
    setShowFeedback(false);
    loadConversationsIfNeeded();
  }, [onExpand, loadConversationsIfNeeded]);

  // ----- COLLAPSED STATE (guests and logged-in) -----
  if (!isExpanded) {
    return (
      <div className="chat-section no-print">
        <div className="chat-collapsed-row">
          <div className="chat-collapsed" onClick={handleExpand} role="button" tabIndex={0}>
            <span className="chat-icon">💬</span>
            <span className="chat-placeholder">Ask about your health suggestions</span>
          </div>
          {!isLoggedIn && (
            <button
              type="button"
              className="chat-feedback-link"
              onClick={() => setShowFeedback(f => !f)}
            >
              Send feedback
            </button>
          )}
        </div>
        {showFeedback && (
          <FeedbackForm initialExpanded showSourceLink={false} onClose={() => setShowFeedback(false)} />
        )}
      </div>
    );
  }

  // ----- EXPANDED STATE -----
  return (
    <div className="chat-section chat-expanded no-print" role="dialog" aria-label="Health Roadmap Chat">
      <div className="chat-header">
        <button className="chat-threads-btn" onClick={() => setShowThreads(!showThreads)}>
          {showThreads ? 'Back' : 'History'}
        </button>
        <span className="chat-title">Health Roadmap Chat</span>
        <button className="chat-close-btn" onClick={() => { setIsExpanded(false); onClose?.(); }}>✕</button>
      </div>

      <div className="chat-body">
        {showThreads && (
          <div className="chat-thread-list">
            <button className="chat-new-btn" onClick={startNewChat}>+ New Chat</button>
            {conversations.map(conv => (
              <div
                key={conv.id}
                className={`chat-thread-item ${conv.id === activeConversationId ? 'active' : ''}`}
                onClick={() => selectConversation(conv.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(conv.id); } }}
              >
                <span className="chat-thread-title">{conv.title || 'Untitled'}</span>
                <button
                  className="chat-thread-delete"
                  onClick={(e) => handleDelete(conv.id, e)}
                  title="Delete conversation"
                >✕</button>
              </div>
            ))}
            {conversations.length === 0 && (
              <div className="chat-thread-empty">No conversations yet</div>
            )}
          </div>
        )}

        {!showThreads && (
          <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
            {messages.length === 0 && !isLoading && (
              <div className="chat-empty">
                <p>Ask about your personalized suggestions based on your health data, clinical research, and Dr Brad's preventative care algorithm.</p>
              </div>
            )}
            {messages.map(msg => (
              <ChatMessageBubble key={msg.id} msg={msg} />
            ))}
            {isLoading && (
              <div className="chat-message chat-message--assistant">
                <div className="chat-loading">
                  <span className="chat-thinking-text">{THINKING_MESSAGES[thinkingIndex]}</span>
                </div>
              </div>
            )}
            {error && <div className="chat-error">{error}</div>}
            {showScrollBtn && (
              <button className="chat-scroll-btn" onClick={() => { const el = messagesContainerRef.current; if (el) el.scrollTop = el.scrollHeight; }}>↓</button>
            )}
          </div>
        )}
      </div>

      {!showThreads && (
        <div className="chat-input-bar">
          {isOffline && <div className="chat-offline">You're offline</div>}
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputText}
            onChange={e => setInputText(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your health suggestions"
            disabled={isLoading}
            rows={1}
          />
          <button
            className="chat-send-btn btn-primary"
            onClick={handleSend}
            disabled={isLoading || !inputText.trim()}
          >
            Send
          </button>
          <div className="chat-input-meta">
            <span className="chat-doctor-note">Always discuss with your doctor</span>
            <span className="chat-char-count">{inputText.length}/{MAX_CHARS}</span>
          </div>
        </div>
      )}
    </div>
  );
}
