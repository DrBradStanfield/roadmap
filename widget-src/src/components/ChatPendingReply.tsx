import { ChatMessageBubble } from './ChatMessageBubble';

/**
 * The reply while it is being written (US-15 AC16/AC17). The sending instance
 * shows the model's thinking summary live, then the answer filling in; other
 * tabs, which get no deltas, show the pulsing dots.
 */
export function ChatPendingReply({ isLocalSender, thinking, text }: { isLocalSender: boolean; thinking: string; text: string }) {
  if (!isLocalSender) {
    return (
      <div className="chat-message chat-message--assistant">
        <div className="chat-loading"><span className="chat-thinking-dots" /></div>
      </div>
    );
  }
  // The live region is a short static line: a screen reader hears the phase,
  // not every word of the growing summary.
  return (
    <>
      <p className="chat-pending-status" aria-live="polite">{text ? 'Answering…' : 'Thinking…'}</p>
      {(thinking || !text) && (
        <div className="chat-message chat-message--assistant">
          <div className="chat-loading chat-thinking-panel">
            {/* "Draft notes" only once there are notes: a path that never streams shows "Thinking…". */}
            <span className="chat-thinking-label">{thinking ? 'Thinking (draft notes, not the answer)' : 'Thinking…'}</span>
            {thinking && <p className="chat-thinking-summary">{thinking}</p>}
          </div>
        </div>
      )}
      {text && <ChatMessageBubble msg={{ id: 'streaming', role: 'assistant', content: text, createdAt: '' }} />}
    </>
  );
}
