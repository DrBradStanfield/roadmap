import React, { useMemo, useRef } from 'react';
import { type ChatMessage } from '../lib/chat-api';
import { trackProductEvent } from '../lib/server-api';
import { renderMarkdown } from '../lib/markdown';
import { getAssistantName } from '../lib/assistant-config';

/** Memoized message bubble — avoids re-parsing markdown on every render */
/** `thinking`: the model's summary for this answer, this session only (US-15 AC17), folded above it. */
export const ChatMessageBubble = React.memo(function ChatMessageBubble({ msg, thinking }: { msg: ChatMessage; thinking?: string }) {
  const html = useMemo(
    () => msg.role === 'assistant' ? renderMarkdown(msg.content) : null,
    [msg.content, msg.role],
  );
  const openedRef = useRef(false);
  return (
    <div className={`chat-message chat-message--${msg.role}`}>
      {msg.role === 'assistant' && <div className="chat-message-name">{getAssistantName()}</div>}
      {thinking && (
        <details
          className="chat-thinking-toggle"
          onToggle={(e) => {
            // Usage signal (US-15 AC17): once per answer, however often it is reopened.
            if (!e.currentTarget.open || openedRef.current) return;
            openedRef.current = true;
            trackProductEvent('chat_thinking_opened');
          }}
        >
          <summary>Show how I approached this</summary>
          <p className="chat-thinking-summary">{thinking}</p>
        </details>
      )}
      {html ? (
        <div className="chat-message-content" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="chat-message-content">{msg.content}</div>
      )}
    </div>
  );
});
