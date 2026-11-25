/**
 * The chat's message list and composer, drawn the same by both web surfaces: the
 * inline panel (ChatEmbed) and the pop-up chat (ChatSection). Each surface keeps
 * its own frame (header, History, dialog or region) and passes what differs.
 */
import React, { useCallback } from 'react';
import { MAX_CHARS, sendsOnEnter, type useChatState } from '../hooks/useChatState';
import type { ChatGate } from '../lib/chat-api';
import { ChatMessageBubble } from './ChatMessageBubble';
import { SubscriptionChangeCard } from './SubscriptionChangeCard';
import { ChatPendingReply } from './ChatPendingReply';
import { ChatLoadLine } from './ChatLoadLine';

type Chat = ReturnType<typeof useChatState>;

/** `follow`: the surface's useFollowLatest, kept in the surface so the reading outlives a History round trip. */
export function ChatMessageList({ chat: { state, actions, refs }, className, emptyText, onNew, follow }: {
  chat: Chat; className: string; emptyText: string; onNew: () => void;
  follow: { showScrollBtn: boolean; onScroll: () => void };
}) {
  const { messagesContainerRef } = refs;
  return (
    <div className={className} ref={messagesContainerRef} onScroll={follow.onScroll}>
      {state.messages.length === 0 && !state.replying && state.load === 'none' && !state.wait && (
        <div className="chat-empty">
          <p>{emptyText}</p>
        </div>
      )}
      {state.messages.map(msg => (
        <React.Fragment key={msg.id}>
          <ChatMessageBubble msg={msg} approach={state.approachById[msg.id]} />
          {state.cardsById?.[msg.id] && (
            <SubscriptionChangeCard
              entry={state.cardsById[msg.id]}
              onConfirm={() => actions.confirmSubscription(msg.id)}
              onDismiss={() => actions.dismissSubscription(msg.id)}
            />
          )}
        </React.Fragment>
      ))}
      <ChatLoadLine load={state.load} wait={state.wait} onRetry={actions.retryLoad} onNew={onNew} />
      {state.replying && (
        <ChatPendingReply isLocalSender={state.isLocalSender} pending={state.pending} />
      )}
      {state.error && <div className="chat-error" role="alert">{state.error}</div>}
      {follow.showScrollBtn && (
        <button
          className="chat-scroll-btn"
          onClick={() => { const el = messagesContainerRef.current; if (el) el.scrollTop = el.scrollHeight; }}
        >↓</button>
      )}
    </div>
  );
}

/** `gate`: the BYOK gate (Pages build only, null on Shopify); `onGateChange` re-renders the surface past it. */
export function ChatComposer({ chat: { state, actions, refs }, className, gate, onGateChange }: {
  chat: Chat; className: string; gate: ChatGate | null; onGateChange: () => void;
}) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (sendsOnEnter(e)) {
      e.preventDefault();
      actions.handleSend();
    }
  }, [actions.handleSend]);
  return (
    <div className={className}>
      {state.isOffline && <div className="chat-offline">You're offline</div>}
      <div className="chat-input-shell">
        <textarea
          ref={refs.inputRef}
          className="chat-input"
          value={state.inputText}
          onChange={e => actions.handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={state.messages.length === 0 ? 'Ask a question' : 'Ask a follow-up…'}
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
        {gate && (
          <button
            type="button"
            className="chat-key-disconnect"
            onClick={() => { gate.clearKey(); onGateChange(); }}
          >
            Disconnect AI key
          </button>
        )}
        <span className="chat-char-count">{state.inputText.length}/{MAX_CHARS}</span>
      </div>
    </div>
  );
}
