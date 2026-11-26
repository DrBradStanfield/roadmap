import React, { useId } from 'react';
import type { ChatConversation } from '../lib/chat-api';
import { opensRow } from '../lib/opens-row';

interface ChatThreadListProps {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  className: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}

export function ChatThreadList({ conversations, activeConversationId, className, onSelect, onNew, onDelete }: ChatThreadListProps) {
  // A thread's title is the person's text: shown, and named from, never copied into an attribute (US-09 AC7l).
  const id = useId();
  return (
    <div className={className}>
      <span id={`${id}delete`} hidden>Delete conversation</span>
      <button className="chat-new-btn" onClick={onNew}>+ New Chat</button>
      {conversations.map((conv, i) => { const title = conv.title || 'Untitled'; return (
        <div
          key={conv.id}
          className={`chat-thread-item ${conv.id === activeConversationId ? 'active' : ''}`}
          onClick={() => onSelect(conv.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (opensRow(e)) { e.preventDefault(); onSelect(conv.id); } }}
        >
          <span id={`${id}${i}`} className="chat-thread-title">{title}</span>
          <button
            className="chat-thread-delete"
            onClick={(e) => onDelete(conv.id, e)}
            title="Delete conversation"
            aria-labelledby={`${id}delete ${id}${i}`}
          >✕</button>
        </div>
      ); })}
      {conversations.length === 0 && (
        <div className="chat-thread-empty">No conversations yet</div>
      )}
    </div>
  );
}
