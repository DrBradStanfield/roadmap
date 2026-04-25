/**
 * ChatEmbed — always-expanded inline chat panel. Thread list lives in a
 * hamburger-triggered drawer at all breakpoints.
 *
 * Conversations load lazily via IntersectionObserver — fires only when the
 * panel scrolls into view, giving the health widget priority on page load.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useChatState, THINKING_MESSAGES, MAX_CHARS } from '../hooks/useChatState';
import { ChatMessageBubble } from './ChatMessageBubble';
import { ChatThreadList } from './ChatThreadList';
import { ColumnHeader } from './ColumnHeader';
import { ChatHeaderTitle } from './ChatHeaderTitle';

interface ChatEmbedProps {
  isLoggedIn: boolean;
  guestInputs?: Record<string, unknown> | null;
  muted?: boolean;
}

export function ChatEmbed({ isLoggedIn, guestInputs, muted }: ChatEmbedProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const { state, actions, refs } = useChatState({
    isLoggedIn, guestInputs,
    onRemoteConversationSelected: closeDrawer,
  });
  const { inputRef, messagesContainerRef } = refs;

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    <div className="chat-embed-root no-print" ref={rootRef}>
      <ColumnHeader step={3} title="Ask about your plan" meta={null} muted={muted} />
      <div className="chat-embed" role="region" aria-label="Health Roadmap Chat">

      {drawerOpen && (
        <div className="chat-embed-drawer-overlay" onClick={() => setDrawerOpen(false)} />
      )}

      <div className={`chat-embed-drawer ${drawerOpen ? 'chat-embed-drawer--open' : ''}`}>
        <div className="chat-embed-drawer-header">
          <span className="chat-embed-drawer-title">Conversations</span>
          <button className="chat-close-btn" onClick={() => setDrawerOpen(false)}>✕</button>
        </div>
        {threadList}
      </div>

      <div className="chat-embed-main">
        <div className="chat-embed-main-header">
          <button
            className="chat-embed-threads-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="Show conversations"
          >
            ☰ History
          </button>
          <ChatHeaderTitle subtitle={muted ? "Ask anything about preventative care" : "Answers cite your plan & the guidelines above"} />
        </div>

        <div
          className="chat-messages chat-embed-messages"
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
        >
          {state.messages.length === 0 && !state.isLoading && (
            <div className="chat-empty">
              <p>{muted ? "Plus when you fill in your details, the answers will be tailored to your numbers." : "Ask about your personalized suggestions based on your health data, clinical research, and Dr Brad's preventative care algorithm."}</p>
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
          <div className="chat-input-shell">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={state.inputText}
              onChange={e => actions.handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a follow-up…"
              disabled={state.isLoading}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={actions.handleSend}
              disabled={state.isLoading || !state.inputText.trim()}
              aria-label="Send"
            >↑</button>
          </div>
          <div className="chat-input-meta">
            <span className="chat-doctor-note">Always discuss with your doctor</span>
            <span className="chat-char-count">{state.inputText.length}/{MAX_CHARS}</span>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
