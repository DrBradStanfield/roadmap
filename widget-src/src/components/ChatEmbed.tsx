/**
 * ChatEmbed — always-expanded inline chat panel.
 *
 * Desktop (≥720px): left sidebar (thread list) + right pane (messages + input).
 * Mobile (<720px): messages pane with a slide-in drawer for threads.
 *
 * Conversations load lazily via IntersectionObserver — fires only when the
 * panel scrolls into view, giving the health widget priority on page load.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useChatState, THINKING_MESSAGES, MAX_CHARS } from '../hooks/useChatState';
import { ChatMessageBubble } from './ChatMessageBubble';
import { ChatThreadList } from './ChatThreadList';
import { useIsMobile } from '../lib/useIsMobile';

interface ChatEmbedProps {
  isLoggedIn: boolean;
  guestInputs?: Record<string, unknown> | null;
}

export function ChatEmbed({ isLoggedIn, guestInputs }: ChatEmbedProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const { state, actions, refs } = useChatState({
    isLoggedIn, guestInputs,
    onRemoteConversationSelected: closeDrawer,
  });
  const { inputRef, messagesContainerRef } = refs;

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile(720);

  // Lazy-load conversations: fire only when this panel enters the viewport.
  // Since the embed is placed below the health widget, the widget's API calls
  // win network priority naturally.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          actions.loadConversationsIfNeeded();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [actions.loadConversationsIfNeeded]);

  // Auto-scroll messages to bottom on new message
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      actions.handleSend();
    }
  }, [actions.handleSend]);

  const handleSelectConversation = useCallback((id: string) => {
    actions.selectConversation(id);
    setDrawerOpen(false);
  }, [actions.selectConversation]);

  const handleStartNewChat = useCallback(() => {
    actions.startNewChat();
    setDrawerOpen(false);
  }, [actions.startNewChat]);

  const threadList = (
    <ChatThreadList
      conversations={state.conversations}
      activeConversationId={state.activeConversationId}
      className="chat-embed-thread-list"
      onSelect={handleSelectConversation}
      onNew={handleStartNewChat}
      onDelete={actions.handleDelete}
    />
  );

  return (
    <div className="chat-embed no-print" ref={rootRef} role="region" aria-label="Health Roadmap Chat">

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div className="chat-embed-drawer-overlay" onClick={() => setDrawerOpen(false)} />
      )}

      {/* Mobile drawer — thread list mounted here on mobile only */}
      <div className={`chat-embed-drawer ${drawerOpen ? 'chat-embed-drawer--open' : ''}`}>
        <div className="chat-embed-drawer-header">
          <span className="chat-embed-drawer-title">Conversations</span>
          <button className="chat-close-btn" onClick={() => setDrawerOpen(false)}>✕</button>
        </div>
        {isMobile && threadList}
      </div>

      {/* Desktop sidebar — thread list mounted here on desktop only */}
      <div className="chat-embed-sidebar">
        <div className="chat-embed-sidebar-header">
          <span className="chat-embed-sidebar-title">Conversations</span>
        </div>
        {!isMobile && threadList}
      </div>

      {/* Main pane */}
      <div className="chat-embed-main">
        <div className="chat-embed-main-header">
          {/* Threads button — visible on mobile only */}
          <button
            className="chat-embed-threads-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="Show conversations"
          >
            ☰ Threads
          </button>
          <span className="chat-embed-title">Discuss Your Health</span>
        </div>

        <div
          className="chat-messages chat-embed-messages"
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
        >
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

        <div className="chat-input-bar chat-embed-input-bar">
          {state.isOffline && <div className="chat-offline">You're offline</div>}
          <textarea
            ref={inputRef}
            className="chat-input"
            value={state.inputText}
            onChange={e => actions.handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your health"
            disabled={state.isLoading}
            rows={1}
          />
          <button
            className="chat-send-btn btn-primary"
            onClick={actions.handleSend}
            disabled={state.isLoading || !state.inputText.trim()}
          >
            Send
          </button>
          <div className="chat-input-meta">
            <span className="chat-doctor-note">Always discuss with your doctor</span>
            <span className="chat-char-count">{state.inputText.length}/{MAX_CHARS}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
