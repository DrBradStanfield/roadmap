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

export function ChatThreadList({ conversations, activeConversationId, className, onSelect, onNew, onDelete }: ChatThreadListProps) {
  return (
    <div className={className}>
      <button className="chat-new-btn" onClick={onNew}>+ New Chat</button>
      {conversations.map(conv => (
        <div
          key={conv.id}
          className={`chat-thread-item ${conv.id === activeConversationId ? 'active' : ''}`}
          onClick={() => onSelect(conv.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(conv.id); } }}
        >
          <span className="chat-thread-title">{conv.title || 'Untitled'}</span>
          <button
            className="chat-thread-delete"
            onClick={(e) => onDelete(conv.id, e)}
            title="Delete conversation"
          >✕</button>
        </div>
      ))}
      {conversations.length === 0 && (
        <div className="chat-thread-empty">No conversations yet</div>
      )}
    </div>
  );
}
