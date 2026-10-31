import React from 'react';
import type { ChatConversation } from '../lib/chat-api';

interface ChatThreadListProps {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  className: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}

/** Enter or Space on the row itself opens it; a key on its Delete button is left to the button. */
function opensRow(e: React.KeyboardEvent): boolean {
  return e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ');
}

export function ChatThreadList({ conversations, activeConversationId, className, onSelect, onNew, onDelete }: ChatThreadListProps) {
  return (
    <div className={className}>
      <button className="chat-new-btn" onClick={onNew}>+ New Chat</button>
      {conversations.map(conv => { const title = conv.title || 'Untitled'; return (
        <div
          key={conv.id}
          className={`chat-thread-item ${conv.id === activeConversationId ? 'active' : ''}`}
          onClick={() => onSelect(conv.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (opensRow(e)) { e.preventDefault(); onSelect(conv.id); } }}
        >
          <span className="chat-thread-title">{title}</span>
          <button
            className="chat-thread-delete"
            onClick={(e) => onDelete(conv.id, e)}
            title="Delete conversation"
            aria-label={`Delete conversation ${title}`}
          >✕</button>
        </div>
      ); })}
      {conversations.length === 0 && (
        <div className="chat-thread-empty">No conversations yet</div>
      )}
    </div>
  );
}
