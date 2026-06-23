import React, { useMemo } from 'react';
import { type ChatMessage } from '../lib/chat-api';
import { renderMarkdown } from '../lib/markdown';
import { getAssistantName } from '../lib/assistant-config';

/** Memoized message bubble — avoids re-parsing markdown on every render */
export const ChatMessageBubble = React.memo(function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const html = useMemo(
    () => msg.role === 'assistant' ? renderMarkdown(msg.content) : null,
    [msg.content, msg.role],
  );
  return (
    <div className={`chat-message chat-message--${msg.role}`}>
      {msg.role === 'assistant' && <div className="chat-message-name">{getAssistantName()}</div>}
      {html ? (
        <div className="chat-message-content" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="chat-message-content">{msg.content}</div>
      )}
    </div>
  );
});
