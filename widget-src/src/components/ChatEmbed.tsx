/**
 * ChatEmbed — always-expanded inline chat panel. Thread list lives in a
 * hamburger-triggered drawer at all breakpoints.
 *
 * Conversations load lazily via IntersectionObserver — fires only when the
 * panel scrolls into view, giving the health widget priority on page load.
 */
import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { getChatGate } from '../lib/chat-api';
import { observeVisibility } from '../lib/observe-visibility';
import { useChatState, type ChatContextSource, type ChatEditTarget } from '../hooks/useChatState';
import { useFollowLatest } from '../hooks/useFollowLatest';
import { ChatKeyGate } from './ChatKeyGate';
import { ChatMessageList, ChatComposer } from './ChatPanel';
import { ChatThreadList } from './ChatThreadList';
import { MUTED_CHAT } from './chat-muted';
import { ColumnHeader } from './ColumnHeader';
import { ChatHeaderTitle } from './ChatHeaderTitle';

interface ChatEmbedProps {
  isLoggedIn: boolean;
  guestInputs?: ChatContextSource;
  muted?: boolean;
  onProposeEdit?: ChatEditTarget;
  /** The chat's card: a phone's tab switch sizes it from its measured top (hooks/useTabs). */
  cardRef?: React.RefObject<HTMLDivElement>;
}

export function ChatEmbed({ isLoggedIn, guestInputs, muted, onProposeEdit, cardRef }: ChatEmbedProps) {
  // BYOK gate (standalone build only — null on the Shopify widget).
  const [, refreshGate] = useReducer((x: number) => x + 1, 0);
  const gate = getChatGate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const chat = useChatState({
    isLoggedIn, guestInputs,
    onRemoteConversationSelected: closeDrawer,
    onProposeEdit,
  });
  const { state, actions, refs: { messagesContainerRef } } = chat;

  const rootRef = useRef<HTMLDivElement>(null);

  // Lazy-load conversations: fire only when this panel enters the viewport
  // (loadConversationsIfNeeded is idempotent, so repeat enters are no-ops).
  // Since the embed is placed below the health widget, the widget's API calls
  // win network priority naturally.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return observeVisibility(root, visible => {
      if (visible) actions.loadConversationsIfNeeded();
    }, { threshold: 0.1 });
  }, [actions.loadConversationsIfNeeded]);

  // Follow a new message or any pending-reply change while the reader is at the latest one
  const follow = useFollowLatest(messagesContainerRef, state.activeConversationId, state.messages, [state.pending]);

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
      list={state.list}
      activeConversationId={state.activeConversationId}
      className="chat-embed-thread-list"
      onSelect={handleSelectConversation}
      onNew={handleStartNewChat}
      onDelete={actions.handleDelete}
    />
  );

  return (
    <div className="chat-embed-root no-print" data-clarity-mask="true" ref={rootRef}>
      <ColumnHeader title="Ask about your plan" muted={muted} />
      <div ref={cardRef} className="chat-embed" role="region" aria-label="Health by Dr Brad Chat">

      {drawerOpen && (
        <div className="chat-embed-drawer-overlay" onClick={() => setDrawerOpen(false)} />
      )}

      <div className={`chat-embed-drawer ${drawerOpen ? 'chat-embed-drawer--open' : ''}`}>
        <div className="chat-embed-drawer-header">
          <span className="chat-embed-drawer-title">Conversations</span>
          <button className="chat-close-btn" aria-label="Close conversations" onClick={() => setDrawerOpen(false)}>✕</button>
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
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            History
          </button>
          <ChatHeaderTitle subtitle={muted ? MUTED_CHAT.subtitle : "Answers cite your plan & the guidelines above"} />
        </div>

        {gate?.needsKey ? (
          <ChatKeyGate gate={gate} onConnected={refreshGate} />
        ) : (
        <>
        <ChatMessageList
          chat={chat}
          className="chat-messages chat-embed-messages"
          emptyText={muted ? MUTED_CHAT.empty : "Ask about your personalized suggestions based on your health data, clinical research, and the preventative care algorithm."}
          onNew={handleStartNewChat}
          follow={follow}
        />
        <ChatComposer chat={chat} className="chat-input-bar chat-embed-input-bar" gate={gate} onGateChange={refreshGate} />
        </>
        )}
      </div>
      </div>
    </div>
  );
}
