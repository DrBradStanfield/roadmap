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
  type ChatConversation,
  type ChatMessage,
  type ChatPack,
} from '../lib/chat-api';
import { renderMarkdown } from '../lib/markdown';

interface ChatSectionProps {
  isLoggedIn: boolean;
  loginUrl?: string;
}

const MAX_CHARS = 500;

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

export function ChatSection({ isLoggedIn, loginUrl }: ChatSectionProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [dailyRemaining, setDailyRemaining] = useState<number | null>(null);
  const [messageCredits, setMessageCredits] = useState<number>(0);
  const [creditPacks, setCreditPacks] = useState<ChatPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Lazy-load conversations (only when user first expands the chat)
  const loadConversationsIfNeeded = useCallback(async () => {
    if (hasLoadedConversations || !isLoggedIn) return;
    setHasLoadedConversations(true);
    const result = await listConversations();
    if (result) {
      setConversations(result.conversations);
      setDailyRemaining(result.dailyRemaining);
      setMessageCredits(result.messageCredits);
      if (result.packs?.length) setCreditPacks(result.packs);
    }
  }, [hasLoadedConversations, isLoggedIn]);

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

    const { result, error: sendError } = await sendMessage(trimmed, activeConversationId);

    if (sendError) {
      setMessages(prev => prev.filter(m => m.id !== optimisticMsg.id));
      if (sendError.error === 'limit_reached') {
        setDailyRemaining(0);
        setMessageCredits(0);
        if (sendError.packs?.length) {
          setCreditPacks(sendError.packs);
        } else {
          setError("You've reached your daily message limit. Check back tomorrow.");
        }
      } else {
        setError(sendError.error);
      }
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
      setDailyRemaining(result.dailyRemaining);
      setMessageCredits(result.messageCredits);
      if (result.packs?.length) setCreditPacks(result.packs);

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
  }, [inputText, isLoading, activeConversationId]);

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

  // First-use disclosure
  const [showDisclosure, setShowDisclosure] = useState(false);
  const handleExpand = useCallback(() => {
    if (!isLoggedIn) return;
    const disclosed = localStorage.getItem('health_roadmap_chat_disclosed');
    if (!disclosed) {
      setShowDisclosure(true);
    }
    setIsExpanded(true);
    loadConversationsIfNeeded();
  }, [isLoggedIn, loadConversationsIfNeeded]);

  const dismissDisclosure = useCallback(() => {
    localStorage.setItem('health_roadmap_chat_disclosed', '1');
    setShowDisclosure(false);
  }, []);

  const limitReached = dailyRemaining !== null && dailyRemaining <= 0 && messageCredits <= 0;
  const [awaitingPurchase, setAwaitingPurchase] = useState(false);
  const lastCreditCheck = useRef(0);

  // Refresh credits when user returns to tab after purchasing
  useEffect(() => {
    if (!awaitingPurchase) return;
    const handleFocus = async () => {
      if (Date.now() - lastCreditCheck.current < 5000) return;
      lastCreditCheck.current = Date.now();
      const result = await listConversations();
      if (result) {
        setMessageCredits(result.messageCredits);
        setDailyRemaining(result.dailyRemaining);
        if (result.messageCredits > 0) {
          setCreditPacks([]);
        }
      }
      // Always reset — either purchase succeeded (credits > 0) or user abandoned
      setAwaitingPurchase(false);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [awaitingPurchase]);

  const openPackCheckout = useCallback((url: string) => {
    setAwaitingPurchase(true);
    window.open(url, '_blank', 'width=500,height=700,scrollbars=yes');
  }, []);

  // ----- GUEST STATE -----
  if (!isLoggedIn) {
    return (
      <div className="chat-section chat-guest no-print">
        <div className="chat-collapsed chat-disabled">
          <span className="chat-icon">💬</span>
          <span className="chat-placeholder">Ask about your health suggestions...</span>
          <div className="chat-guest-tooltip">
            <a href={loginUrl || '/account/login'}>Sign in</a> to chat about your results
          </div>
        </div>
      </div>
    );
  }

  // ----- COLLAPSED STATE -----
  if (!isExpanded) {
    return (
      <div className="chat-section no-print">
        <div className="chat-collapsed" onClick={handleExpand} role="button" tabIndex={0}>
          <span className="chat-icon">💬</span>
          <span className="chat-placeholder">Ask about your health suggestions...</span>
        </div>
      </div>
    );
  }

  // ----- EXPANDED STATE -----
  return (
    <div className="chat-section chat-expanded no-print">
      {showDisclosure && (
        <div className="chat-disclosure">
          <p>Your health data is used to provide personalized responses. Conversations are stored in your account. This is not medical advice.</p>
          <button className="btn-primary" onClick={dismissDisclosure}>Got it</button>
        </div>
      )}

      <div className="chat-header">
        <button className="chat-threads-btn" onClick={() => setShowThreads(!showThreads)}>
          {showThreads ? 'Back' : 'History'}
        </button>
        <span className="chat-title">Health Roadmap Chat</span>
        <button className="chat-close-btn" onClick={() => setIsExpanded(false)}>✕</button>
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
          <div className="chat-messages">
            {messages.length === 0 && !isLoading && (
              <div className="chat-empty">
                <p>Ask a question about your health suggestions, blood tests, or screenings to discuss with your doctor.</p>
              </div>
            )}
            {messages.map(msg => (
              <ChatMessageBubble key={msg.id} msg={msg} />
            ))}
            {isLoading && (
              <div className="chat-message chat-message--assistant">
                <div className="chat-loading">
                  <span className="chat-dot"></span>
                  <span className="chat-dot"></span>
                  <span className="chat-dot"></span>
                </div>
              </div>
            )}
            {limitReached && creditPacks.length > 0 && (
              <div className="chat-upgrade">
                {awaitingPurchase ? (
                  <p>Complete your purchase in the checkout window. Credits will appear automatically.</p>
                ) : (
                  <>
                    <p>You've used all your free messages for today.</p>
                    <p className="chat-upgrade-subtitle">Get more messages instantly:</p>
                    <div className="chat-pack-options">
                      {creditPacks.map(pack => (
                        <button
                          key={pack.name}
                          className="chat-pack-btn"
                          onClick={() => openPackCheckout(pack.url)}
                        >
                          <span className="chat-pack-amount">{pack.amount} messages</span>
                          <span className="chat-pack-price">{pack.price}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {error && <div className="chat-error">{error}</div>}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {!showThreads && (
        <div className="chat-input-bar">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputText}
            onChange={e => setInputText(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={handleKeyDown}
            placeholder={limitReached ? 'Daily limit reached' : 'Ask about your health suggestions...'}
            disabled={isLoading || limitReached}
            rows={1}
          />
          <button
            className="chat-send-btn btn-primary"
            onClick={handleSend}
            disabled={isLoading || !inputText.trim() || limitReached}
          >
            Send
          </button>
          <div className="chat-input-meta">
            <span className="chat-char-count">{inputText.length}/{MAX_CHARS}</span>
            {dailyRemaining !== null && dailyRemaining > 0 && (
              <span className="chat-counter">{dailyRemaining} free today</span>
            )}
            {dailyRemaining !== null && dailyRemaining <= 0 && messageCredits > 0 && (
              <span className="chat-counter">Using credits ({messageCredits} left)</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
