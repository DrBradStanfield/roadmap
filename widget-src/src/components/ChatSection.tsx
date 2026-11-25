/**
 * ChatSection — floating chat widget.
 *
 * Collapsed: fixed bubble at bottom-right of viewport.
 * Expanded: fixed panel at bottom-right with thread list + messages.
 * Guest: greyed out bubble with login tooltip.
 *
 * All API calls are lazy — nothing fires until the user clicks the bubble.
 */
import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import { FeedbackForm } from './FeedbackForm';
import { trackProductEvent } from '../lib/server-api';
import { getChatGate } from '../lib/chat-api';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { ChatKeyGate } from './ChatKeyGate';
import { useChatState, type ChatContextSource, type ChatEditTarget } from '../hooks/useChatState';
import { useFollowLatest } from '../hooks/useFollowLatest';
import { ChatMessageList, ChatComposer } from './ChatPanel';
import { ChatThreadList } from './ChatThreadList';
import { ChatHeaderTitle } from './ChatHeaderTitle';
import { MUTED_CHAT } from './chat-muted';
import { getAssistantName, getChatSurface } from '../lib/assistant-config';

export type { ChatPrefetchData } from '../hooks/useChatState';
import type { ChatPrefetchData } from '../hooks/useChatState';

// US-15 AC12: the brand store has no plan, so its chat names products. The
// brand title reads the metafield-set assistant name at render, not import.
const SURFACE_COPY = {
  doctor: {
    label: 'Health by Dr Brad Chat',
    title: 'Discuss your health',
    subtitle: 'Answers cite your plan & the guidelines above',
    empty: 'Ask about your personalized suggestions based on your health data, clinical research, and the preventative care algorithm.',
    collapsed: 'Ask about your health suggestions',
  },
  brand: {
    get label() { return `${getAssistantName()} chat`; },
    get title() { return `Ask ${getAssistantName()}`; },
    subtitle: 'Products, ingredients, and the research behind them',
    empty: "Ask what's in a product, how to take it, or what the evidence says about an ingredient. For orders and subscriptions, sign in to your account.",
    collapsed: 'Ask about our products',
  },
};

interface ChatSectionProps {
  isLoggedIn: boolean;
  startExpanded?: boolean;
  inline?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
  guestInputs?: ChatContextSource;
  prefetchedData?: ChatPrefetchData | null;
  onProposeEdit?: ChatEditTarget;
  /** Before the onboarding is done: the general wording, as ChatEmbed's. */
  muted?: boolean;
}

function hasChatDraft(message: string, keyField: HTMLInputElement | null) {
  return message !== '' || !!keyField?.value;
}

function dismissesChat(e: React.KeyboardEvent, hasDraft: () => boolean) {
  return e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229 && !hasDraft();
}

/**
 * US-15 AC12a: the pop-up chat as a dialog. Its title takes the focus on opening, not the message
 * box, so that opening does not call up a phone's keyboard. Escape inside it closes it unless there
 * is unsent message text, an unsaved key, or an IME composition (both forms of AC26a). Closing gives
 * focus to the "Open chat" button that comes back: both surfaces class it `chat-fab`, found on the next frame.
 * A panel drawn with no such button on the page was brought back by the page, not opened by a press
 * (the tool page, after a width change): it takes no focus, so a draft typed in a grid is not saved (US-03 AC5).
 */
function useChatDialog(isExpanded: boolean, inline: boolean | undefined, hide: () => void, hasDraft: () => boolean) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [replacesButton] = useState(() => !!document.querySelector('.chat-fab'));
  const popup = isExpanded && !inline;
  useEffect(() => { if (popup && replacesButton) titleRef.current?.focus(); }, [popup, replacesButton]);
  const close = () => {
    hide();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.chat-fab')?.focus());
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (popup && dismissesChat(e, hasDraft)) close();
  };
  return { titleRef, close, onKeyDown };
}

