/**
 * ChatSection — floating chat widget.
 *
 * Collapsed: fixed bubble at bottom-right of viewport.
 * Expanded: fixed panel at bottom-right with thread list + messages.
 * Guest: greyed out bubble with login tooltip.
 *
 * All API calls are lazy — nothing fires until the user clicks the bubble.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { FeedbackForm } from './FeedbackForm';
import { useChatState, THINKING_MESSAGES, MAX_CHARS } from '../hooks/useChatState';
import { ChatMessageBubble } from './ChatMessageBubble';
import { ChatThreadList } from './ChatThreadList';

export type { ChatPrefetchData } from '../hooks/useChatState';
import type { ChatPrefetchData } from '../hooks/useChatState';

interface ChatSectionProps {
  isLoggedIn: boolean;
  startExpanded?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
  guestInputs?: Record<string, unknown> | null;
  prefetchedData?: ChatPrefetchData | null;
}

export function ChatSection({ isLoggedIn, startExpanded, onClose, onExpand, guestInputs, prefetchedData }: ChatSectionProps) {
  const [isExpanded, setIsExpanded] = useState(startExpanded ?? false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const closeThreadsPanel = useCallback(() => setShowThreads(false), []);
  const { state, actions, refs } = useChatState({
    isLoggedIn, guestInputs, prefetchedData,
    onRemoteConversationSelected: closeThreadsPanel,
  });
  const { inputRef, messagesContainerRef } = refs;

  // Load on mount when startExpanded (mirrors original lazy-load behavior)
  useEffect(() => {
    if (startExpanded) {
      actions.loadConversationsIfNeeded();
    }
  }, [startExpanded, actions.loadConversationsIfNeeded]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [state.messages, messagesContainerRef]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const shouldShow = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
    setShowScrollBtn(prev => prev === shouldShow ? prev : shouldShow);
  }, [messagesContainerRef]);

  const handleExpand = useCallback(() => {
    if (onExpand) { onExpand(); return; }
    setIsExpanded(true);
    setShowFeedback(false);
    actions.loadConversationsIfNeeded();
  }, [onExpand, actions.loadConversationsIfNeeded]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      actions.handleSend();
    }
  }, [actions.handleSend]);

  const handleSelectConversation = useCallback((id: string) => {
    actions.selectConversation(id);
    setShowThreads(false);
  }, [actions.selectConversation]);

  // ----- COLLAPSED STATE -----
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
          <ChatThreadList
            conversations={state.conversations}
            activeConversationId={state.activeConversationId}
            className="chat-thread-list"
            onSelect={handleSelectConversation}
            onNew={actions.startNewChat}
            onDelete={actions.handleDelete}
          />
        )}

        {!showThreads && (
          <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
            {state.messages.length === 0 && !state.isLoading && (
              <div className="chat-empty">
                <p>Ask about your personalized suggestions based on your health data, clinical research, and Dr Brad's preventative care algorithm.</p>
              </div>
            )}
            {state.messages.map(msg => (
              <ChatMessageBubble key={msg.id} msg={msg} />
            ))}
            {state.isLoading && (
              <div className="chat-message chat-message--assistant">
                <div className="chat-loading">
                  {state.isLocalSender ? (
                    <span className="chat-thinking-text">{THINKING_MESSAGES[state.thinkingIndex]}</span>
                  ) : (
                    <span className="chat-thinking-dots" />
                  )}
                </div>
              </div>
            )}
            {state.error && <div className="chat-error">{state.error}</div>}
            {showScrollBtn && (
              <button
                className="chat-scroll-btn"
                onClick={() => { const el = messagesContainerRef.current; if (el) el.scrollTop = el.scrollHeight; }}
              >↓</button>
            )}
          </div>
        )}
      </div>

      {!showThreads && (
        <div className="chat-input-bar">
          {state.isOffline && <div className="chat-offline">You're offline</div>}
          <textarea
            ref={inputRef}
            className="chat-input"
            value={state.inputText}
            onChange={e => actions.handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your health suggestions"
            disabled={state.isLoading}
            rows={1}
          />
          <button
            className="chat-send-btn btn-primary"
            onClick={actions.handleSend}
            disabled={state.isLoading || !state.inputText.trim()}
            aria-label="Send"
          >↑</button>
          <div className="chat-input-meta">
            <span className="chat-doctor-note">Always discuss with your doctor</span>
            <span className="chat-char-count">{state.inputText.length}/{MAX_CHARS}</span>
          </div>
        </div>
      )}
    </div>
  );
}