export function ChatSection({ isLoggedIn, startExpanded, inline, onClose, onExpand, guestInputs, prefetchedData, onProposeEdit, muted }: ChatSectionProps) {
  const [isExpanded, setIsExpanded] = useState(startExpanded ?? false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  // BYOK gate (standalone build only — null on the Shopify widget).
  const [, refreshGate] = useReducer((x: number) => x + 1, 0);
  const gate = getChatGate();
  const copy = SURFACE_COPY[getChatSurface()];

  const closeThreadsPanel = useCallback(() => setShowThreads(false), []);
  const chat = useChatState({
    isLoggedIn, guestInputs, prefetchedData,
    onRemoteConversationSelected: closeThreadsPanel,
    onProposeEdit,
  });
  const { state, actions, refs: { messagesContainerRef } } = chat;
  const keyInputRef = useRef<HTMLInputElement>(null);
  const dialog = useChatDialog(isExpanded, inline, () => { setIsExpanded(false); onClose?.(); },
    // The message can outlive its textbox (History); the key lives in the mounted gate.
    () => hasChatDraft(state.inputText, keyInputRef.current));

  // Load on mount when startExpanded (mirrors original lazy-load behavior).
  // chat_opened must fire on EVERY entry path — both live FABs mount
  // startExpanded, so handleExpand alone never runs there (US-15 AC2).
  useEffect(() => {
    if (startExpanded) {
      trackProductEvent('chat_opened');
      actions.loadConversationsIfNeeded();
    }
  }, [startExpanded, actions.loadConversationsIfNeeded]);

  // Follow a new message or any pending-reply change while the reader is at the latest one
  const follow = useFollowLatest(messagesContainerRef, state.activeConversationId, state.messages, [state.pending]);

  const handleExpand = useCallback(() => {
    trackProductEvent('chat_opened');
    if (onExpand) { onExpand(); return; }
    setIsExpanded(true);
    setShowFeedback(false);
    actions.loadConversationsIfNeeded();
  }, [onExpand, actions.loadConversationsIfNeeded]);

  const handleSelectConversation = useCallback((id: string) => {
    actions.selectConversation(id);
    setShowThreads(false);
  }, [actions.selectConversation]);

  // A new chat shows the empty chat and its input, as opening a thread does (US-15 AC46a).
  const handleStartNewChat = useCallback(() => {
    actions.startNewChat();
    setShowThreads(false);
  }, [actions.startNewChat]);

  // ----- COLLAPSED STATE -----
  if (!isExpanded) {
    return (
      <div className="chat-section no-print" data-clarity-mask="true">
        <div className="chat-collapsed-row">
          <div className="chat-collapsed" onClick={handleExpand} role="button" tabIndex={0}>
            <span className="chat-icon">💬</span>
            <span className="chat-placeholder">{copy.collapsed}</span>
          </div>
          {/* Feedback posts to Brad's server; the Pages build has none. */}
          {!isLoggedIn && SHOPIFY_SURFACE && (
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
    <div className={`chat-section chat-expanded${inline ? ' chat-expanded--inline' : ''} no-print`} role="dialog" aria-label={copy.label} data-clarity-mask="true" onKeyDown={dialog.onKeyDown}>
      <div className="chat-header">
        <button className="chat-threads-btn" onClick={() => setShowThreads(!showThreads)}>
          {showThreads ? 'Back' : 'History'}
        </button>
        <ChatHeaderTitle title={copy.title} subtitle={muted ? MUTED_CHAT.subtitle : copy.subtitle} titleRef={dialog.titleRef} />
        {!inline && (
          <button className="chat-close-btn" aria-label="Close chat" onClick={dialog.close}>✕</button>
        )}
      </div>

      <div className="chat-body">
        {showThreads && (
          <ChatThreadList
            conversations={state.conversations}
            activeConversationId={state.activeConversationId}
            className="chat-thread-list"
            onSelect={handleSelectConversation}
            onNew={handleStartNewChat}
            onDelete={actions.handleDelete}
          />
        )}

        {!showThreads && gate?.needsKey && (
          <ChatKeyGate gate={gate} onConnected={refreshGate} inputRef={keyInputRef} />
        )}
        {!showThreads && !gate?.needsKey && (
          <ChatMessageList chat={chat} className="chat-messages" emptyText={muted ? MUTED_CHAT.empty : copy.empty} onNew={handleStartNewChat} follow={follow} />
        )}
      </div>

      {!showThreads && !gate?.needsKey && (
        <ChatComposer chat={chat} className="chat-input-bar" gate={gate} onGateChange={refreshGate} />
      )}
    </div>
  );
}
